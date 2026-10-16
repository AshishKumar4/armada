/**
 * What the armada SDK and the Worker agree on: an environment recipe and its key, a job (a command or a function
 * mapped over items), each task's outcome, a job's status and its event stream. Plain TypeScript with valibot, so the
 * Bun SDK and the Worker compile the same file.
 */
import * as v from 'valibot';

export const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

/** The wire's version, which every request names in its PROTOCOL_HEADER: bump it when a request or an answer changes
 *  shape, so a client and a Worker that do not match say so instead of failing to parse each other. */
export const PROTOCOL = 11;

/** The oldest client version a Worker still serves. A version that only adds to the wire keeps it, so a project's
 *  pinned client keeps working across a deploy; one that changes what an older client sends or reads raises it. */
export const OLDEST_CLIENT = 3;

export const PROTOCOL_HEADER = 'armada-protocol';

/** The host of the deployment `armada dashboard --serve` passes a page's requests to, on each answer it passes back. */
export const DEPLOYMENT_HEADER = 'armada-deployment';

/** The driver's version: bump when what the Worker installs or runs in a container changes. It is in every
 *  environment key, so a fix to the runner's own layer rebuilds every environment that predates it. */
export const DRIVER = 2;

/** The container sizes, smallest first, each a Cloudflare instance type. Cloudflare's largest is 4 vCPU and 12 GiB. A
 *  container's start refuses its `basic` type, and `lite`, at 1/16 vCPU, is too small to prepare an environment on. */
export const SIZE_NAMES = ['micro', 'mini', 'small', 'medium'] as const;

export type Size = (typeof SIZE_NAMES)[number];

export const SIZES = {
  micro: { instance: 'standard-1', vcpus: 0.5, memoryGiB: 4, diskGB: 8 },
  mini: { instance: 'standard-2', vcpus: 1, memoryGiB: 6, diskGB: 12 },
  small: { instance: 'standard-3', vcpus: 2, memoryGiB: 8, diskGB: 16 },
  medium: { instance: 'standard-4', vcpus: 4, memoryGiB: 12, diskGB: 20 },
} as const satisfies Record<Size, { readonly instance: string; readonly vcpus: number; readonly memoryGiB: number; readonly diskGB: number }>;

export const SizeSchema = v.picklist(SIZE_NAMES, 'a size is micro, mini, small or medium');

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

/** The packer this client is. A pack is stored under the packer that made it, so one an earlier client made is never
 *  served for this client's, and an earlier client's packs keep their own key: packer 2's `commit` checkout packs could
 *  lack objects, and only packer 3 sends a pack's shallow boundary (#34). It keys the environments a client's packs
 *  prepare (`RecipeSchema`). */
export const PACKER = 3;

/** A pack's packer: absent for a pack an earlier client made. */
export const Packer = v.optional(v.pipe(v.number(), v.integer(), v.minValue(2)));

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
    /** The packer of the packs that prepare the environment and build on it, absent for an earlier client's. It is in
     *  the key, so a pack that sends its boundary never builds on an environment whose own boundary is not known (#34). */
    packer: Packer,
  })),
});

export type Recipe = v.InferOutput<typeof RecipeSchema>;

/** What a job's pack holds: `root`, the commit with its history, or what it adds to the environment's commit. */
export const PackBase = v.union([v.literal('root'), Sha]);

/** Where a task's container keeps what armada gives it: the job's files, the pushed tasks' bundle, the file a task
 *  writes its output to, and the file the runner says there which kind of answer that is. */
export const FILES_DIR = '/armada/files';

export const BUNDLE_PATH = '/armada/bundle.mjs';

/** The bundle a Python task's container runs, for `python3 <path>`: a zipapp. */
export const PY_BUNDLE_PATH = '/armada/bundle.pyz';

export const OUT_PATH = '/armada/task/out';

export const ANSWER_PATH = '/armada/task/answer';

/** The directory whose contents a task keeps as its artifacts: a tar.gz in R2 once it finishes. */
export const ARTIFACTS_PATH = '/armada/task/artifacts';

export const Digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/** A task's id: unique in a deployment, so a client names a task by it alone. */
export const TaskId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9._/-]{0,99}$/u, 'a task id is lowercase letters, digits and . _ / -, at most 100'));

