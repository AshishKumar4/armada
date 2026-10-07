/**
 * armada's typed API. `task` defines one, by an id unique in its deployment: its body runs in a container on each item,
 * returning a value, or a `sh` command whose `out` file is the answer. `armada push` sends a project's task folder, and
 * `.map`, `.stream`, `.run` and `.local` run a task by its id.
 *
 *   export const square = task({ id: 'square', run: (n: number) => n * n });
 *   const squares = await square.map([1, 2, 3]);   // number[]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { jsonOf, MAX_TASKS, RecipeSchema, type JobStatus, type Outcome, type Recipe as RecipeSpec, type Size, type Task as WireTask } from './protocol';
import { pushed } from './push';
import { remoteError, RUN, type Context, type Envelope, type Json, type RemoteError, type Runnable } from './runner';
import { connect, summaryOf, type Armada, type Summary } from './sdk';
import { execute, isShell, outFile, quote, ShellError, type Shell } from './sh';
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

/** A task's value as it arrives: bytes come back as a plain `Uint8Array`, whatever subclass the body returned. */
export type Arrived<T> = T extends Uint8Array ? Uint8Array : T;

/** An environment's recipe: a base image, a root `setup` script, a user `install` script and a size. */
export type Recipe = RecipeSpec & {
  /** The commit a repository recipe checks out, which `armada run` and `map --commit` set. */
  readonly commit?: { readonly sha: string; readonly base: string; readonly packer?: number };
};

export interface RecipeOptions {
  readonly base?: string;
  readonly setup?: string;
  readonly install?: string;
  readonly size?: Size;
}

/** A recipe built a step at a time. Each step returns a new recipe, so two tasks can share one as a base. Steps append
 *  to the recipe's scripts, so its environment key hashes exactly what runs. */
export class RecipeBuilder {
  /** The recipe as a job takes it. */
  readonly spec: Recipe;

  constructor(options: RecipeOptions) {
    this.spec = v.parse(RecipeSchema, options);
  }

  /** Debian packages, installed in setup as root. */
  apt(...packages: readonly string[]): RecipeBuilder {
    return this.then('setup', `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.map(quote).join(' ')}`);
  }

  /** More of setup, run as root once per environment. */
  setup(script: string): RecipeBuilder {
    return this.then('setup', script);
  }

  /** More of install, run as the user in the checkout once per environment. */
  install(script: string): RecipeBuilder {
    return this.then('install', script);
  }

  size(size: Size): RecipeBuilder {
    return new RecipeBuilder({ ...this.spec, size });
  }

  private then(script: 'setup' | 'install', step: string): RecipeBuilder {
    const before = this.spec[script];

    return new RecipeBuilder({ ...this.spec, [script]: before === '' ? step : `${before}\n${step}` });
  }
}

interface RecipeOf {
  (options?: RecipeOptions): RecipeBuilder;
  /** `cloudflare/debian-trixie`, the base a recipe has by default. */
  debian(): RecipeBuilder;
  /** Another base image, one the runtime starts by name. */
  from(base: string): RecipeBuilder;
}

export const recipe: RecipeOf = Object.assign((options: RecipeOptions = {}) => new RecipeBuilder(options), {
  debian: () => new RecipeBuilder({}),
  from: (base: string) => new RecipeBuilder({ base }),
});

export interface MapOptions {
  /** The most containers at once. Default 50. */
  readonly pool?: number;
  readonly label?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Small files every container gets under `context.files`. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths that get a fresh tmpfs in each container. Default `/tmp` and `/dev/shm`. */
  readonly tmpfs?: readonly string[];
  /** The deployment. Default `connect()`. */
  readonly armada?: Armada;
}

/** What each item's task came to, in completion order or input order. */
export type Result<I, O> = { readonly index: number; readonly item: I; readonly meta: Meta } & (
  | { readonly ok: true; readonly kind: 'ok'; readonly value: O }
  /** The body threw, its value failed its schema, or its command exited nonzero. */
  | { readonly ok: false; readonly kind: 'error'; readonly error: RemoteError }
  | { readonly ok: false; readonly kind: 'timeout' }
  | { readonly ok: false; readonly kind: 'cancelled'; readonly reason: string }
  /** The platform lost it on every attempt. */
  | { readonly ok: false; readonly kind: 'lost'; readonly reason: string }
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
    const failed = results.filter((result) => !result.ok);
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
  readonly id: string;
  /** Every item's value, in input order, or a MapError holding every result when one is not ok. */
  map(items: Iterable<I> | AsyncIterable<I>, options?: MapOptions): Promise<O[]>;
  /** The job, whose results arrive as they land. Items stream in when given as an iterable. */
  stream(items: Iterable<I> | AsyncIterable<I>, options?: MapOptions): Job<I, O>;
  /** One item's value, on one container. */
  run(item: I, options?: MapOptions): Promise<O>;
  /** One item's value, on this machine, with no container. */
  local(item: I): Promise<O>;
  /** A job this task ran, by its id. */
  job(id: string, options?: Pick<MapOptions, 'armada'>): Job<I, O>;
}

type InputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

type OutputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/** What a task answers with: its body's value, or, for a body that returns `sh`, its `out` file read as text, as
 *  bytes, or as JSON a schema checks. */
export type Output = 'text' | 'bytes' | StandardSchemaV1;

/** A task's value: a command's `out` read as `output` says, or the body's own value, as its output schema parses it. */
export type Answer<R, Out> = [R] extends [Shell]
  ? Out extends 'bytes' ? Uint8Array : Out extends 'text' ? string : Out extends StandardSchemaV1 ? Arrived<OutputOf<Out>> : null
  : Out extends StandardSchemaV1 ? Arrived<OutputOf<Out>> : Arrived<R>;

/** A task id's type: a string when the task's types travel, else a type naming the one that cannot, which the id then
 *  fails to be, so the error stands at the task's definition. */
type Checked<I, R, Out> = 0 extends 1 & I ? { readonly 'a task takes plain JSON, and this item type is any': I }
  : 0 extends 1 & R ? { readonly 'a task answers plain JSON or bytes, and this body returns any': R }
  : [I] extends [Plain<I>]
  ? [R] extends [Shell] ? OutputChecked<Out>
  : Out extends 'text' | 'bytes' ? { readonly 'output text or bytes is for a body that returns sh': Out }
  : Out extends StandardSchemaV1 ? [R] extends [InputOf<Out>] ? OutputChecked<Out> : { readonly 'the body returns what its output schema does not take': R }
  : [R] extends [Value<R>] ? string : { readonly 'a task answers plain JSON or bytes, and this body returns neither': R }
  : { readonly 'a task takes plain JSON, and this item type is not': I };

/** A string when an output schema gives plain JSON or bytes, nothing as loose as `any` or `unknown`. */
type OutputChecked<Out> = Out extends StandardSchemaV1
  ? 0 extends 1 & OutputOf<Out> ? { readonly 'a task answers plain JSON or bytes, and this output schema gives any': OutputOf<Out> }
  : [OutputOf<Out>] extends [Value<OutputOf<Out>>] ? string
  : { readonly 'a task answers plain JSON or bytes, and this output schema gives neither': OutputOf<Out> }
  : string;

export interface TaskConfig<I, R, Out extends Output | undefined, Id = string> {
  /** Unique in the deployment: `armada push` refuses a second task with it. */
  readonly id: Id;
  /** Default `recipe()`: `cloudflare/debian-trixie` on medium. */
  readonly recipe?: Recipe | RecipeBuilder;
  readonly output?: Out;
  /** A task's limit, in seconds. Default 3600. */
  readonly timeout?: number;
  /** Lets an idle container run a straggler again, the first answer kept. Only for tasks safe to repeat. */
  readonly speculative?: boolean;
  readonly run: (input: I, context: Context) => R | Promise<R>;
}

/**
 * A task. Export it from a file in the project's task folder (`armada.config.ts`), so `armada push` finds it. With an
 * `input` schema, callers pass its input and the body gets its output. A body's value, or a command's JSON, is checked
 * by the `output` schema before it counts as ok.
 */
// TypeScript first infers without a body whose parameters it must type itself, and checks the id then too: the
// defaults of I and R pass that check, so the body's own types decide it.
export function task<SI extends StandardSchemaV1, R = Shell, const Out extends Output | undefined = undefined>(config: TaskConfig<OutputOf<SI>, R, Out, NoInfer<Checked<InputOf<SI>, R, Out>>> & { readonly input: SI }): Task<InputOf<SI>, Answer<R, Out>>;
export function task<I = null, R = Shell, const Out extends Output | undefined = undefined>(config: TaskConfig<I, R, Out, NoInfer<Checked<I, R, Out>>> & { readonly input?: undefined }): Task<I, Answer<R, Out>>;
// The overloads check the config's types; past them its body takes and returns JSON, or returns a Shell.
export function task(config: TaskConfig<Json, unknown, Output | undefined, unknown> & { readonly input?: StandardSchemaV1 }): Task<Json, unknown> {
  // The overloads' id is a string once its checks pass.
  return new PushedTask({ ...config, id: String(config.id) });
}

