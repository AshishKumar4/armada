/**
 * armada's typed API. `task` defines one, by an id unique in its deployment: its body runs in a container on each item,
 * returning a value, or a `sh` command whose `out` file is the answer. `armada push` sends a project's task folder, and
 * `.map`, `.stream`, `.run` and `.local` run a task by its id.
 *
 *   export const square = task({ id: 'square', output: v.number(), run: (n: number) => n * n });
 *   const squares = await square.map([1, 2, 3]);   // number[], each checked by the output schema
 *
 * A result is typed by what checks it when it lands: the `output` schema, `'text'` or `'bytes'`. Without one, a body's
 * value is JSON and a command's answer is null.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { errorOf, jsonOf, JsonValueSchema, MAX_TASKS, RecipeSchema, type Retries, type JobStatus, type Outcome, type Recipe as RecipeSpec, type Size, type Task as WireTask } from './protocol';
import { pushed } from './push';
import { remoteError, RUN, secretsFrom, type Context, type Envelope, type Json, type RemoteError, type Runnable } from './runner';
import { connect, summaryOf, type Armada, type Summary } from './sdk';
import { execute, OutFile, quote, ShellError, ShellSchema, type Shell } from './sh';
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
    return this.append('setup', `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.map(quote).join(' ')}`);
  }

  /** More of setup, run as root once per environment. */
  setup(script: string): RecipeBuilder {
    return this.append('setup', script);
  }

  /** More of install, run as the user in the checkout once per environment. */
  install(script: string): RecipeBuilder {
    return this.append('install', script);
  }

  size(size: Size): RecipeBuilder {
    return new RecipeBuilder({ ...this.spec, size });
  }

  private append(script: 'setup' | 'install', step: string): RecipeBuilder {
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
  /** The tasks one container runs at once, each in its own slot. Default 1. */
  readonly slots?: number;
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
  /** Whether the task's artifacts directory was kept; `job.artifacts(index)` reads it. */
  readonly artifacts: boolean;
  /** Answered from the task's cache, with nothing run. */
  readonly cached: boolean;
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
    case 'cancelled':
    case 'lost': return `${result.kind}: ${result.reason}`;
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
  /** A job this task ran, by its id: its items come back as the JSON the job holds. */
  job(id: string, options?: Pick<MapOptions, 'armada'>): Job<Json, O>;
}

type InputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

type OutputOf<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/** What checks a task's answer when it lands: a command's `out` file read as text, or as bytes; a body's bytes; or JSON
 *  a schema checks, from a body's value or a command's `out`. Without one, a body's value is JSON. */
export type Output = 'text' | 'bytes' | StandardSchemaV1;

/** A task's value, as its `output` checks it: a command's `out` as text or bytes, a body's bytes, or what an output
 *  schema gives. Without an output, a body's value is JSON and a command's answer is null. */
export type Answer<R, Out> = Out extends 'bytes' ? Uint8Array
  : Out extends 'text' ? string
  : Out extends StandardSchemaV1 ? Arrived<OutputOf<Out>>
  : [R] extends [Shell] ? null : Json;

/** A task id's type: a string when the task's types travel, else a type naming the one that cannot, which the id then
 *  fails to be, so the error stands at the task's definition. Exported for the type tests. */
export type Checked<I, R, Out> = 0 extends 1 & I ? { readonly 'a task takes plain JSON, and this item type is any': I }
  : 0 extends 1 & R ? { readonly 'a task answers plain JSON or bytes, and this body returns any': R }
  : [I] extends [Plain<I>]
  ? [R] extends [Shell] ? OutputChecked<Out>
  : Out extends 'text' ? { readonly 'output text is a command\'s out file, for a body that returns sh': Out }
  : Out extends 'bytes' ? [R] extends [Uint8Array] ? string : { readonly 'output bytes is for a body that returns bytes or sh': R }
  : Out extends StandardSchemaV1 ? [R] extends [InputOf<Out>] ? OutputChecked<Out> : { readonly 'the body returns what its output schema does not take': R }
  : [R] extends [Plain<R>] ? string : { readonly 'a task answers plain JSON without an output, and this body returns something else': R }
  : { readonly 'a task takes plain JSON, and this item type is not': I };