/** What runs a pushed task's bundle: `node` for a `.mjs`, `python3` for a `.pyz`. An absent one is node, as it always
 *  was. */
export const RuntimeSchema = v.optional(v.picklist(['node', 'python']), 'node');

export type Runtime = v.InferOutput<typeof RuntimeSchema>;

/** Each task runs its own argv, or a pushed task: its bundle runs under the runtime it was pushed for, which runs the
 *  task named `id` on the item. A client that just pushed names the bundle and runtime; otherwise the Worker takes the
 *  id's current ones. */
const RunSchema = v.union([v.object({ kind: v.literal('command') }), v.object({ kind: v.literal('task'), id: TaskId, bundle: v.optional(Digest), runtime: RuntimeSchema })]);

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** What a request sends as JSON: JSON whose objects may hold an undefined property, which the JSON leaves out. */
export type JsonBody = string | number | boolean | null | undefined | readonly JsonBody[] | { readonly [key: string]: JsonBody };

/** Any value a request's JSON parsed to, which is JSON by construction. */
export const JsonSchema = v.custom<Json>(() => true);

/** A value a body returned, checked to be JSON all the way down: what an envelope can carry and bring back the same. */
export const JsonValueSchema: v.GenericSchema<Json> = v.lazy(() => v.union([
  v.string(), v.pipe(v.number(), v.finite()), v.boolean(), v.null(), v.array(JsonValueSchema), v.record(v.string(), JsonValueSchema),
]));

/** `text` as JSON, or null when it is not JSON: a task's output file, which the task may have left half written. */
export function jsonOf(text: string): Json {
  try {
    return v.parse(JsonSchema, JSON.parse(text));
  } catch (cause) {
    if (cause instanceof SyntaxError) return null;

    throw cause;
  }
}

/** A caught value as an Error: `catch` and a rejection hand over whatever was thrown, which need not be one. */
export function errorOf({ cause }: { readonly cause: unknown }): Error {
  return cause instanceof Error ? cause : new Error('a value that is not an Error was thrown', { cause });
}

/** Runs `work` to its end with nothing awaiting it: its failure goes to `onFailure`, never unhandled. */
export function detach(work: Promise<unknown>, onFailure: (error: Error) => void): void {
  work.then(undefined, (...rejected: [unknown]) => { onFailure(errorOf({ cause: rejected[0] })); });
}

/** One task: its item, which `ARMADA_ITEM` carries as JSON, whose numeric `weight` queues it and whose `gang` runs it on
 *  that many containers at once (`gangOf`), and a command's argv. */
export const TaskSchema = v.object({ item: JsonSchema, argv: v.optional(v.pipe(v.array(v.string()), v.minLength(1))) });

export type Task = v.InferOutput<typeof TaskSchema>;

export const MAX_TASKS = 100_000;

/** The most containers one task runs on: rank r is reachable from the others at 127.0.1.<r + 1>. */
export const MAX_GANG = 64;

/** The most bytes one argument of a task's command holds: Linux starts no process given an argument longer than
 *  MAX_ARG_STRLEN, 128 KiB with its terminating NUL. */
export const MAX_ARGUMENT_BYTES = 128 * 1024 - 1;

/** `text`'s size in UTF-8. A UTF-16 unit is at most 3 bytes of it, so a short text needs no encoding. */
function bytesOf(text: string): number {
  return text.length * 3 <= MAX_ARGUMENT_BYTES ? text.length : new TextEncoder().encode(text).byteLength;
}

/** Why a command's `argv` cannot start, or null: its first argument longer than `MAX_ARGUMENT_BYTES`. */
export function argumentRefusal(argv: readonly string[]): string | null {
  const sizes = argv.map(bytesOf);
  const long = sizes.findIndex((size) => size > MAX_ARGUMENT_BYTES);

  return long < 0 ? null : `argument ${String(long)} is ${String(sizes[long])} bytes, and Linux starts no process with one over ${String(MAX_ARGUMENT_BYTES)} (MAX_ARG_STRLEN): put that payload in a file the command reads`;
}

/** Why a task cannot start with `item`, or null: it must be JSON as it is, since NaN and Infinity would arrive as null,
 *  and every task's environment holds it as `ARMADA_ITEM=<its JSON>`, one string Linux bounds as it bounds an
 *  argument. */
