/**
 * What the armada SDK and the Worker agree on: an environment recipe and its key, a job (a command or a handler
 * mapped over items), each task's outcome, a job's status and its event stream. Plain TypeScript with valibot, so the
 * Bun SDK and the Worker compile the same file.
 */
import * as v from 'valibot';

export const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

/** The driver's version: bump when what the Worker installs or runs in a container changes. It is in every
 *  environment key, so a fix to the runner's own layer rebuilds every environment that predates it. */
export const DRIVER = 1;

export const INSTANCES = ['lite', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;

/** vCPUs per instance, for the account's concurrent-vCPU ceiling. */
export const VCPUS: Readonly<Record<(typeof INSTANCES)[number], number>> = { lite: 0.0625, 'standard-1': 0.5, 'standard-2': 1, 'standard-3': 2, 'standard-4': 4 };

const Project = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,39}$/u));

/** The commit's paths that key a repository environment, by git object id. */
export const ManifestSchema = v.array(v.object({ path: v.string(), id: Sha }));

export type Manifest = v.InferOutput<typeof ManifestSchema>;

/**
 * A base the runtime starts by name: a Cloudflare-managed image, `cloudflare/debian-trixie`, optionally pinned. The
 * `durable_object` policy refuses any other reference unless the Worker's own configuration names it as an image:
 * Docker Hub's `ubuntu:26.04` answers "must be digest-pinned", pinned "must include a registry and repository", and a
 * digest pushed to the account's registry "Image not found" (2026-10-07). Each refusal surfaced only after a
 * preparation's five-minute start bound, so a recipe naming one is refused here, before anything starts.
 */
export const BaseSchema = v.pipe(
  v.string(),
  v.regex(/^cloudflare\/[a-z0-9][a-z0-9._-]*(@sha256:[0-9a-f]{64})?$/u, 'a base is a Cloudflare-managed image, such as cloudflare/debian-trixie; the runtime starts no other by name'),
);

export const DEFAULT_BASE = 'cloudflare/debian-trixie';

/**
 * What every container of a job starts from: a base image started by name, the runner's layer, then the recipe's
 * own `setup` (as root) and `install` (as the user, in the work directory, after any checkout), snapshotted once.
 * The scripts are carried as text, so the key hashes the recipe itself, never a path to it.
 */
export const RecipeSchema = v.object({
  base: v.optional(BaseSchema, DEFAULT_BASE),
  setup: v.optional(v.string(), ''),
  install: v.optional(v.string(), ''),
  /** Run as the user after the snapshot is restored once; it must exit 0. */
  smoke: v.optional(v.string(), ''),
  instance: v.optional(v.picklist(INSTANCES), 'standard-4'),
  /** A repository environment: the commit is checked out where `checkout` says, and these files key it. */
  repo: v.optional(v.object({
    project: Project,
    checkout: v.pipe(v.string(), v.startsWith('/')),
    /** `full` carries the commit's whole history; `commit` only its tree. */
    history: v.picklist(['full', 'commit']),
    manifest: ManifestSchema,
  })),
});

export type Recipe = v.InferOutput<typeof RecipeSchema>;

/** What a job's pack holds: `root`, the commit with its history, or what it adds to the environment's commit. */
export const PackBase = v.union([v.literal('root'), Sha]);

/** A command, its words filled per item (`{item}`, an object item's scalar keys, `{out}`, `{files}`, `{index}`), or a
 *  JavaScript function's source, called with the item under `node`; its return value is the task's output. */
export const RunSchema = v.union([
  v.object({ command: v.pipe(v.array(v.string()), v.minLength(1)) }),
  v.object({ handler: v.pipe(v.string(), v.minLength(1)) }),
]);

export const JobSpecSchema = v.object({
  recipe: RecipeSchema,
  /** For a repository recipe: the commit each container checks out, packed against `base`. */
  commit: v.optional(v.object({ sha: Sha, base: PackBase })),
  items: v.pipe(v.array(v.unknown()), v.minLength(1), v.maxLength(100_000)),
  run: RunSchema,
  /** Whether a task writes `{out}`, kept as its output (a handler's return value always is). */
  output: v.optional(v.boolean(), false),
  /** Small files every container gets under `{files}`, by name. */
  files: v.optional(v.record(v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+$/u)), v.string()), {}),
  env: v.optional(v.record(v.string(), v.string()), {}),
  tmpfs: v.optional(v.array(v.pipe(v.string(), v.startsWith('/'))), ['/tmp', '/dev/shm']),
  /** The most containers this job runs at once; the account's ceiling and the item count bound it too. */
  pool: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(375)), 50),
  /** A straggling task may be run again by an idle container, first answer kept. Only for tasks safe to repeat. */
  idempotent: v.optional(v.boolean(), false),
  /** A task's own bound, in seconds. */
  timeout: v.optional(v.pipe(v.number(), v.minValue(1)), 3600),
  label: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
});