/** A string when an output schema gives plain JSON or bytes, nothing as loose as `any` or `unknown`. */
type OutputChecked<Out> = Out extends StandardSchemaV1
  ? 0 extends 1 & OutputOf<Out> ? { readonly 'a task answers plain JSON or bytes, and this output schema gives any': OutputOf<Out> }
  : [OutputOf<Out>] extends [Value<OutputOf<Out>>] ? string
  : { readonly 'a task answers plain JSON or bytes, and this output schema gives neither': OutputOf<Out> }
  : string;

export interface TaskConfig<I, R, Out extends Output | undefined, Id = string, S extends string = string> {
  /** Unique in the deployment: `armada push` refuses a second task with it. */
  readonly id: Id;
  /** Default `recipe()`: `cloudflare/debian-trixie` on medium. A function is called only when a job is made, on the
   *  machine that makes it: the task's file also runs in each container, which has none of the files a recipe reads. */
  readonly recipe?: Recipe | RecipeBuilder | (() => Recipe | RecipeBuilder);
  readonly output?: Out;
  /** A task's limit, in seconds. Default 3600. */
  readonly timeout?: number;
  /** Lets an idle container run a straggler again, the first answer kept. Only for tasks safe to repeat. */
  readonly speculative?: boolean;
  /** Runs this many of a job's heaviest tasks twice from the start, the first answer kept. Only for tasks safe to repeat. */
  readonly hedge?: number;
  /** Runs a task again when it fails one of the named ways: an exit code, or an error its body threw, by name. */
  readonly retries?: Retries;
  /** The deployment's secrets the body gets in `context.secrets`, by name (`armada secret set <name>`). `.local` reads
   *  them from this machine's environment. */
  readonly secrets?: readonly S[];
  /** Keeps each green answer this many days: an item answered before, by the same push of the task in the same
   *  environment, comes back with `meta.cached` and runs nothing. Only for a task whose answer its item decides. */
  readonly cache?: { readonly days: number };
  readonly run: (input: I, context: Context<S>) => R | Promise<R>;
}

/**
 * A task. Export it from a file in the project's task folder (`armada.config.ts`), so `armada push` finds it. With an
 * `input` schema, callers pass its input and the body gets its output. A body's value, or a command's `out`, is checked
 * by the `output` before it counts as ok.
 */
// TypeScript first infers without a body whose parameters it must type itself, and checks the id then too: the
// defaults of I and R pass that check, so the body's own types decide it.
export function task<SI extends StandardSchemaV1, R = Shell, const Out extends Output | undefined = undefined, const S extends string = never>(config: TaskConfig<OutputOf<SI>, R, Out, NoInfer<Checked<InputOf<SI>, R, Out>>, S> & { readonly input: SI }): Task<InputOf<SI>, Answer<R, Out>>;
export function task<I = null, R = Shell, const Out extends Output | undefined = undefined, const S extends string = never>(config: TaskConfig<I, R, Out, NoInfer<Checked<I, R, Out>>, S> & { readonly input?: undefined }): Task<I, Answer<R, Out>>;
// Past the overloads' checks, the answer's checker is picked by the output: what the overloads type the answer as.
export function task(config: Config): Task<Json, Answer<unknown, Output | undefined>> {
  const settled = { ...config, id: String(config.id) };
  const { output } = config;

  if (output === undefined) return new PushedTask(settled, asJson);

  if (output === 'text') return new PushedTask(settled, asText);

  return output === 'bytes' ? new PushedTask(settled, asBytes) : new PushedTask(settled, bySchema(output));
}

/** A job's options of the task itself. */
interface TaskOptions {
  readonly timeout?: number;
  readonly speculative?: boolean;
  readonly hedge?: number;
  readonly retries?: Retries;
  readonly secrets?: readonly string[];
  readonly cache?: { readonly days: number };
}

/** A body's own answer, as its envelope brings it back or `.local` has it: JSON, or bytes. */
type Delivered = { readonly value: Json } | { readonly bytes: Uint8Array };

/** How a task's answer is checked into its type: a body's delivered value, and a command's `out` file, read only when
 *  the answer needs it, or the text a small one came inline as. Each throws when the answer does not fit. */
interface Answering<O> {
  value(delivered: Delivered): Promise<O>;
  out(read: () => Promise<Uint8Array | null>, inline: string | undefined): Promise<O>;
}

const text = async (read: () => Promise<Uint8Array | null>, inline: string | undefined): Promise<string> => inline ?? new TextDecoder().decode(await read() ?? new Uint8Array());

