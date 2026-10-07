/**
 * armada's typed API. `fn` and `cmd` define a task, `task.map(items)` runs it once per item on a fleet of containers,
 * and the `Job` it returns yields each item's result, typed by the task.
 *
 *   export const square = fn(import.meta, (n: number) => n * n);
 *   const squares = await square.map([1, 2, 3]).values();   // number[]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { jsonOf, MAX_TASKS, RecipeSchema, type JobStatus, type Outcome, type Recipe as RecipeSpec, type Size, type Task as WireTask } from './protocol';
import { remoteError, RUN, type Context, type Envelope, type Json, type RemoteError, type Runnable } from './runner';
import { connect, summaryOf, type Armada, type Summary } from './sdk';
import type { StandardSchemaV1 } from './standard-schema';

export type { Context, Json, RemoteError };

/** `T` when it travels as JSON and comes back the same: no `undefined` that is not an optional property, no function,
 *  no `Date`, `Map`, `Set` or bytes, and nothing as loose as `any`, `unknown`, `object` or `{}`. */
export type Plain<T> = 0 extends 1 & T ? never
  : T extends string | number | boolean | null ? T
  : T extends Uint8Array | bigint | symbol | undefined | ((...args: never[]) => void) ? never
  : T extends readonly (infer E)[] ? readonly Plain<E>[]
  : T extends object ? [keyof T] extends [never] ? never : { [K in keyof T]: Plain<T[K]> }
  : never;

/** What a task may answer: plain JSON, or bytes. */
export type Value<T> = 0 extends 1 & T ? never : T extends Uint8Array ? T : Plain<T>;

/** A task's value as it arrives: bytes come back as a plain `Uint8Array`, whatever subclass the function returned. */
export type Arrived<T> = T extends Uint8Array ? Uint8Array : T;

/** An environment's recipe: a base image, a root `setup` script, a user `install` script, a `smoke` check and a size. */
export type Recipe = RecipeSpec & {
  /** The commit a repository recipe checks out, which `armada run` and `map --commit` set. */
  readonly commit?: { readonly sha: string; readonly base: string; readonly packer?: number };
};

export interface RecipeOptions {
  readonly base?: string;
  readonly setup?: string;
  readonly install?: string;
  readonly smoke?: string;
  readonly size?: Size;
}

export function recipe(options: RecipeOptions = {}): Recipe {
  return v.parse(RecipeSchema, options);
}

export interface TaskOptions {
  /** A task's limit, in seconds. Default 3600. */
  readonly timeout?: number;
  /** Lets an idle container run a straggler again, the first answer kept. Only for tasks safe to repeat. */
  readonly speculative?: boolean;
}

export interface MapOptions {
  /** The most containers at once. Default 50. */
  readonly pool?: number;
  readonly label?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Small files every container gets under `context.files`, or `/armada/files` for a command. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths that get a fresh tmpfs in each container. Default `/tmp` and `/dev/shm`. */
  readonly tmpfs?: readonly string[];
  /** The deployment. Default `connect()`. */
  readonly armada?: Armada;
}

/** What each item's task came to, in completion order or input order. */
export type Result<I, O> = { readonly index: number; readonly item: I; readonly meta: Meta } & (
  | { readonly kind: 'ok'; readonly value: O }
  /** The function threw, its value failed its schema, or the command exited nonzero. */
  | { readonly kind: 'error'; readonly error: RemoteError }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled'; readonly reason: string }
  /** The platform lost it twice. */
  | { readonly kind: 'lost'; readonly reason: string }
);

export interface Meta {
  readonly seconds: number;
  readonly attempt: number;
  /** The container that ran it, by its name in the job. */
  readonly container: string;
  readonly exitCode: number;
  /** The last lines it printed. */
  readonly tail: string;
  /** The most memory its cgroup held, in bytes, and the CPU it used. */
  readonly peakMemory?: number;
  readonly cpuSeconds?: number;
}

/** A job whose results are not all `ok`: every result is here, in input order. */
export class MapError<I, O> extends Error {
  constructor(readonly results: readonly Result<I, O>[]) {
    const failed = results.filter((result) => result.kind !== 'ok');
    const first = failed[0];

    super(`${String(failed.length)} of ${String(results.length)} tasks did not succeed${first === undefined ? '' : `; item ${String(first.index)}: ${describe(first)}`}`);
    this.name = 'MapError';
  }
}