export type JobSpec = v.InferOutput<typeof JobSpecSchema>;

/** What a container reports for one task, and what the job streams. */
export const OutcomeSchema = v.object({
  index: v.number(),
  /** `exited` with its code, or `failed` when the infrastructure could not run it twice. */
  kind: v.picklist(['exited', 'failed']),
  exitCode: v.number(),
  seconds: v.number(),
  vessel: v.string(),
  attempt: v.number(),
  /** The last lines the task printed. */
  tail: v.string(),
  /** Whether `{out}` (or a handler's value) is stored, at `/jobs/<id>/tasks/<index>/output`. */
  output: v.boolean(),
});

export type Outcome = v.InferOutput<typeof OutcomeSchema>;

export const EventsSchema = v.object({ events: v.array(v.object({ seq: v.number(), outcome: OutcomeSchema })), done: v.boolean() });

const VesselSchema = v.object({
  name: v.string(),
  state: v.picklist(['waiting', 'booting', 'working', 'done', 'failed']),
  tasks: v.number(),
  /** From asking for a container to its first answer. */
  bootMs: v.nullable(v.number()),
  busyMs: v.number(),
  error: v.nullable(v.string()),
});

export type VesselRow = v.InferOutput<typeof VesselSchema>;

export const JobStatusSchema = v.object({
  id: v.string(),
  label: v.string(),
  phase: v.picklist(['preparing', 'running', 'done']),
  key: v.string(),
  createdAt: v.number(),
  startedAt: v.nullable(v.number()),
  finishedAt: v.nullable(v.number()),
  tasks: v.object({ total: v.number(), queued: v.number(), running: v.number(), exited: v.number(), red: v.number(), failed: v.number() }),
  vessels: v.array(VesselSchema),
  problems: v.array(v.string()),
  environment: v.nullable(v.object({ key: v.string(), sha: v.nullable(v.string()), created: v.number(), seconds: v.record(v.string(), v.number()) })),
});

export type JobStatus = v.InferOutput<typeof JobStatusSchema>;

/** The timings a project's graded run reports back, and the medians a plan reads: `{rows, files}`. */
export const TimingsSchema = v.object({ rows: v.record(v.string(), v.number()), files: v.record(v.string(), v.number()) });

export type Timings = v.InferOutput<typeof TimingsSchema>;

/** One environment per driver and recipe: base, scripts, instance and, for a repository, its key files. */
export async function environmentKey(recipe: Recipe): Promise<string> {
  const repo = recipe.repo === undefined ? null : {
    ...recipe.repo,
    manifest: [...recipe.repo.manifest].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => `${entry.path} ${entry.id}`),
  };
  const inputs = [DRIVER, recipe.base, recipe.setup, recipe.install, recipe.smoke, recipe.instance, repo];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(inputs)));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Where a job's commands run: the checkout, or the user's work directory. */
export function workdirOf(recipe: Recipe): string {
  return recipe.repo?.checkout ?? '/home/ci/work';
}

/** `{name}` in `template` from `values`; an unknown placeholder is an error, never an empty string. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/gu, (whole, name: string) => {
    const value = values[name];

    if (value === undefined) throw new Error(`${whole} in ${JSON.stringify(template)} names nothing the task has`);

    return value;
  });
}

/** The values an item gives a command: `{item}` (its text, or its JSON), and an object item's scalar keys. */
export function itemValues(item: unknown, index: number): Record<string, string> {
  const values: Record<string, string> = { index: String(index), item: typeof item === 'string' ? item : JSON.stringify(item) };

  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = String(value);
    }
  }

  return values;
}

/** An item's weight for longest-first dispatch: an object's numeric `weight`, else 0. */
export function weightOf(item: unknown): number {
  if (typeof item !== 'object' || item === null || !('weight' in item)) return 0;
  const { weight } = item;

  return typeof weight === 'number' && Number.isFinite(weight) ? weight : 0;
}

/** The samples an estimate keeps per row or file. */
export const SAMPLES = 5;

/** Each key's last `SAMPLES` measurements, the newest last. */
export function recordSamples(history: Readonly<Record<string, readonly number[]>>, sample: Readonly<Record<string, number>>): Record<string, number[]> {
  const next: Record<string, number[]> = Object.fromEntries(Object.entries(history).map(([key, values]) => [key, [...values]]));

  for (const [key, seconds] of Object.entries(sample)) next[key] = [...next[key] ?? [], seconds].slice(-SAMPLES);

  return next;
}

/** Each key's median: one slow run moves no estimate. */
export function medians(history: Readonly<Record<string, readonly number[]>>): Record<string, number> {
  return Object.fromEntries(Object.entries(history).map(([key, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return [key, sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2];
  }));
}
