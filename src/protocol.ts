/**
 * What the armada SDK and the Worker agree on: an environment recipe and its key, a job (a command or a function
 * mapped over items), each task's outcome, a job's status and its event stream. Plain TypeScript with valibot, so the
 * Bun SDK and the Worker compile the same file.
 */
import * as v from 'valibot';

export const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

/** The wire's version, which every request names in its PROTOCOL_HEADER: bump it when a request or an answer changes
 *  shape, so a client and a Worker that do not match say so instead of failing to parse each other. */
export const PROTOCOL = 3;

export const PROTOCOL_HEADER = 'armada-protocol';

/** The driver's version: bump when what the Worker installs or runs in a container changes. It is in every
 *  environment key, so a fix to the runner's own layer rebuilds every environment that predates it. */
export const DRIVER = 1;

/** The container sizes, smallest first, each a Cloudflare instance type. Cloudflare's largest is 4 vCPU and 12 GiB. A
 *  container's start refuses its `basic` type, and `lite`, at 1/16 vCPU, is too small to prepare an environment on. */
export const SIZES = {
  micro: { instance: 'standard-1', vcpus: 0.5, memoryGiB: 4 },
  mini: { instance: 'standard-2', vcpus: 1, memoryGiB: 6 },
  small: { instance: 'standard-3', vcpus: 2, memoryGiB: 8 },
  medium: { instance: 'standard-4', vcpus: 4, memoryGiB: 12 },
} as const;

export type Size = keyof typeof SIZES;

export const SizeSchema = v.picklist(Object.keys(SIZES) as Size[], 'a size is micro, mini, small or medium');

/** A project's slug, which scopes its environments, packs, timings and verdicts. */
export const Project = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,39}$/u));

/** The commit's paths that key a repository environment, by git object id. */
const ManifestSchema = v.array(v.object({ path: v.string(), id: Sha }));

export type Manifest = v.InferOutput<typeof ManifestSchema>;

/**
 * A base the runtime starts by name: a Cloudflare-managed image, `cloudflare/debian-trixie`, optionally pinned. The
 * `durable_object` policy refuses any other reference unless the Worker's own configuration names it as an image:
 * Docker Hub's `ubuntu:26.04` answers "must be digest-pinned", pinned "must include a registry and repository", and a
 * digest pushed to the account's registry "Image not found". Each refusal surfaced only after a
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
  size: v.optional(SizeSchema, 'medium'),
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

/** The packer this client is. A pack is stored under the packer that made it, so one an earlier client made (whose
 *  `commit` checkout packs could lack objects) is never served for this client's, and an earlier client's packs keep
 *  their own key. */
export const PACKER = 2;

/** A pack's packer: absent for a pack an earlier client made. */
export const Packer = v.optional(v.pipe(v.number(), v.integer(), v.minValue(2)));

/** Where a task's container keeps what armada gives it: the job's files, the pushed tasks' bundle, the file a task
 *  writes its output to, and the file the runner says there which kind of answer that is. */
export const FILES_DIR = '/armada/files';

export const BUNDLE_PATH = '/armada/bundle.mjs';

export const OUT_PATH = '/armada/task/out';

export const ANSWER_PATH = '/armada/task/answer';

export const Digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/** A task's id: unique in a deployment, so a client names a task by it alone. */
export const TaskId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._/-]{0,99}$/u, 'a task id is lowercase letters, digits and . _ / -, at most 100'));

/** Each task runs its own argv, or a pushed task: `node` runs the bundle, which runs the task named `id` on the item. A
 *  client that just pushed names the bundle; otherwise the Worker takes the id's current one. */
const RunSchema = v.union([v.object({ kind: v.literal('command') }), v.object({ kind: v.literal('task'), id: TaskId, bundle: v.optional(Digest) })]);

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** Any value a request's JSON parsed to, which is JSON by construction. */
export const JsonSchema = v.custom<Json>(() => true);

/** `text` as JSON, or null when it is not JSON: a task's output file, which the task may have left half written. */
export function jsonOf(text: string): Json {
  try {
    return v.parse(JsonSchema, JSON.parse(text));
  } catch {
    return null;
  }
}

/** One task: its item, which `ARMADA_ITEM` carries as JSON and whose numeric `weight` queues it, and a command's argv. */
export const TaskSchema = v.object({ item: JsonSchema, argv: v.optional(v.pipe(v.array(v.string()), v.minLength(1))) });

export type Task = v.InferOutput<typeof TaskSchema>;

export const MAX_TASKS = 100_000;

/** Why a job refuses these tasks: a command's task carries its argv, and a pushed task's carries none. */
export function refusal(run: { readonly kind: 'command' | 'task' }, tasks: readonly Task[]): string | null {
  const odd = tasks.findIndex((task) => (task.argv === undefined) === (run.kind === 'command'));

  return odd < 0 ? null : `item ${String(odd)} ${run.kind === 'command' ? 'has no argv for its command' : 'has an argv, which a pushed task takes none of'}`;
}

/** What `armada push` records: a project's bundle, and the ids of the tasks in it. */
export const PushSchema = v.object({ project: Project, bundle: Digest, ids: v.pipe(v.array(TaskId), v.minLength(1)) });

export type Push = v.InferOutput<typeof PushSchema>;

/** A task's output up to this size rides in its event; a larger one is read from R2. */
export const INLINE_BYTES = 32 * 1024;