function describe<I, O>(result: Result<I, O>): string {
  switch (result.kind) {
    case 'ok': return 'ok';
    case 'error': return `${result.error.name}: ${result.error.message}`;
    case 'timeout': return `timed out after ${result.meta.seconds.toFixed(0)} s`;
    default: return `${result.kind}: ${result.reason}`;
  }
}

export interface Task<I, O> {
  /** Runs the task once per item. Items stream in when given as an iterable, and results stream out as they land. */
  map(items: Iterable<I> | AsyncIterable<I>, options?: MapOptions): Job<I, O>;
  /** One item's value, or its MapError. */
  run(item: I, options?: MapOptions): Promise<O>;
  /** A job this task ran, by its id. */
  job(id: string, options?: Pick<MapOptions, 'armada'>): Job<I, O>;
}

type Handler<I, O> = (input: I, context: Context) => O | Promise<O>;

type InputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

type OutputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/** `Then` when items of type `I` can be sent and values of type `O` can come back, else a type naming the one that
 *  cannot, which the argument it checks then fails to match. */
type Checked<I, O, Then> = [I] extends [Plain<I>] ? [O] extends [Value<O>] ? Then
  : { readonly 'a task answers plain JSON or bytes, and this value type is neither': O }
  : { readonly 'a task takes plain JSON, and this item type is not': I };

export interface FnOptions extends TaskOptions {
  /** Default `recipe()`: `cloudflare/debian-trixie` on medium. */
  readonly recipe?: Recipe;
}

/**
 * A function to run in containers. `module` is the defining module's `import.meta`: its file is bundled with what it
 * imports and imported in each container, so the function must be exported from it. With `input` and `output`
 * schemas, callers pass the input schema's input, the handler gets its output, and the value is checked in the
 * container before it counts as `ok`.
 */
export function fn<SI extends StandardSchemaV1, SO extends StandardSchemaV1>(module: NoInfer<Checked<InputOf<SI>, OutputOf<SO>, ImportMeta>>, options: FnOptions & { readonly input: SI; readonly output: SO }, handler: Handler<OutputOf<SI>, InputOf<SO>>): Task<InputOf<SI>, Arrived<OutputOf<SO>>>;
export function fn<SI extends StandardSchemaV1, O>(module: NoInfer<Checked<InputOf<SI>, O, ImportMeta>>, options: FnOptions & { readonly input: SI; readonly output?: undefined }, handler: Handler<OutputOf<SI>, O>): Task<InputOf<SI>, Arrived<O>>;
export function fn<I, SO extends StandardSchemaV1>(module: NoInfer<Checked<I, OutputOf<SO>, ImportMeta>>, options: FnOptions & { readonly input?: undefined; readonly output: SO }, handler: Handler<I, InputOf<SO>>): Task<I, Arrived<OutputOf<SO>>>;
export function fn<I, O>(module: NoInfer<Checked<I, O, ImportMeta>>, options: FnOptions & { readonly input?: undefined; readonly output?: undefined }, handler: Handler<I, O>): Task<I, Arrived<O>>;
export function fn<I, O>(module: NoInfer<Checked<I, O, ImportMeta>>, handler: Handler<I, O>): Task<I, Arrived<O>>;
// The overloads above check `module`; past them it is the caller's `import.meta`.
export function fn(module: object, ...rest: [Handler<Json, unknown>] | [FnOptions & { readonly input?: StandardSchemaV1; readonly output?: StandardSchemaV1 }, Handler<Json, unknown>]): Task<Json, unknown> {
  const [options, handler] = rest.length === 1 ? [{}, rest[0]] : rest;

  return new FnTask((module as ImportMeta).url, options, handler);
}

export interface CmdOptions extends TaskOptions {
  /** What a command writes to `$ARMADA_OUT` and the task answers: its text, its bytes, or JSON a schema checks. Without
   *  it, the answer is null. */
  readonly output?: 'text' | 'bytes' | StandardSchemaV1;
}

/** An item's argv. A builder that takes no item maps over nulls. */
type Argv<I> = (item: I, at: { readonly index: number }) => readonly string[];

/**
 * A command to run in containers, its argv built per item here, so an item is never pasted into a shell string. It
 * succeeds when it exits 0.
 */
