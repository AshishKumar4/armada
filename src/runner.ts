/**
 * What the pushed tasks' bundle runs in a container: the task `ARMADA_TASK` names, on the item in `ARMADA_ITEM`. A body
 * that returns a value or throws is answered with an envelope in `ARMADA_OUT`; a body that returns `sh` is a command,
 * which runs here and writes `ARMADA_OUT` itself. `ARMADA_ANSWER` says which, for the client to read it by.
 */
import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { ANSWER_PATH, ARTIFACTS_PATH, FILES_DIR, JsonSchema, OUT_PATH, type Json } from './protocol';
import { execute, OutFile, ShellSchema, type Shell } from './sh';

/** The method a task answers a container's call by. A registered symbol, so a bundle holding a second copy of this
 *  module still finds it. */
export const RUN: unique symbol = Symbol.for('armada.run');

/** What a body gets beside its input: `S` is the names of the secrets its task asks for. */
export interface Context<S extends string = string> {
  /** The item's position in the job. */
  readonly index: number;
  /** 1, or more when the platform lost an attempt. */
  readonly attempt: number;
  /** Aborted when the task is stopped. */
  readonly signal: AbortSignal;
  /** The file a command answers with. */
  readonly out: OutFile;
  /** The directory holding the job's `files`. */
  readonly files: string;
  /** The directory whose contents the job keeps as the task's artifacts once it finishes. */
  readonly artifacts: string;
  /** The deployment's secrets the task asked for, by name. A command gets each in its environment too. */
  readonly secrets: Readonly<Record<S, string>>;
}

export interface RemoteError {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

export type { Json };

/** A body's answer as the container writes it: its value, its bytes in base64, or the error it threw. */
export type Envelope = { readonly ok: true; readonly value: Json } | { readonly ok: true; readonly bytes: string } | { readonly ok: false; readonly error: RemoteError };

export interface Runnable {
  readonly id: string;
  /** The secrets it asks for, which its container has in its environment. */
  readonly secrets: readonly string[];
  readonly [RUN]: (item: Json, context: Context) => Promise<Envelope | Shell>;
}

export function remoteError(error: Error): RemoteError {
  return { name: error.name, message: error.message, stack: error.stack ?? '' };
}

/** The secrets `names` from `env`, or the first name it lacks. */
export function secretsFrom(names: readonly string[], env: NodeJS.ProcessEnv): { readonly secrets: Record<string, string> } | { readonly missing: string } {
  const secrets: Record<string, string> = {};

  for (const name of names) {
    const value = env[name];

    if (value === undefined) return { missing: name };
    secrets[name] = value;
  }

  return { secrets };
}

/** A module's export that is a task, made by this module or another copy of it: a push reads task files for them. */
export const RunnableSchema = v.custom<Runnable>((value) => v.is(v.looseObject({ id: v.string(), secrets: v.array(v.string()) }), value) && RUN in value);

/** Runs the task `ARMADA_TASK` names among `tasks`, the ones the bundle's files export, and exits: 1 when its body
 *  threw, a command's own exit code, so the job counts each red. A body's leftover timers or sockets do not hold the
 *  task open. */
export async function runTasks(tasks: readonly Runnable[]): Promise<never> {
  const id = process.env['ARMADA_TASK'] ?? '';
  const task = tasks.find((each) => each.id === id);

  if (task === undefined) {
    console.error(`armada: no task ${id} in this bundle`);
    process.exit(1);
  }

  const controller = new AbortController();

  process.once('SIGTERM', () => { controller.abort(new Error('the task was stopped')); });
  const out = process.env['ARMADA_OUT'] ?? OUT_PATH;
  const given = secretsFrom(task.secrets, process.env);

  // Only a secret deleted after its job started is missing here: the job is refused one that is not set.
  if ('missing' in given) {
    console.error(`armada: the secret ${given.missing} was deleted; set it again with armada secret set ${given.missing}`);
    process.exit(1);
  }

  const context: Context = {
    index: Number(process.env['ARMADA_INDEX'] ?? '0'), attempt: Number(process.env['ARMADA_ATTEMPT'] ?? '1'), signal: controller.signal, out: new OutFile(out), files: FILES_DIR,
    artifacts: process.env['ARMADA_ARTIFACTS'] ?? ARTIFACTS_PATH, secrets: given.secrets,
  };

  const answer = await task[RUN](v.parse(JsonSchema, JSON.parse(process.env['ARMADA_ITEM'] ?? 'null')), context);
  const marker = process.env['ARMADA_ANSWER'] ?? ANSWER_PATH;

  if (v.is(ShellSchema, answer)) {
    writeFileSync(marker, 'command');
    process.exit((await execute(answer.script, { signal: controller.signal, inherit: true })).exitCode);
  }

  // The error's name follows, for the job to decide a retry by.
  writeFileSync(marker, answer.ok ? 'value' : `value\n${answer.error.name}`);
  writeFileSync(out, JSON.stringify(answer));
  process.exit(answer.ok ? 0 : 1);
}