export function itemRefusal(item: Json): string | null {
  if (!v.is(JsonValueSchema, item)) return 'item is not JSON as it is: a number in it is NaN or infinite, which JSON would send as null';
  const size = bytesOf(`ARMADA_ITEM=${JSON.stringify(item) ?? 'null'}`);

  return size > MAX_ARGUMENT_BYTES ? `item is ${String(size)} bytes as ARMADA_ITEM, and Linux starts no process with an environment string over ${String(MAX_ARGUMENT_BYTES)} (MAX_ARG_STRLEN): put that payload in a file the task reads` : null;
}

/** Why a job of at most `pool` containers refuses these tasks: a command's task carries its argv, each argument short
 *  enough to start, a pushed task's carries none, every item fits its `ARMADA_ITEM`, and a gang is a whole number of
 *  containers the pool holds. */
export function refusal(run: { readonly kind: 'command' | 'task' }, tasks: readonly Task[], pool: number, slots = 1): string | null {
  const odd = tasks.findIndex((task) => (task.argv === undefined) === (run.kind === 'command'));

  if (odd >= 0) return `item ${String(odd)} ${run.kind === 'command' ? 'has no argv for its command' : 'has an argv, which a pushed task takes none of'}`;

  for (const [index, task] of tasks.entries()) {
    const long = argumentRefusal(task.argv ?? []);

    if (long !== null) return `item ${String(index)}'s ${long}`;
    const large = itemRefusal(task.item);

    if (large !== null) return `item ${String(index)} ${large.slice('item '.length)}`;
  }

  if (slots > 1) {
    const ganged = tasks.findIndex((task) => gangOf(task.item) > 1);

    if (ganged >= 0) return `item ${String(ganged)}'s gang takes a whole container to itself: a slotted job's containers share each slot's view, so a gang runs only with 1 slot`;
  }

  const ganged = tasks.findIndex((task) => !Number.isInteger(gangOf(task.item)) || gangOf(task.item) < 1 || gangOf(task.item) > Math.min(MAX_GANG, pool));

  return ganged < 0 ? null : `item ${String(ganged)}'s gang is a whole number of containers from 1 to ${String(Math.min(MAX_GANG, pool))}, the job's pool`;
}

/** What a push records: a project's bundle, the ids of the tasks in it, and the runtime that runs them (`node` when
 *  absent). */
export const PushSchema = v.object({ project: Project, bundle: Digest, ids: v.pipe(v.array(TaskId), v.minLength(1)), runtime: RuntimeSchema });

export type Push = v.InferOutput<typeof PushSchema>;

/** A task's output up to this size rides in its event; a larger one is read from R2. */
export const INLINE_BYTES = 32 * 1024;

/** When a task that failed by itself runs again: up to `attempts` runs in all, on one of these exit codes, or on one of
 *  these errors a pushed task's body threw, by name. Each retry waits `backoffSeconds`, doubled each time. */
export const RetriesSchema = v.object({
  attempts: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(10)),
  backoffSeconds: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(3600)), 1),
  exitCodes: v.optional(v.array(v.pipe(v.number(), v.integer())), []),
  errors: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
});

export type Retries = v.InferInput<typeof RetriesSchema>;

/** A secret's name, as the environment variable a task gets it in. */
export const SecretName = v.pipe(v.string(), v.regex(/^[A-Z_][A-Z0-9_]{0,63}$/u, 'a secret name is upper-case letters, digits and _, at most 64'));

/** The most a secret's value may hold, in bytes: it rides in a task's environment. */
export const SECRET_BYTES = 32 * 1024;

/** General map jobs retain their six-hour limit: wheel builds and preflight runs can legitimately take hours. */
export const JOB_DEADLINE_SECONDS = 6 * 60 * 60;

/** CI reports its own deadline below a typical runner's 40-minute timeout, leaving time to report and clean up. */
export const CI_DEADLINE_SECONDS = 30 * 60;

/** The time a formed gang gets to launch all its ranks, from when the last one joined, even while they keep
 *  heartbeating. A gang still forming waits for its ranks' containers, however long they are busy. */
export const GANG_START_SECONDS = 5 * 60;

/** A task timeout explicitly requested must fit the whole job's limit. An implicit task timeout does not prevent a
 *  client from choosing a shorter whole-job bound, as CI does. */