export function cmd<S extends StandardSchemaV1, I = null>(recipe: NoInfer<Checked<I, OutputOf<S>, Recipe>>, argv: Argv<I>, options: CmdOptions & { readonly output: S }): Task<I, Arrived<OutputOf<S>>>;
export function cmd<I = null>(recipe: NoInfer<Checked<I, string, Recipe>>, argv: Argv<I>, options: CmdOptions & { readonly output: 'text' }): Task<I, string>;
export function cmd<I = null>(recipe: NoInfer<Checked<I, Uint8Array, Recipe>>, argv: Argv<I>, options: CmdOptions & { readonly output: 'bytes' }): Task<I, Uint8Array>;
export function cmd<I = null>(recipe: NoInfer<Checked<I, null, Recipe>>, argv: Argv<I>, options?: CmdOptions & { readonly output?: undefined }): Task<I, null>;
// The overloads above check `recipe`; past them it is a Recipe.
export function cmd(recipe: object, argv: Argv<Json>, options: CmdOptions = {}): Task<Json, unknown> {
  return new CmdTask(recipe as Recipe, argv, options);
}

/** How a job is created and its outcomes read, for one kind of task. */
abstract class Base<I, O> implements Task<I, O> {
  constructor(protected readonly recipe: Recipe, protected readonly options: TaskOptions) {}

  /** The job's `run` and whether it keeps each task's output. */
  protected abstract runOf(armada: Armada): Promise<{ readonly run: { readonly kind: 'command' } | { readonly kind: 'fn'; readonly bundle: string }; readonly output: boolean }>;

  /** An item as a task, checked first. */
  protected abstract task(item: I, index: number): Promise<WireTask>;

  /** An exited task's answer. */
  abstract answer(outcome: Outcome, read: () => Promise<Uint8Array | null>): Promise<{ readonly kind: 'ok'; readonly value: O } | { readonly kind: 'error'; readonly error: RemoteError }>;

  map(items: Iterable<I> | AsyncIterable<I>, options: MapOptions = {}): Job<I, O> {
    const armada = options.armada ?? connect();

    return new Job(armada, this, new Submission(armada, (submission) => this.submit(armada, items, submission, options)));
  }

  async run(item: I, options?: MapOptions): Promise<O> {
    const [result] = await this.map([item], options).settled();

    if (result?.kind !== 'ok') throw new MapError(result === undefined ? [] : [result]);

    return result.value;
  }

  job(id: string, options: Pick<MapOptions, 'armada'> = {}): Job<I, O> {
    const armada = options.armada ?? connect();

    return new Job(armada, this, new Submission(armada, async () => await Promise.resolve(id), null));
  }

  /** Creates the job, all at once for an array and open for an iterable, whose items then follow in batches. */
  private async submit(armada: Armada, items: Iterable<I> | AsyncIterable<I>, submission: Submission<I>, options: MapOptions): Promise<string> {
    const { run, output } = await this.runOf(armada);
    const { commit, ...recipe } = this.recipe;
    const spec = {
      recipe, commit, run, output, pool: options.pool, label: options.label, env: options.env, files: options.files, tmpfs: options.tmpfs === undefined ? undefined : [...options.tmpfs],
      timeout: this.options.timeout, speculative: this.options.speculative,
    };

    if (Array.isArray(items)) {
      const all: readonly I[] = items;

      if (all.length > MAX_TASKS) throw new Error(`a job takes at most ${String(MAX_TASKS)} items, not ${String(all.length)}`);
      const tasks = await Promise.all(all.map(async (item, index) => await this.task(item, index)));
      const id = await armada.create({ ...spec, items: tasks });

      submission.sent?.push(...all);
      submission.finish();

      return id;
    }

    const id = await armada.create({ ...spec, items: [], open: true });

    submission.pump(id, items, async (item, index) => await this.task(item, index));

    return id;
  }
}

/**
 * How a job's items reach it: all at once, or streamed into an open job in batches that a timer flushes too, so a slow
 * source's items do not wait for the next one. A failure, or a cancel, stops it, and whoever reads the job learns of a
 * failure there.
 */
class Submission<I> {
  /** The items sent so far, in order, or null for a job this client did not submit. */
  readonly sent: I[] | null;

  readonly id: Promise<string>;

  /** Settles once every item is sent, or with why one could not be. */
  readonly done: Promise<void>;

  failure: Error | null = null;