/** A job's options of the task itself. */
interface TaskOptions {
  readonly timeout?: number;
  readonly speculative?: boolean;
}

/** How a job is created and its outcomes read, for one kind of task. */
abstract class Base<I, O> {
  constructor(protected readonly recipe: Recipe, protected readonly options: TaskOptions) {}

  /** The job's `run` and whether it keeps each task's output. */
  protected abstract runOf(armada: Armada): Promise<{ readonly run: { readonly kind: 'command' } | { readonly kind: 'task'; readonly id: string; readonly bundle?: string }; readonly output: boolean }>;

  /** An item as a task, checked first. */
  protected abstract task(item: I, index: number): Promise<WireTask>;

  /** An exited task's answer. */
  abstract answer(outcome: Outcome, read: () => Promise<Uint8Array | null>): Promise<{ readonly kind: 'ok'; readonly value: O } | { readonly kind: 'error'; readonly error: RemoteError }>;

  async map(items: Iterable<I> | AsyncIterable<I>, options: MapOptions = {}): Promise<O[]> {
    return await this.stream(items, options).values();
  }

  stream(items: Iterable<I> | AsyncIterable<I>, options: MapOptions = {}): Job<I, O> {
    const armada = options.armada ?? connect();

    return new Job(armada, this, new Submission(armada, (submission) => this.submit(armada, items, submission, options)));
  }