export function deadlineRefusal(timeout: number | undefined, deadline: number | undefined): string | null {
  const bound = deadline ?? JOB_DEADLINE_SECONDS;

  return timeout !== undefined && bound < timeout ? `JobDeadlineTooShort: job deadline ${String(bound)} s is shorter than the task timeout ${String(timeout)} s` : null;
}

/** How a job places its tasks. `efficient` runs as many tasks in each container as their measured use fits, each in a
 *  slot of its own, so the job holds fewer containers; a task not measured yet runs alone, and one that fails beside
 *  others runs again alone. `fast` runs one task a container. */
export const ModeSchema = v.picklist(['efficient', 'fast']);

export type Mode = v.InferOutput<typeof ModeSchema>;

/** A host's CPU as /proc/cpuinfo has it: its vendor (`AuthenticAMD`), family and model. Hosts of one model compute a
 *  float operation alike, and of two models need not: an approximate one such as `vrsqrtps` differs between them,
 *  whatever the instructions XLA chose (#40). */
export const CpuSchema = v.object({ vendor: v.string(), family: v.pipe(v.number(), v.integer()), model: v.pipe(v.number(), v.integer()) });

export type Cpu = v.InferOutput<typeof CpuSchema>;

/** A host that ran a task: its CPU, the CPU's name, and its x86-64 level (`x86-64-v4` is 4; 0 below v2 or off x86). */
export const HostSchema = v.object({ ...CpuSchema.entries, name: v.string(), level: v.number() });

export type Host = v.InferOutput<typeof HostSchema>;

/** A host as a person reads it: `AMD EPYC 25/17 (x86-64-v4)`. */
export const hostLabel = ({ name, family, model, level }: Host): string => `${name} ${String(family)}/${String(model)}${level === 0 ? '' : ` (x86-64-v${String(level)})`}`;

/** The CPUs a job takes, any one of them (#48): one, as a client before wire 11 sends it, or a list. */
export const CpusSchema = v.pipe(v.union([CpuSchema, v.pipe(v.array(CpuSchema), v.minLength(1, 'cpu names at least one CPU'))]), v.transform((cpu) => [cpu].flat()));

/** CPUs as `--cpu` takes them and a person reads them: `AuthenticAMD/25/17 or AuthenticAMD/26/17`. */
export const cpuLabel = (cpus: readonly Cpu[]): string => cpus.map(({ vendor, family, model }) => `${vendor}/${String(family)}/${String(model)}`).join(' or ');

/** Whether `host` has one of the CPUs `cpus`. */
export const hasCpu = (host: Host, cpus: readonly Cpu[]): boolean => cpus.some((cpu) => host.vendor === cpu.vendor && host.family === cpu.family && host.model === cpu.model);

/** For a repository recipe: the commit each container checks out, packed against `base`. `shallow` is the pack's
 *  boundary, the commits it holds whose parents it does not (`boundaryOf`): the commit itself for a `commit` history, a
 *  shallow clone's own boundary for a `full` one (#34). */
export const CommitSchema = v.object({ sha: Sha, base: PackBase, packer: Packer, shallow: v.optional(v.array(Sha)) });

export type Commit = v.InferOutput<typeof CommitSchema>;

/** The boundary a commit's checkout marks shallow, so git walks only what its repository holds. A commit an earlier
 *  client sent carries none, and its pack is what its history implies: a `commit` history's, the commit's tree alone. */
export function boundaryOf(commit: { readonly sha: string; readonly shallow?: readonly string[] | undefined }, history: 'full' | 'commit'): readonly string[] {
  return commit.shallow ?? (history === 'commit' ? [commit.sha] : []);
}