  private stopped = false;

  private finish_: () => void = () => undefined;

  private fail_: (cause: Error) => void = () => undefined;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly armada: Armada, create: (submission: Submission<I>) => Promise<string>, sent: I[] | null = []) {
    this.sent = sent;
    this.done = new Promise<void>((resolve, reject) => {
      this.finish_ = resolve;
      this.fail_ = reject;
    });
    // A failure reaches whoever reads the job, through its id or its end; this keeps it from also being unhandled.
    this.done.catch(() => undefined);
    this.id = create(this);
    this.id.then(() => { if (sent === null) this.finish_(); }, (cause: unknown) => { this.fail(cause); });
  }

  finish(): void {
    this.finish_();
  }

  /** Sends `items` into open job `id` as they come. */
  pump(id: string, items: Iterable<I> | AsyncIterable<I>, task: (item: I, index: number) => Promise<WireTask>): void {
    let batch: WireTask[] = [];
    let flushing = Promise.resolve();
    const flush = (): Promise<void> => {
      const sending = batch;

      batch = [];
      flushing = flushing.then(async () => { if (sending.length > 0) await this.armada.add(id, sending); });

      return flushing;
    };

    this.timer = setInterval(() => { flush().catch(() => undefined); }, BATCH_MS);
    void (async () => {
      for await (const item of items) {
        if (this.stopped) return;
        const sent = this.sent ?? [];

        batch.push(await task(item, sent.length));
        sent.push(item);

        if (batch.length >= BATCH) await flush();
      }

      await flush();
      await this.armada.close(id);
      this.stop();
      this.finish_();
    })().catch(async (cause: unknown) => {
      this.fail(cause);
      await this.armada.cancel(id).catch(() => undefined);
    });
  }

  /** Stops taking items: the job was cancelled, or a failure ended it. */
  stop(): void {
    this.stopped = true;

    if (this.timer !== null) clearInterval(this.timer);
  }

  private fail(cause: unknown): void {
    this.failure = cause instanceof Error ? cause : new Error(String(cause));
    this.stop();
    this.fail_(this.failure);
  }
}

/** An open job's items go in batches of this many, or what came in this long. */
const BATCH = 500;

const BATCH_MS = 250;

const EnvelopeSchema = v.union([
  v.object({ ok: v.literal(true), value: v.custom<Json>(() => true) }),
  v.object({ ok: v.literal(true), bytes: v.string() }),
  v.object({ ok: v.literal(false), error: v.object({ name: v.string(), message: v.string(), stack: v.string() }) }),
]);

class FnTask<I, O> extends Base<I, O> implements Runnable {
  private readonly bundles = new WeakMap<Armada, Promise<string>>();

  constructor(private readonly url: string, private readonly fnOptions: FnOptions & { readonly input?: StandardSchemaV1; readonly output?: StandardSchemaV1 }, private readonly handler: Handler<Json, unknown>) {
    super(fnOptions.recipe ?? recipe(), fnOptions);
  }

  protected async runOf(armada: Armada) {
    const bundle = this.bundles.get(armada) ?? armada.uploadBundle(await bundleOf(this.url, this));

    this.bundles.set(armada, bundle);

    return { run: { kind: 'fn' as const, bundle: await bundle }, output: true };
  }

  protected async task(item: I, index: number): Promise<WireTask> {
    if (this.fnOptions.input !== undefined) await check(this.fnOptions.input, item, `item ${String(index)}`);

    // `Checked` let only plain JSON be an item.
    return { item: item as Json };
  }

  async answer(outcome: Outcome, read: () => Promise<Uint8Array | null>) {
    const bytes = outcome.value === undefined && outcome.output ? await read() : null;
    const text = outcome.value ?? (bytes === null ? null : new TextDecoder().decode(bytes));
    // A process that died before it answered left no envelope.
    const envelope = text === null ? null : v.safeParse(EnvelopeSchema, jsonOf(text));

    if (envelope?.success !== true) return { kind: 'error' as const, error: { name: 'Exit', message: `the function's process exited ${String(outcome.exitCode)}`, stack: outcome.tail } };

    if (!envelope.output.ok) return { kind: 'error' as const, error: envelope.output.error };
    const answered = envelope.output;

    return { kind: 'ok' as const, value: ('bytes' in answered ? new Uint8Array(Buffer.from(answered.bytes, 'base64')) : answered.value) as O };
  }