  async run(item: I, options?: MapOptions): Promise<O> {
    const [result] = await this.stream([item], options).settled();

    if (result?.ok !== true) throw new MapError(result === undefined ? [] : [result]);

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

/** A task's config, past the overloads' checks. */
type Config = TaskConfig<Json, unknown, Output | undefined> & { readonly input?: StandardSchemaV1 };

class PushedTask<I, O> extends Base<I, O> implements Task<I, O>, Runnable {
  readonly id: string;

  constructor(private readonly config: Config) {
    super(config.recipe instanceof RecipeBuilder ? config.recipe.spec : config.recipe ?? recipe().spec, config);
    this.id = config.id;
  }

  protected async runOf(armada: Armada) {
    const bundle = await pushed(armada);

    return { run: { kind: 'task' as const, id: this.id, ...bundle === null ? {} : { bundle } }, output: true };
  }

  protected async task(item: I, index: number): Promise<WireTask> {
    if (this.config.input !== undefined) await check(this.config.input, item, `item ${String(index)}`);

    // `Checked` let only plain JSON be an item.
    return { item: item as Json };
  }

  async answer(outcome: Outcome, read: () => Promise<Uint8Array | null>) {
    if (outcome.answer === 'command') return await commandAnswer<O>(this.config.output, outcome, read);
    const bytes = outcome.value === undefined && outcome.output ? await read() : null;
    const text = outcome.value ?? (bytes === null ? null : new TextDecoder().decode(bytes));
    // A process that died before it answered left no envelope.
    const envelope = outcome.answer === 'value' && text !== null ? v.safeParse(EnvelopeSchema, jsonOf(text)) : null;

    if (envelope?.success !== true) return { kind: 'error' as const, error: { name: 'Exit', message: `the task's process exited ${String(outcome.exitCode)}`, stack: outcome.tail } };

    if (!envelope.output.ok) return { kind: 'error' as const, error: envelope.output.error };
    const answered = envelope.output;

    return { kind: 'ok' as const, value: ('bytes' in answered ? new Uint8Array(Buffer.from(answered.bytes, 'base64')) : answered.value) as O };
  }

  /** On this machine: the same checks and body, a command run under this machine's `/bin/sh`. */
  async local(item: I): Promise<O> {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-local-'));

    try {
      const out = join(scratch, 'out');
      const context: Context = { index: 0, attempt: 1, signal: new AbortController().signal, out: outFile(out), files: scratch };
      const input = this.config.input === undefined ? item : await check(this.config.input, item, 'the input');
      const returned = await this.config.run(input as Json, context);

      if (!isShell(returned)) {
        const value = this.config.output === undefined || typeof this.config.output === 'string' ? returned : await check(this.config.output, returned, 'the value');

        return (value instanceof Uint8Array ? new Uint8Array(value) : value) as O;
      }
      const ran = await execute(returned.script, { env: { ARMADA_OUT: out } });

      if (ran.exitCode !== 0) throw new ShellError(returned.script, ran.exitCode, ran.stderr);
      const answered = await commandAnswer<O>(this.config.output, { exitCode: 0, tail: ran.stderr }, async () => {
        try {
          return new Uint8Array(readFileSync(out));
        } catch {
          return null;
        }
      });

      if (answered.kind === 'error') throw Object.assign(new Error(answered.error.message), { name: answered.error.name });

      return answered.value;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** In the container: the item through the input schema and the body, then its value through the output schema, or
   *  the command it returned. */
  readonly [RUN] = async (item: Json, context: Context): Promise<Envelope | Shell> => {
    try {
      const input = this.config.input === undefined ? item : await check(this.config.input, item, 'the input');
      const returned = await this.config.run(input as Json, context);

      if (isShell(returned)) return returned;
      const value = this.config.output === undefined || typeof this.config.output === 'string' ? returned : await check(this.config.output, returned, 'the value');

      return value instanceof Uint8Array ? { ok: true, bytes: Buffer.from(value).toString('base64') } : { ok: true, value: value as Json };
    } catch (cause) {
      return { ok: false, error: remoteError(cause) };
    }
  };
}

/** A command's answer: its `out` read as `output` says, once it exited 0. */
async function commandAnswer<O>(output: Output | undefined, outcome: Pick<Outcome, 'exitCode' | 'tail'> & { readonly value?: string }, read: () => Promise<Uint8Array | null>): Promise<{ readonly kind: 'ok'; readonly value: O } | { readonly kind: 'error'; readonly error: RemoteError }> {
  if (outcome.exitCode !== 0) return { kind: 'error', error: { name: 'Exit', message: `the command exited ${String(outcome.exitCode)}`, stack: outcome.tail } };

  if (output === undefined) return { kind: 'ok', value: null as O };

  if (output === 'bytes') return { kind: 'ok', value: (await read() ?? new Uint8Array()) as O };

  // An output too large for a string, or not the JSON its schema wants, is this item's error, not the job's.
  try {
    const text = outcome.value ?? new TextDecoder().decode(await read() ?? new Uint8Array());

    return { kind: 'ok', value: (output === 'text' ? text : await check(output, JSON.parse(text), 'the output')) as O };
  } catch (cause) {
    return { kind: 'error', error: remoteError(cause) };
  }
}

/** What a command run by the CLI writes to `$ARMADA_OUT` and answers with: its text, its bytes, or JSON a schema checks.
 *  Without it, the answer is null. */
interface CommandOptions extends TaskOptions {
  readonly output?: 'text' | 'bytes' | StandardSchemaV1;
}

/** An item's argv. */
type Argv<I> = (item: I, at: { readonly index: number }) => readonly string[];

/** The CLI's and `armada run`'s commands: each item's argv built here, from a command line with placeholders. */
class CommandTask<I, O> extends Base<I, O> {
  constructor(recipe: Recipe, private readonly argv: Argv<I>, private readonly cmdOptions: CommandOptions) {
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
    return await commandAnswer<O>(this.cmdOptions.output, outcome, read);
  }
}

/** A command over items for the CLI and `armada run`, its value its out file's text, or null. */
export function commandTask<I extends Json>(recipe: Recipe, argv: Argv<I>, options: TaskOptions & { readonly output: 'text' }): CommandTask<I, string>;
export function commandTask<I extends Json>(recipe: Recipe, argv: Argv<I>, options?: TaskOptions): CommandTask<I, null>;
export function commandTask<I extends Json>(recipe: Recipe, argv: Argv<I>, options: CommandOptions = {}): CommandTask<I, string | null> {
  return new CommandTask(recipe, argv, options);
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
    const values = results.flatMap((result) => result.ok ? [result.value] : []);

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

  /** The same as it downloads, for an output too large to hold in memory. */
  async outputStream(index: number): Promise<ReadableStream<Uint8Array> | null> {
    return await this.armada.outputStream(await this.id, index);
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

    if (outcome.kind === 'failed') return { ...base, ok: false, kind: outcome.reason === 'cancelled' ? 'cancelled' : 'lost', reason: outcome.tail };

    if (outcome.reason === 'timeout') return { ...base, ok: false, kind: 'timeout' };
    const answered = await this.task.answer(outcome, async () => await this.armada.output(id, outcome.index));

    return answered.kind === 'ok' ? { ...base, ok: true, ...answered } : { ...base, ok: false, ...answered };
  }
}

/** How long a job's reader waits when no outcome landed. */
const POLL_MS = 1_000;