export const JobSpecSchema = v.object({
  recipe: RecipeSchema,
  commit: v.optional(CommitSchema),
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
  /** The most tasks this job runs at once, and so the most containers; the account's ceiling and the item count bound
   *  it too. With `slots`, the most containers, each running `slots` tasks. */
  pool: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(375)), 50),
  /** The tasks one container runs at once, each isolated in its own slot: the job's lanes are pool × slots. More than
   *  one fixes the count, whatever `mode`. */
  slots: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16)), 1),
  mode: v.optional(ModeSchema, 'efficient'),
  /** The CPUs a container's host may have (`CpusSchema`). A container on another host is replaced before it takes a task. */
  cpu: v.optional(CpusSchema),
  /** A straggling task may be run again by an idle container, first answer kept. Only for tasks safe to repeat. */
  speculative: v.optional(v.boolean(), false),
  /** The job's heaviest tasks, this many, each run twice from the start, first answer kept: a copy that drew a slow
   *  container holds the job up no longer than the other copy takes. Only for tasks safe to repeat. */
  hedge: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  /** A task's own bound, in seconds. */
  timeout: v.optional(v.pipe(v.number(), v.minValue(1)), 3600),
  /** The whole job's bound, including environment preparation and container starts, in seconds. */
  deadline: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), JOB_DEADLINE_SECONDS),
  /** A formed gang's bound to launch every rank, in seconds, independent of its task timeout. */
  gangStartTimeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), GANG_START_SECONDS),
  retries: v.optional(RetriesSchema),
  /** The deployment's secrets each task gets in its environment, by name. Only names travel and are kept. */
  secrets: v.optional(v.array(SecretName), []),
  /** The deployment's own bearer joins the task's environment at claim (masked like a secret's value, never kept):
   *  a CI webhook's driver asks, and any bearer'd client could — it is the same token it called with. */
  deployToken: v.optional(v.boolean(), false),
  /** A pushed task's answers kept this many days, by its bundle, environment and item: an item answered before runs
   *  nothing. Only for a task whose answer those three decide. */
  cache: v.optional(v.object({ days: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)) })),
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
  /** The slot of the vessel's container it ran in, only for a job of more than one slot a container. */
  slot: v.optional(v.number()),
  /** The last lines the task printed. */
  tail: v.string(),
  /** Whether the task's output is stored, at `/jobs/<id>/tasks/<index>/output`, and the output itself when it is text
   *  of at most INLINE_BYTES. */
  output: v.boolean(),
  value: v.optional(v.string()),
  /** Whether the task's artifacts directory was stored, at `/jobs/<id>/tasks/<index>/artifacts`, a tar.gz. */
  artifacts: v.optional(v.boolean()),
  /** A pushed task's answer, as its runner says: `value` is an envelope with the body's value or error, `command` the
   *  file the body's command wrote. */
  answer: v.optional(v.picklist(['value', 'command'])),
  /** The name of the error a pushed task's body threw. */
  error: v.optional(v.string()),
  /** The task's cgroup at its end: the most memory it held, file cache included, in bytes, and the CPU it used. */
  peakMemory: v.optional(v.number()),
  cpuSeconds: v.optional(v.number()),
  /** The kernel killed a process of the task's for want of memory. */
  oomKilled: v.optional(v.boolean()),
  /** It ran beside other tasks in its container and ended other than green, so it ran again alone, and this is that run:
   *  how the run beside them ended. */
  aloneAfter: v.optional(v.string()),
  /** The bytes its writes left on the container's disk, for a task in a slot of its own: its overlays and task dir. */
  diskBytes: v.optional(v.number()),
  /** Answered from the job's cache: nothing ran. */
  cached: v.optional(v.boolean()),
  /** The host it ran on. */
  host: v.optional(HostSchema),
});

export type Outcome = v.InferOutput<typeof OutcomeSchema>;

/** A job's outcomes in the order they landed, `at` when each did, in ms: absent for one an earlier Worker recorded. */
export const EventsSchema = v.object({ events: v.array(v.object({ seq: v.number(), outcome: OutcomeSchema, at: v.optional(v.number()) })), done: v.boolean() });

/** Where a vessel's boot went (#32): waiting for the fleet's capacity, from the job asking for the vessel; the start,
 *  from the capacity granted to the container's first answer, which takes in the snapshot's restore and any start made
 *  again, each said in `restarts`; and the setup that follows, from the first answer to its first claim (the tmpfs
 *  mounts, the commit's pack and checkout, the job's files and its bundle). */
export const BootSchema = v.object({
  waitMs: v.number(),
  startMs: v.number(),
  restarts: v.array(v.string()),
  setupMs: v.number(),
  /** The host it started on; absent from an earlier Worker. */
  host: v.optional(HostSchema),
});

export type Boot = v.InferOutput<typeof BootSchema>;

