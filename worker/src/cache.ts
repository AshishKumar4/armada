/**
 * A pushed task's cache: a green answer's output kept under its bundle, task, environment and item (`cacheKey`), so a
 * later job's item like it is answered with nothing run. The job writes an answer once it is the task's final verdict
 * (`keep`) and reads one before it queues the item (`answer`). Either failing costs only a rerun: a cache is never the
 * reason a task fails.
 */
import { cacheKey, INLINE_BYTES, type Json, type Outcome } from '../../src/protocol';
import { said, textOf } from './env';

const DAY_MS = 24 * 60 * 60_000;

/** What a pushed task's cached answers are keyed by beside the item: its bundle, its id and its environment. */
export interface CacheScope {
  readonly bundle: string;
  readonly task: string;
  readonly environment: string;
}

/** A green answer to keep (`keep`). */
interface Kept {
  readonly item: Json;
  readonly days: number;
  readonly output: string;
  readonly marker: Outcome['answer'];
}

/** The cached answer of `item` as task `index`'s outcome, with the key its output is read from; or null when the cache
 *  holds none, or, said in the log, could not be read. A small answer rides in the outcome; a large one is read where
 *  it is cached. */
export async function answer(bucket: R2Bucket, scope: CacheScope, index: number, item: Json): Promise<{ readonly outcome: Outcome; readonly key: string } | null> {
  try {
    const key = await cacheKey(scope.bundle, scope.task, scope.environment, item);
    const cached = await bucket.head(key);

    if (cached === null || Number(cached.customMetadata?.['expires'] ?? 0) < Date.now()) return null;
    const small = cached.size <= INLINE_BYTES ? await (await bucket.get(key))?.arrayBuffer() : undefined;
    const marker = cached.customMetadata?.['answer'];

    const outcome: Outcome = {
      index, kind: 'exited', exitCode: 0, seconds: 0, vessel: 'cache', attempt: 0, tail: '', output: true, cached: true,
      value: small === undefined ? undefined : textOf(small), answer: marker === 'value' || marker === 'command' ? marker : undefined,
    };

    return { outcome, key };
  } catch (cause) {
    console.error(JSON.stringify({ index, cache: said({ cause }) }));

    return null;
  }
}

/** `item`'s green answer, whose output is at `output` and says what it is (`marker`), kept `days`; said in the log
 *  when it cannot be. Streamed at its known size when it is too large to read whole. */
export async function keep(bucket: R2Bucket, scope: CacheScope, { item, days, output, marker }: Kept): Promise<void> {
  try {
    const source = await bucket.get(output);

    if (source === null) return;
    const key = await cacheKey(scope.bundle, scope.task, scope.environment, item);
    const options = { httpMetadata: source.httpMetadata, customMetadata: { expires: String(Date.now() + days * DAY_MS), answer: marker ?? '' } };

    if (source.size <= INLINE_BYTES) {
      await bucket.put(key, await source.arrayBuffer(), options);

      return;
    }

    const known = new FixedLengthStream(source.size);

    await Promise.all([source.body.pipeTo(known.writable), bucket.put(key, known.readable, options)]);
  } catch (cause) {
    console.error(JSON.stringify({ output, cache: said({ cause }) }));
  }
}