export const JobSpecSchema = v.object({
  recipe: RecipeSchema,
  /** For a repository recipe: the commit each container checks out, packed against `base`. */
  commit: v.optional(v.object({ sha: Sha, base: PackBase, packer: Packer })),
  items: v.pipe(v.array(TaskSchema), v.maxLength(MAX_TASKS)),
  /** An open job takes more items until it is closed. */
  open: v.optional(v.boolean(), false),
  run: RunSchema,
  /** Whether a task's output file is kept (a function's result always is). */
  output: v.optional(v.boolean(), false),
  /** Small files every container gets under `{files}`, by name. */
  files: v.optional(v.record(v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+$/u)), v.string()), {}),
  env: v.optional(v.record(v.string(), v.string()), {}),
  tmpfs: v.optional(v.array(v.pipe(v.string(), v.startsWith('/'))), ['/tmp', '/dev/shm']),
  /** The most containers this job runs at once; the account's ceiling and the item count bound it too. */
  pool: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(375)), 50),
  /** A straggling task may be run again by an idle container, first answer kept. Only for tasks safe to repeat. */
  speculative: v.optional(v.boolean(), false),
  /** A task's own bound, in seconds. */
  timeout: v.optional(v.pipe(v.number(), v.minValue(1)), 3600),
  label: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
});

export type JobSpec = v.InferOutput<typeof JobSpecSchema>;

/** What a container reports for one task, and what the job streams. */
export const OutcomeSchema = v.object({
  index: v.number(),
  /** `exited` with its code, or `failed` when it never finished. */
  kind: v.picklist(['exited', 'failed']),
  /** Why: past its timeout (exited 124), cancelled, or lost by the platform twice. */
  reason: v.optional(v.picklist(['timeout', 'cancelled', 'lost'])),
  exitCode: v.number(),
  seconds: v.number(),
  vessel: v.string(),
  attempt: v.number(),
  /** The last lines the task printed. */
  tail: v.string(),
  /** Whether the task's output is stored, at `/jobs/<id>/tasks/<index>/output`, and the output itself when it is text
   *  of at most INLINE_BYTES. */
  output: v.boolean(),
  value: v.optional(v.string()),
  /** A pushed task's answer, as its runner says: `value` is an envelope with the body's value or error, `command` the
   *  file the body's command wrote. */
  answer: v.optional(v.picklist(['value', 'command'])),
  /** The task's cgroup at its end: the most memory it held, file cache included, in bytes, and the CPU it used. */
  peakMemory: v.optional(v.number()),
  cpuSeconds: v.optional(v.number()),
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

/** A deployment's state: its runner layer, its wire, the vCPUs its fleet holds, and the jobs not yet done, those
 *  waiting for an environment or for a container included. */
export const HealthSchema = v.object({ ok: v.boolean(), driver: v.number(), protocol: v.number(), vcpus: v.number(), jobs: v.number() });

export type Health = v.InferOutput<typeof HealthSchema>;

const UsageSchema = v.object({ memory: v.number(), cores: v.number() });

/** The timings a project's graded run reports back, and the medians a plan reads: `{rows, files}`. `usage` is the
 *  most one task used in the run reported, or in the last runs read. */
export const TimingsSchema = v.object({
  rows: v.record(v.string(), v.number()), files: v.record(v.string(), v.number()), usage: v.optional(v.nullable(UsageSchema)),
});

export type Timings = v.InferOutput<typeof TimingsSchema>;

/** One environment per driver and recipe: base, scripts, size and, for a repository, its key files. */
export async function environmentKey(recipe: Recipe): Promise<string> {
  const repo = recipe.repo === undefined ? null : {
    ...recipe.repo,
    manifest: [...recipe.repo.manifest].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => `${entry.path} ${entry.id}`),
  };
  // The size keys by its instance type, as the instance type did before sizes were named.
  const inputs = [DRIVER, recipe.base, recipe.setup, recipe.install, SIZES[recipe.size].instance, repo];
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

/** The end of what a failed command printed, its stderr last and whole up to `limit`: the error a command dies with is
 *  on stderr, after whatever its stdout said, so stdout never pushes it out. */
export function failureTail(stdout: string, stderr: string, limit = 3000): string {
  const error = stderr.slice(-limit);

  return stdout.slice(Math.max(0, stdout.length - (limit - error.length))) + error;
}

/** What a job's tasks used at most: the highest peak memory, in bytes, and the most cores one task kept busy on average. */
export type Usage = v.InferOutput<typeof UsageSchema>;

/** The most any of these tasks used, or null when none was measured. */
export function usageOf(outcomes: readonly { readonly seconds: number; readonly peakMemory?: number; readonly cpuSeconds?: number }[]): Usage | null {
  const measured = outcomes.filter((outcome) => outcome.peakMemory !== undefined && outcome.cpuSeconds !== undefined && outcome.seconds > 0);

  if (measured.length === 0) return null;

  return {
    memory: Math.max(...measured.map((outcome) => outcome.peakMemory ?? 0)),
    cores: Math.max(...measured.map((outcome) => (outcome.cpuSeconds ?? 0) / outcome.seconds)),
  };
}

/** The smallest size whose memory and vCPUs this usage fills to three quarters at most. Measured on a smaller size, a
 *  task held to its vCPUs fills them, so the next run goes a size up. */
export function fitSize(usage: Usage): Size {
  return (Object.keys(SIZES) as Size[]).find((size) => usage.memory <= SIZES[size].memoryGiB * 2 ** 30 * 0.75 && usage.cores <= SIZES[size].vcpus * 0.75) ?? 'medium';
}

export const describeUsage = (usage: Usage): string => `${(usage.memory / 2 ** 30).toFixed(2)} GiB and ${usage.cores.toFixed(2)} cores`;

/** The samples an estimate keeps per row or file. */
const SAMPLES = 5;

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