const VesselSchema = v.object({
  name: v.string(),
  state: v.picklist(['waiting', 'booting', 'working', 'done', 'failed']),
  tasks: v.number(),
  /** From the fleet's capacity granted to the container's first answer: `boot`'s `startMs`. */
  bootMs: v.nullable(v.number()),
  /** Its boot by phase, once it booted; absent before, and from an earlier Worker. */
  boot: v.optional(BootSchema),
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
  /** The tasks running now, one row per container each runs on (every rank of a gang, a straggler's second run), with
   *  when it began there. Absent from an earlier Worker. */
  running: v.optional(v.array(v.object({ index: v.number(), vessel: v.string(), started: v.number(), slot: v.optional(v.number()) }))),
  /** A repository job's project (`recipe.repo.project`), null for any other. Null from an earlier Worker too. */
  project: v.optional(v.nullable(v.string()), null),
});

export type JobStatus = v.InferOutput<typeof JobStatusSchema>;

/** A task's status, as `GET /status/<job>/<index>` answers its job's status token: the job's phase, the task's state and
 *  attempt, every run of it that may still be going, by the container its tasks know as ARMADA_VESSEL (every rank of a
 *  gang, each copy of a repeated one, one the job stopped until its process or container is gone), and once it ended,
 *  its last outcome's exit code and reason. */
export const TaskStatusSchema = v.object({
  job: v.string(),
  phase: JobStatusSchema.entries.phase,
  index: v.number(),
  state: v.picklist(['queued', 'running', 'exited', 'failed']),
  attempt: v.number(),
  running: v.array(v.object({ vessel: v.string(), slot: v.number(), attempt: v.number(), started: v.number() })),
  exitCode: v.optional(v.number()),
  reason: OutcomeSchema.entries.reason,
});

export type TaskStatus = v.InferOutput<typeof TaskStatusSchema>;

/** A job in its deployment's list of recent ones: its status less each container's and task's own rows. */
export const JobBriefSchema = v.object({
  ...v.pick(JobStatusSchema, ['id', 'label', 'phase', 'createdAt', 'startedAt', 'finishedAt', 'tasks', 'project']).entries,
  /** The containers it started, and those still up. */
  containers: v.number(),
  alive: v.number(),
  problems: v.array(v.string()),
});

export type JobBrief = v.InferOutput<typeof JobBriefSchema>;

export const JobsSchema = v.object({ jobs: v.array(JobBriefSchema) });

export function briefOf(status: JobStatus): JobBrief {
  const { id, label, phase, createdAt, startedAt, finishedAt, tasks, vessels, problems, project } = status;

  return {
    id, label, phase, createdAt, startedAt, finishedAt, tasks, problems, project,
    containers: vessels.length, alive: vessels.filter((vessel) => vessel.state === 'waiting' || vessel.state === 'booting' || vessel.state === 'working').length,
  };
}

/** An environment snapshot: what every container with its key starts from. */
export const GenerationSchema = v.object({
  key: v.string(),
  snapshot: v.object({ id: v.string(), size: v.number() }),
  /** The commit whose checkout and install it holds, for a repository recipe. */
  sha: v.nullable(v.string()),
  /** Its commit's history stops short of the root: prepared from a shallow pack, so never the base of a pack of `full`
   *  history, whose objects it may not hold (#34). Absent from an earlier Worker's, which recorded none. */
  shallow: v.optional(v.boolean(), false),
  created: v.number(),
  /** Seconds each preparation phase took. */
  seconds: v.record(v.string(), v.number()),
});

/** An environment in the deployment's registry: being prepared, ready, or failed a while ago. */
export const EnvironmentEntrySchema = v.variant('state', [
  /** A preparation: begun `since`, its preparer last heard from at `beat`, the `attempt`th the platform let fail (absent
   *  for the first). */
  v.object({ state: v.literal('preparing'), sha: v.nullable(v.string()), shallow: v.optional(v.boolean(), false), since: v.number(), beat: v.optional(v.number()), attempt: v.optional(v.number()) }),
  v.object({ state: v.literal('ready'), generation: GenerationSchema, lastUsed: v.number() }),
  v.object({ state: v.literal('failed'), at: v.number(), reason: v.string() }),
]);

export const EnvironmentsSchema = v.array(v.object({ key: v.string(), entry: EnvironmentEntrySchema }));

/** The fleet now: its cap, the vCPUs and containers each job holds, and the tasks running and queued across every open
 *  job, however old. */
