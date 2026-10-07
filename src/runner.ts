/**
 * What a function's bundle runs in a container: the task's item from `ARMADA_ITEM` through its function, and the
 * answer, a value or an error, written to `ARMADA_OUT`. The client reads that file back as the task's result.
 */
import { writeFileSync } from 'node:fs';
import { FILES_DIR, OUT_PATH, type Json } from './protocol';

/** The method a function task answers a container's call by. A registered symbol, so a bundle holding a second copy of
 *  this module still finds it. */
export const RUN: unique symbol = Symbol.for('armada.run');

/** What a function gets beside its input. */
export interface Context {
  /** The item's position in the job. */
  readonly index: number;
  /** 1, or 2 when the platform lost the first attempt. */
  readonly attempt: number;
  /** Aborted when the task is cancelled or passes its timeout. */
  readonly signal: AbortSignal;
  /** The directory holding the job's `files`. */
  readonly files: string;
}

export interface RemoteError {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
}

/** A function's answer as the container writes it: its value, its bytes in base64, or the error it threw. */
export type { Json };

export type Envelope = { readonly ok: true; readonly value: Json } | { readonly ok: true; readonly bytes: string } | { readonly ok: false; readonly error: RemoteError };

export interface Runnable {
  readonly [RUN]: (item: Json, context: Context) => Promise<Envelope>;
}

export function remoteError(cause: unknown): RemoteError {
  return cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack ?? '' } : { name: 'Error', message: String(cause), stack: '' };
}

/** Runs `task` on this container's item and exits, 1 when it failed, so the job counts it red: a handler's leftover
 *  timers or sockets do not hold the task open. */
export async function runTask(task: Runnable): Promise<never> {
  const controller = new AbortController();

  process.once('SIGTERM', () => { controller.abort(new Error('the task was stopped')); });
  const context: Context = { index: Number(process.env['ARMADA_INDEX'] ?? '0'), attempt: Number(process.env['ARMADA_ATTEMPT'] ?? '1'), signal: controller.signal, files: FILES_DIR };
  const item = JSON.parse(process.env['ARMADA_ITEM'] ?? 'null') as Json;

  const envelope = await task[RUN](item, context);

  writeFileSync(process.env['ARMADA_OUT'] ?? OUT_PATH, JSON.stringify(envelope));
  process.exit(envelope.ok ? 0 : 1);
}