/** No output: a body's JSON value; a command answers null. */
const asJson: Answering<Json> = {
  value: async (delivered) => {
    if ('bytes' in delivered) throw new Error('the body answered bytes: give its task output \'bytes\'');

    return delivered.value;
  },
  out: async () => null,
};

/** A command run by the CLI without an output: it answers null. */
const asNull: Answering<null> = {
  value: async () => { throw new Error('a command answers no value'); },
  out: async () => null,
};

const asText: Answering<string> = {
  value: async () => { throw new Error('output text is a command\'s out file, for a body that returns sh'); },
  out: text,
};

const asBytes: Answering<Uint8Array> = {
  value: async (delivered) => {
    if (!('bytes' in delivered)) throw new Error('the body answered JSON, and its task\'s output is bytes');

    return delivered.bytes;
  },
  out: async (read) => await read() ?? new Uint8Array(),
};

/** An output schema's: a body's value, or a command's `out` as JSON, through it. */
function bySchema<S extends StandardSchemaV1>(schema: S): Answering<OutputOf<S>> {
  return {
    value: async (delivered) => await check(schema, 'bytes' in delivered ? delivered.bytes : delivered.value, 'the value'),
    out: async (read, inline) => await check(schema, v.parse(JsonValueSchema, JSON.parse(await text(read, inline))), 'the output'),
  };
}

/** What an exited task answered: its value, or the error that says why it has none. */
type Answered<O> = { readonly kind: 'ok'; readonly value: O } | { readonly kind: 'error'; readonly error: RemoteError };

/** An exited task's answer, checked by `answering`: a pushed body's envelope, or a command's `out` once it exited 0. */
async function answerOf<O>(answering: Answering<O>, outcome: Outcome, read: () => Promise<Uint8Array | null>): Promise<Answered<O>> {
  try {
    if (outcome.answer !== 'value') {
      if (outcome.exitCode !== 0) return { kind: 'error', error: { name: 'Exit', message: `the command exited ${String(outcome.exitCode)}`, stack: outcome.tail } };

      return { kind: 'ok', value: await answering.out(read, outcome.value) };
    }

    const bytes = outcome.value === undefined && outcome.output ? await read() : null;
    const said = outcome.value ?? (bytes === null ? null : new TextDecoder().decode(bytes));
    // A process that died before it answered left no envelope.
    const envelope = said === null ? null : v.safeParse(EnvelopeSchema, jsonOf(said));

    if (envelope?.success !== true) return { kind: 'error', error: { name: 'Exit', message: `the task's process exited ${String(outcome.exitCode)}`, stack: outcome.tail } };

    if (!envelope.output.ok) return { kind: 'error', error: envelope.output.error };
    const answered = envelope.output;

    return { kind: 'ok', value: await answering.value('bytes' in answered ? { bytes: new Uint8Array(Buffer.from(answered.bytes, 'base64')) } : { value: answered.value }) };
  } catch (cause) {
    // An answer too large for a string, or not what its output takes, is this item's error, not the job's.
    return { kind: 'error', error: remoteError(errorOf({ cause })) };
  }
}

/** How a job is created and its outcomes read, for one kind of task. */
abstract class Base<I extends Json, O> {
  constructor(private readonly recipeOf: () => Recipe, protected readonly options: TaskOptions, protected readonly answering: Answering<O>) {}

  protected get recipe(): Recipe {
    return this.recipeOf();
  }

  /** The job's `run` and whether it keeps each task's output. */
  protected abstract runOf(armada: Armada): Promise<{ readonly run: { readonly kind: 'command' } | { readonly kind: 'task'; readonly id: string; readonly bundle?: string | undefined }; readonly output: boolean }>;

  /** An item as a task, checked first. */
  protected abstract wire(item: I, index: number): Promise<WireTask>;

  async map(items: Iterable<I> | AsyncIterable<I>, options: MapOptions = {}): Promise<O[]> {
    return await this.stream(items, options).values();
  }

  stream(items: Iterable<I> | AsyncIterable<I>, options: MapOptions = {}): Job<I, O> {
    const armada = options.armada ?? connect();
    const submission = new Submission<I>(armada, async (submitting) => await this.submit(armada, items, submitting, options));

    return new Job(armada, this.answering, submission, async (_id, index) => await Promise.resolve(submission.item(index)));
  }