export const FleetSchema = v.object({
  cap: v.number(), jobs: v.array(v.object({ id: v.string(), vcpus: v.number(), containers: v.number() })),
  /** The most it holds now: its cap, or more while it borrows what the account leaves idle. Absent from an earlier
   *  Worker. */
  limit: v.optional(v.number()),
  tasks: v.optional(v.object({ running: v.number(), queued: v.number() })),
});

export type Fleet = v.InferOutput<typeof FleetSchema>;

/** The projects with a stored verdict, and one project's verdicts, newest first, each with its rows and its red ones. */
export const ProjectsSchema = v.object({ projects: v.array(Project) });

export const VerdictsSchema = v.object({ verdicts: v.array(v.object({ sha: Sha, uploaded: v.number(), rows: v.number(), reds: v.number() })) });

/** A project's GitHub webhook as the deployment answers it, never with its signing secret: the repo, the branches that
 *  build (absent: the repo's default branch), whether same-repo pull requests do, the secret holding the GitHub
 *  token, and the GitHub hook's id when the CLI made it. */
export const WebhookSchema = v.object({
  project: Project, repo: v.string(), branches: v.optional(v.array(v.string())), pullRequests: v.boolean(), tokenSecret: v.string(), hook: v.optional(v.number()),
});

export type Webhook = v.InferOutput<typeof WebhookSchema>;

/** A project's webhook: its GitHub repo, the branches that build (absent: the repo's default branch), whether
 *  same-repo pull requests do, the deployment secret holding a GitHub token, the secret GitHub signs deliveries with
 *  (kept only here, never answered back), and the GitHub hook's id when the CLI made it, so `remove` deletes it too. */
export const HookConfigSchema = v.object({
  repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'a repo is owner/name')),
  branches: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  pullRequests: v.optional(v.boolean(), false),
  tokenSecret: v.optional(SecretName, 'GITHUB_TOKEN'),
  secret: v.pipe(v.string(), v.minLength(16)),
  hook: v.optional(v.number()),
});

export type HookConfig = v.InferOutput<typeof HookConfigSchema>;

export const WebhooksSchema = v.object({ webhooks: v.array(WebhookSchema) });

/** The environments a deployment keeps the snapshots of beyond those its open jobs use, unless its deploy names another
 *  count (`armada deploy --keep`): the most recently used ones. */
export const KEPT_ENVIRONMENTS = 3;

/** A deployment's state: its runner layer, its wire, the oldest wire it still serves (absent from a Worker that
 *  predates the field), the vCPUs its fleet holds, and the jobs not yet done, those waiting for an environment or
 *  for a container included. */
export const HealthSchema = v.object({
  ok: v.boolean(), driver: v.number(), protocol: v.number(), oldest: v.optional(v.number()), vcpus: v.number(), jobs: v.number(),
  /** The commit the deployed Worker was built from, `armada deploy`'s ARMADA_SHA var — absent on a Worker before it. */
  sha: v.optional(v.string()),
  /** The fingerprint of the interface its Durable Objects call each other by (`contractOf`), `armada deploy`'s
   *  ARMADA_CONTRACT var — absent on a Worker before it. */
  contract: v.optional(v.string()),
  /** When the registry credentials a `--keep` deploy gave the Worker expire, an ISO date; absent without them. */
  keepUntil: v.optional(v.string()),
});

export type Health = v.InferOutput<typeof HealthSchema>;

/** The oldest wire the Worker of a `health` still serves: what it says, else the floor of one that predates the
 *  field — OLDEST_CLIENT has been 3 since protocol 4, and before that a Worker served only its own. */
export function servedFloor(health: Health): number {
  return health.oldest ?? (health.protocol >= 4 ? 3 : health.protocol);
}

/** Whether the deployed Worker of `health` is drained before one of interface `contract` (`contractOf`) replaces it:
 *  when the deploy is told so, when it cannot be asked what it serves, when this Worker would refuse a client it
 *  serves — its wire newer than this one's, or its floor older than this one's — when its containers run under another
 *  driver, or when its Durable Objects call each other by another interface, or one it does not say. Its objects keep
 *  running its code for minutes after the deploy, so they would read the new objects' calls by the old interface. */
export function mustDrain(health: Health | null, force: boolean, contract: string): boolean {
  return force || health === null || health.protocol > PROTOCOL || servedFloor(health) < OLDEST_CLIENT || health.driver !== DRIVER || health.contract !== contract;
}