  /** In the container: the item through the input schema, the handler and the output schema. */
  readonly [RUN] = async (item: Json, context: Context): Promise<Envelope> => {
    try {
      const input = this.fnOptions.input === undefined ? item : await check(this.fnOptions.input, item, 'the input');
      const returned = await this.handler(input as Json, context);
      const value = this.fnOptions.output === undefined ? returned : await check(this.fnOptions.output, returned, 'the value');

      return value instanceof Uint8Array ? { ok: true, bytes: Buffer.from(value).toString('base64') } : { ok: true, value: value as Json };
    } catch (cause) {
      return { ok: false, error: remoteError(cause) };
    }
  };
}

class CmdTask<I, O> extends Base<I, O> {
  constructor(recipe: Recipe, private readonly argv: Argv<I>, private readonly cmdOptions: CmdOptions) {
    super(recipe, cmdOptions);
  }

  protected async runOf() {
    return { run: { kind: 'command' as const }, output: this.cmdOptions.output !== undefined };
  }

  protected async task(item: I, index: number): Promise<WireTask> {
    const argv = this.argv(item, { index });

    if (argv.length === 0) throw new Error(`item ${String(index)}'s argv is empty`);

    return { item: item as Json, argv: [...argv] };
  }

  async answer(outcome: Outcome, read: () => Promise<Uint8Array | null>) {
    const { output } = this.cmdOptions;

    if (outcome.exitCode !== 0) return { kind: 'error' as const, error: { name: 'Exit', message: `the command exited ${String(outcome.exitCode)}`, stack: outcome.tail } };

    if (output === undefined) return { kind: 'ok' as const, value: null as O };

    if (output === 'bytes') return { kind: 'ok' as const, value: (await read() ?? new Uint8Array()) as O };
    const text = outcome.value ?? new TextDecoder().decode(await read() ?? new Uint8Array());

    if (output === 'text') return { kind: 'ok' as const, value: text as O };

    try {
      return { kind: 'ok' as const, value: await check(output, JSON.parse(text), 'the output') as O };
    } catch (cause) {
      return { kind: 'error' as const, error: remoteError(cause) };
    }
  }
}