  async run(item: I, options?: MapOptions): Promise<O> {
    const [result] = await this.stream([item], options).settled();

    if (result?.ok !== true) throw new MapError(result === undefined ? [] : [result]);

    return result.value;
  }

  job(id: string, options: Pick<MapOptions, 'armada'> = {}): Job<Json, O> {
    const armada = options.armada ?? connect();
    let held: readonly Json[] = [];

    // The job's items as it holds them, read again when it grew past what was read.
    return new Job(armada, this.answering, new Submission<Json>(armada, async () => await Promise.resolve(id)), async (known, index) => {
      if (index >= held.length) held = await armada.items(known);

      return held[index] ?? null;
    });
  }

  /** Creates the job, all at once for an array and open for an iterable, whose items then follow in batches. */
  private async submit(armada: Armada, items: Iterable<I> | AsyncIterable<I>, submission: Submission<I>, options: MapOptions): Promise<string> {
    const { run, output } = await this.runOf(armada);
    const { commit, ...environment } = this.recipe;

    const spec = {
      recipe: environment, commit, run, output, pool: options.pool, slots: options.slots, label: options.label, env: options.env, files: options.files, tmpfs: options.tmpfs === undefined ? undefined : [...options.tmpfs],
      timeout: this.options.timeout, speculative: this.options.speculative, hedge: this.options.hedge, retries: this.options.retries,
      secrets: this.options.secrets === undefined ? undefined : [...this.options.secrets], cache: this.options.cache,
    };

    if (Array.isArray(items)) {
      const all: readonly I[] = items;

      if (all.length > MAX_TASKS) throw new Error(`a job takes at most ${String(MAX_TASKS)} items, not ${String(all.length)}`);
      const tasks = await Promise.all(all.map(async (item, index) => await this.wire(item, index)));
      const id = await armada.create({ ...spec, items: tasks });

      submission.sent.push(...all);

      return id;
    }

    const id = await armada.create({ ...spec, items: [], open: true });

    submission.pump(id, items, async (item, index) => await this.wire(item, index));

    return id;
  }
}

/**
 * How a job's items reach it: all at once, or streamed into an open job in batches that a timer flushes too, so a slow
 * source's items do not wait for the next one. A failure, or a cancel, stops it, and whoever reads the job learns of a
 * failure there.
 */
class Submission<I> {
  /** The items sent so far, in order. */
  readonly sent: I[] = [];

  readonly id: Promise<string>;

  failure: Error | null = null;

  private stopped = false;

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Work started in the background, each step's failure recorded: the job's creation watched, an open job's items
   *  sent, the timer's latest flush. */
  private readonly created: Promise<void>;

  private sending: Promise<void> | null = null;

  private ticked: Promise<void> | null = null;

  constructor(private readonly armada: Armada, create: (submission: Submission<I>) => Promise<string>) {
    this.id = create(this);
    // A failure reaches whoever reads the job, through its id or its end; this keeps it from also being unhandled.
    this.created = this.watch(this.id);
  }

  /** The item sent at `index`. */
  item(index: number): I {
    const item = this.sent[index];

    if (item === undefined) throw new Error(`the job answered item ${String(index)} before this client sent it`);

    return item;
  }

  /** Sends `items` into open job `id` as they come. */
  pump(id: string, items: Iterable<I> | AsyncIterable<I>, wire: (item: I, index: number) => Promise<WireTask>): void {
    let batch: WireTask[] = [];
    let flushing = Promise.resolve();

    const flush = async (): Promise<void> => {
      const sending = batch;

      batch = [];
      flushing = flushing.then(async () => { if (sending.length > 0) await this.armada.add(id, sending); });
      await flushing;
    };

    const enqueue = async (item: I): Promise<void> => {
      batch.push(await wire(item, this.sent.length));
      this.sent.push(item);

      if (batch.length >= BATCH) await flush();
    };

    this.timer = setInterval(() => { this.ticked = this.watch(flush()); }, BATCH_MS);
    this.sending = this.send(id, items, enqueue, flush);
  }

  /** Stops taking items: the job was cancelled, or a failure ended it. */
  stop(): void {
    this.stopped = true;

    if (this.timer !== null) clearInterval(this.timer);
  }