const UsageSchema = v.object({ memory: v.number(), cores: v.number() });

/** The timings a project's graded run reports back, and the medians a plan reads: `{rows, files}`. `usage` is the
 *  most one task used in the run reported, or in the last runs read. */
export const TimingsSchema = v.object({
  rows: v.record(v.string(), v.number()), files: v.record(v.string(), v.number()), usage: v.optional(v.nullable(UsageSchema)),
});

export type Timings = v.InferOutput<typeof TimingsSchema>;

const JsonArraySchema = v.array(JsonSchema);

const JsonObjectSchema = v.record(v.string(), JsonSchema);

/** A JSON object: an object that is not an array. */
const isJsonObject = (value: Json): value is { readonly [key: string]: Json } => !v.is(JsonArraySchema, value) && v.is(JsonObjectSchema, value);

/** `value` with every object's keys sorted. */
function sortedKeys(value: Json): Json {
  if (v.is(JsonArraySchema, value)) return value.map(sortedKeys);

  return isJsonObject(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, each]) => [key, sortedKeys(each)])) : value;
}

/** `bytes` in lowercase hex. */
export const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** SHA-256 of `text` as UTF-8, in hex, with WebCrypto, which both Bun and the Workers runtime have. */
export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** JSON with every object's keys sorted, so two equal items read the same. */
export function canonical(value: Json): string {
  return JSON.stringify(sortedKeys(value));
}

/** The R2 key a pushed task's answer is cached under: its bundle, its id, its environment and its item decide it. A
 *  bundle holds every task of its project, so the id tells apart two tasks with the same recipe and item. */
export async function cacheKey(bundle: string, task: string, environment: string, item: Json): Promise<string> {
  return `cache/${await sha256(`${bundle}\n${task}\n${environment}\n${canonical(item)}`)}`;
}

/** One environment per driver and recipe: base, scripts, size and, for a repository, its key files. */
export async function environmentKey(recipe: Recipe): Promise<string> {
  const repo = recipe.repo === undefined ? null : {
    ...recipe.repo,
    manifest: [...recipe.repo.manifest].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => `${entry.path} ${entry.id}`),
  };

  // The size keys by its instance type, as the instance type did before sizes were named.
  const inputs = [DRIVER, recipe.base, recipe.setup, recipe.install, SIZES[recipe.size].instance, repo];

  return await sha256(JSON.stringify(inputs));
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

const ScalarSchema = v.union([v.string(), v.number(), v.boolean()]);

/** The values an item gives a command: `{index}`, `{item}` (its text, or its JSON), and an object item's scalar keys. */
export function itemValues(item: Json, index: number) {
  const scalars = isJsonObject(item) ? Object.entries(item).flatMap(([key, value]) => v.is(ScalarSchema, value) ? [[key, String(value)] as const] : []) : [];

  return { index: String(index), item: v.is(v.string(), item) ? item : JSON.stringify(item), ...Object.fromEntries(scalars) };
}

/** How many containers an item runs on at once: an object's `gang`, else 1; a `gang` that is no number is NaN, which a
 *  job refuses by name. Rank r of a gang of n runs with ARMADA_RANK=r and ARMADA_WORLD=n, as host `rank<r>`, and each
 *  rank reaches the others' ports at theirs. */
export function gangOf(item: Json): number {
  if (!isJsonObject(item) || !Object.hasOwn(item, 'gang')) return 1;
  const { gang } = item;

  return v.is(v.number(), gang) ? gang : Number.NaN;
}

/** An item's weight for longest-first dispatch: an object's finite `weight`, else 0. */
export function weightOf(item: Json): number {
  const weighed = v.safeParse(v.looseObject({ weight: v.pipe(v.number(), v.finite()) }), item);

  return weighed.success ? weighed.output.weight : 0;
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
  return SIZE_NAMES.find((size) => usage.memory <= SIZES[size].memoryGiB * 2 ** 30 * 0.75 && usage.cores <= SIZES[size].vcpus * 0.75) ?? 'medium';
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

/** The median of `values`, the mean of the middle two of an even count; 0 of none. */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Each key's median: one slow run moves no estimate. */
export function medians(history: Readonly<Record<string, readonly number[]>>): Record<string, number> {
  return Object.fromEntries(Object.entries(history).map(([key, values]) => [key, median(values)]));
}