export class SchemaError extends Error {
  constructor(what: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(`${what} does not fit its schema: ${issues.map((issue) => `${issue.path?.map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.') ?? ''}${issue.path === undefined ? '' : ': '}${issue.message}`).join('; ')}`);
    this.name = 'SchemaError';
  }
}

async function check<S extends StandardSchemaV1>(schema: S, value: unknown, what: string): Promise<OutputOf<S>> {
  const result = await schema['~standard'].validate(value);

  if (result.issues !== undefined) throw new SchemaError(what, result.issues);

  return result.value as OutputOf<S>;
}

/** `task`'s module and what it imports, bundled for `node` with the runner as its entry. */
async function bundleOf(url: string, task: Runnable): Promise<Uint8Array<ArrayBuffer>> {
  const path = fileURLToPath(url);
  // The module is the caller's, known only at run time.
  const loaded: Record<string, unknown> = await import(url);
  const name = Object.keys(loaded).find((key) => loaded[key] === task);

  if (name === undefined) throw new Error(`export the function from ${path}: a container imports it from there`);
  const dir = mkdtempSync(join(tmpdir(), 'armada-bundle-'));

  try {
    const entry = join(dir, 'entry.ts');

    // The runner beside this module is the bundle's entry.
    const runner = fileURLToPath(new URL('runner.ts', import.meta.url));

    writeFileSync(entry, `import { ${name} as task } from ${JSON.stringify(path)};\nimport { runTask } from ${JSON.stringify(runner)};\nawait runTask(task);\n`);
    const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm' });
    const [output] = built.outputs;

    if (!built.success || output === undefined) throw new Error(`bundling ${path} failed:\n${built.logs.map(String).join('\n')}`);

    return new Uint8Array(await output.arrayBuffer());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A job's results: in completion order by iterating it, or in input order. */
export class Job<I, O> implements AsyncIterable<Result<I, O>> {
  private readonly answers = new Map<number, Promise<Result<I, O>>>();

  /** What the job holds, for a job this client did not submit: read again when it grew past what was read. */
  private held: readonly I[] = [];

  readonly id: Promise<string>;

  constructor(private readonly armada: Armada, private readonly task: Base<I, O>, private readonly submission: Submission<I>) {
    this.id = submission.id;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Result<I, O>> {
    const id = await this.id;
    const yielded = new Set<number>();

    for (let after = 0; ;) {
      const batch = await this.armada.events(id, after);
      const fresh = batch.events.filter((event) => !yielded.has(event.outcome.index));
      const results = fresh.map((event) => this.result(id, event.outcome));

      after = batch.events.at(-1)?.seq ?? after;

      for (const [at, event] of fresh.entries()) {
        const result = results[at];

        yielded.add(event.outcome.index);

        if (result !== undefined) yield await result;
      }

      if (batch.done) {
        // An ended job takes no more items: a source still to yield is not waited on, but a failure is said.
        this.submission.stop();

        if (this.submission.failure !== null) throw this.submission.failure;

        return;
      }

      if (batch.events.length === 0) await Bun.sleep(POLL_MS);
    }
  }

  /** Results in input order, each as soon as those before it have landed. */
  async *ordered(): AsyncGenerator<Result<I, O>> {
    const landed = new Map<number, Result<I, O>>();
    let next = 0;

    for await (const result of this) {
      landed.set(result.index, result);

      for (let ready = landed.get(next); ready !== undefined; ready = landed.get(next)) {
        landed.delete(next);
        next += 1;
        yield ready;
      }
    }

    yield* [...landed.values()].sort((left, right) => left.index - right.index);
  }

  /** Every result, in input order. */
  async settled(): Promise<Result<I, O>[]> {
    const all: Result<I, O>[] = [];

    for await (const result of this) all.push(result);

    return all.sort((left, right) => left.index - right.index);
  }

  /** Every value, in input order, or a MapError holding every result when one is not `ok`. */
  async values(): Promise<O[]> {
    const results = await this.settled();
    const values = results.flatMap((result) => result.kind === 'ok' ? [result.value] : []);

    if (values.length !== results.length) throw new MapError(results);

    return values;
  }

  /** Cancels the job and stops sending its items. */
  async cancel(): Promise<void> {
    this.submission.stop();
    await this.armada.cancel(await this.id);
  }

  async status(): Promise<JobStatus> {
    return await this.armada.status(await this.id);
  }

  async summary(): Promise<Summary> {
    return summaryOf(await this.status());
  }

  /** A task's whole log. */
  async log(index: number): Promise<string | null> {
    return await this.armada.log(await this.id, index);
  }

  /** What a task wrote to its output file, whatever its result, or null. */
  async output(index: number): Promise<Uint8Array | null> {
    return await this.armada.output(await this.id, index);
  }

  private result(id: string, outcome: Outcome): Promise<Result<I, O>> {
    const known = this.answers.get(outcome.index);

    if (known !== undefined) return known;
    const answered = this.resultOf(id, outcome);

    this.answers.set(outcome.index, answered);

    return answered;
  }

  /** An outcome's item: sent before it by this client, or read from the job, which held it before it ran. */
  private async item(id: string, index: number): Promise<I> {
    const sent = this.submission.sent;

    if (sent !== null) return sent[index] as I;

    // The job's items came from this task's map, so they are its items.
    if (index >= this.held.length) this.held = await this.armada.items(id) as I[];

    return this.held[index] as I;
  }

  private async resultOf(id: string, outcome: Outcome): Promise<Result<I, O>> {
    const item = await this.item(id, outcome.index);
    const meta: Meta = {
      seconds: outcome.seconds, attempt: outcome.attempt, container: outcome.vessel, exitCode: outcome.exitCode, tail: outcome.tail,
      ...outcome.peakMemory === undefined ? {} : { peakMemory: outcome.peakMemory }, ...outcome.cpuSeconds === undefined ? {} : { cpuSeconds: outcome.cpuSeconds },
    };
    const base = { index: outcome.index, item, meta };

    if (outcome.kind === 'failed') return { ...base, kind: outcome.reason === 'cancelled' ? 'cancelled' : 'lost', reason: outcome.tail };

    if (outcome.reason === 'timeout') return { ...base, kind: 'timeout' };

    return { ...base, ...await this.task.answer(outcome, async () => await this.armada.output(id, outcome.index)) };
  }
}

/** How long a job's reader waits when no outcome landed. */
const POLL_MS = 1_000;