  private async send(id: string, items: Iterable<I> | AsyncIterable<I>, enqueue: (item: I) => Promise<void>, flush: () => Promise<void>): Promise<void> {
    try {
      for await (const item of items) {
        if (this.stopped) return;
        await enqueue(item);
      }

      await flush();
      await this.armada.close(id);
      this.stop();
    } catch (cause) {
      this.fail(errorOf({ cause }));
      await this.cancelAfter(id);
    }
  }

  /** Records a background step's failure instead of leaving it unhandled. */
  private async watch(step: Promise<unknown>): Promise<void> {
    try {
      await step;
    } catch (cause) {
      this.fail(errorOf({ cause }));
    }
  }

  /** Cancels the job a failure ended; a cancel that fails too is said in the failure. */
  private async cancelAfter(id: string): Promise<void> {
    try {
      await this.armada.cancel(id);
    } catch (cause) {
      const failed = this.failure ?? new Error('the job\'s items stopped');

      this.failure = new Error(`${failed.message}; cancelling job ${id} failed too: ${errorOf({ cause }).message}`, { cause: failed });
    }
  }

  private fail(failure: Error): void {
    this.failure ??= failure;
    this.stop();
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

/** A task's config, past the overloads' checks: its body takes JSON, or what its input schema gives. */
type Config = TaskConfig<unknown, unknown, Output | undefined, unknown> & { readonly input?: StandardSchemaV1 };

class PushedTask<O> extends Base<Json, O> implements Task<Json, O>, Runnable {
  readonly id: string;

  readonly secrets: readonly string[];

  constructor(private readonly config: Config & { readonly id: string }, answering: Answering<O>) {
    super(() => {
      const option = config.recipe;
      const given = v.is(v.function(), option) ? option() : option;

      return given instanceof RecipeBuilder ? given.spec : given ?? recipe().spec;
    }, config, answering);
    this.id = config.id;
    this.secrets = config.secrets ?? [];
  }

  protected async runOf(armada: Armada) {
    return { run: { kind: 'task' as const, id: this.id, bundle: await pushed(armada) ?? undefined }, output: true };
  }

  protected async wire(item: Json, index: number): Promise<WireTask> {
    if (this.config.input !== undefined) await check(this.config.input, item, `item ${String(index)}`);

    return { item };
  }

  /** On this machine: the same checks and body, a command run under this machine's `/bin/sh`. */
  async local(item: Json): Promise<O> {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-local-'));

    try {
      const out = join(scratch, 'out');
      const artifacts = join(scratch, 'artifacts');
      const given = secretsFrom(this.secrets, process.env);

      if ('missing' in given) throw new Error(`.local reads the secret ${given.missing} from this machine's environment, which lacks it`);
      mkdirSync(artifacts);
      const answer = await this.invoke(item, { index: 0, attempt: 1, signal: new AbortController().signal, out: new OutFile(out), files: scratch, secrets: given.secrets, artifacts });

      if (!v.is(ShellSchema, answer)) return await this.answering.value(answer);
      const ran = await execute(answer.script, { env: { ARMADA_OUT: out, ARMADA_ARTIFACTS: artifacts } });

      if (ran.exitCode !== 0) throw new ShellError(answer.script, ran.exitCode, ran.stderr);

      return await this.answering.out(async () => await readOut(out), undefined);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** In the container: the body's answer, its value checked by the output as the client will check it, or the command
   *  it returned. */
  readonly [RUN] = async (item: Json, context: Context): Promise<Envelope | Shell> => {
    try {
      const answer = await this.invoke(item, context);

      if (v.is(ShellSchema, answer)) return answer;
      await this.answering.value(answer);

      return 'bytes' in answer ? { ok: true, bytes: Buffer.from(answer.bytes).toString('base64') } : { ok: true, value: answer.value };
    } catch (cause) {
      return { ok: false, error: remoteError(errorOf({ cause })) };
    }
  };

  /** The item through the input schema and the body: the command it returned, or its value as JSON or bytes. */
  private async invoke(item: Json, context: Context): Promise<Delivered | Shell> {
    const input = this.config.input === undefined ? item : await check(this.config.input, item, 'the input');
    const returned = await this.config.run(input, context);

    if (v.is(ShellSchema, returned)) return returned;

    if (returned instanceof Uint8Array) return { bytes: new Uint8Array(returned) };
    const value = v.safeParse(JsonValueSchema, returned);

    if (!value.success) throw new Error(`the body's value is not JSON: ${v.summarize(value.issues)}`);

    return { value: value.output };
  }
}

/** A finished command's `out` file, or null when it wrote none. */
async function readOut(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null;

    throw cause;
  }
}

/** An item's argv. */
type Argv<I> = (item: I, at: { readonly index: number }) => readonly string[];

/** The CLI's and `armada run`'s commands: each item's argv built here, from a command line with placeholders. */
class CommandTask<I extends Json, O> extends Base<I, O> {
  constructor(environment: Recipe, private readonly argv: Argv<I>, options: TaskOptions, answering: Answering<O>) {
    super(() => environment, options, answering);
  }

  /** A command keeps its `out` file only when its answer reads it: one without an output answers null. */
  protected async runOf() {
    return await Promise.resolve({ run: { kind: 'command' as const }, output: this.answering !== asNull });
  }

  protected async wire(item: I, index: number): Promise<WireTask> {
    const argv = this.argv(item, { index });

    if (argv.length === 0) throw new Error(`item ${String(index)}'s argv is empty`);

    return await Promise.resolve({ item, argv: [...argv] });
  }
}

/** A command over items for the CLI and `armada run`, its value its out file's text, or null. */
export function commandTask<I extends Json>(environment: Recipe, argv: Argv<I>, options: TaskOptions & { readonly output: 'text' }): CommandTask<I, string>;
export function commandTask<I extends Json>(environment: Recipe, argv: Argv<I>, options?: TaskOptions): CommandTask<I, null>;
export function commandTask<I extends Json>(environment: Recipe, argv: Argv<I>, options: TaskOptions & { readonly output?: 'text' } = {}): CommandTask<I, string> | CommandTask<I, null> {
  return options.output === 'text' ? new CommandTask(environment, argv, options, asText) : new CommandTask(environment, argv, options, asNull);
}

/** A property key: what a schema issue's path segment is, when it is not an object naming one. */
const KeySchema = v.union([v.string(), v.number(), v.symbol()]);

export class SchemaError extends Error {
  constructor(what: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(`${what} does not fit its schema: ${issues.map((issue) => `${issue.path?.map((segment) => String(v.is(KeySchema, segment) ? segment : segment.key)).join('.') ?? ''}${issue.path === undefined ? '' : ': '}${issue.message}`).join('; ')}`);
    this.name = 'SchemaError';
  }
}

async function check<S extends StandardSchemaV1>(schema: S, value: Json | Uint8Array, what: string): Promise<OutputOf<S>> {
  const result = await schema['~standard'].validate(value);

  if (result.issues !== undefined) throw new SchemaError(what, result.issues);

  return result.value;
}

/** A job's results: in completion order by iterating it, or in input order. */
export class Job<I, O> implements AsyncIterable<Result<I, O>> {
  private readonly answers = new Map<number, Promise<Result<I, O>>>();

  readonly id: Promise<string>;

  /** `itemOf` gives an outcome's item: one this client sent, or one read from the job, which held it before it ran. */
  constructor(private readonly armada: Armada, private readonly answering: Answering<O>, private readonly submission: Submission<I>,
    private readonly itemOf: (id: string, index: number) => Promise<I>) {
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

  /** A task's artifacts directory as its stored tar.gz, or null when it kept none. */
  async artifacts(index: number): Promise<Uint8Array | null> {
    return await this.armada.artifacts(await this.id, index);
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

  private async resultOf(id: string, outcome: Outcome): Promise<Result<I, O>> {
    const item = await this.itemOf(id, outcome.index);

    const meta: Meta = {
      seconds: outcome.seconds, attempt: outcome.attempt, container: outcome.vessel, exitCode: outcome.exitCode, tail: outcome.tail, cached: outcome.cached === true, artifacts: outcome.artifacts === true,
      peakMemory: outcome.peakMemory, cpuSeconds: outcome.cpuSeconds,
    };

    const base = { index: outcome.index, item, meta };

    if (outcome.kind === 'failed') return { ...base, ok: false, kind: outcome.reason === 'cancelled' ? 'cancelled' : 'lost', reason: outcome.tail };

    if (outcome.reason === 'timeout') return { ...base, ok: false, kind: 'timeout' };
    const answered = await answerOf(this.answering, outcome, async () => await this.armada.output(id, outcome.index));

    return answered.kind === 'ok' ? { ...base, ok: true, ...answered } : { ...base, ok: false, ...answered };
  }
}

/** How long a job's reader waits when no outcome landed. */
const POLL_MS = 1_000;
