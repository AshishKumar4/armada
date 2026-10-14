/**
 * ArmadaTimings: what a project's graded runs measured, to weigh its next plan. A graded run reports each green row's
 * seconds and each file's; a red or hung row reports nothing, so a hang never becomes an estimate. It also reports the
 * most one task used, and the next run reads the most of the last runs, to pick its size.
 *
 * Each row and each file keeps its samples under a key of its own (`row:`, `file:`): one value holding them all
 * outgrew the platform's 2 MB per value at Kinu's 103 rows and their files, and the run's timings were refused with
 * SQLITE_TOOBIG (#43).
 */
import { DurableObject } from 'cloudflare:workers';
import { medians, recordSamples, type Timings } from '../../src/protocol';
import type { Env } from './env';

/** The most keys one storage call takes. */
const KEYS_A_CALL = 128;

/** The one value every sample was kept in before #43, split into keys of their own the first time it is read. */
interface History {
  readonly rows: Record<string, number[]>;
  readonly files: Record<string, number[]>;
  readonly usage?: Record<string, number[]>;
}

function chunks<T>(items: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / KEYS_A_CALL) }, (_, at) => items.slice(at * KEYS_A_CALL, (at + 1) * KEYS_A_CALL));
}

export class ArmadaTimings extends DurableObject<Env> {
  async record(timings: Timings): Promise<void> {
    await this.#split();
    const keyed = { ...prefixed('row:', timings.rows), ...prefixed('file:', timings.files) };
    const held = new Map<string, number[]>();

    for (const keys of chunks(Object.keys(keyed))) {
      for (const [key, samples] of await this.ctx.storage.get<number[]>(keys)) held.set(key, samples);
    }

    const next = recordSamples(Object.fromEntries(held), keyed);

    for (const keys of chunks(Object.keys(next))) await this.ctx.storage.put(Object.fromEntries(keys.map((key) => [key, next[key]])));

    if (timings.usage !== undefined && timings.usage !== null) {
      await this.ctx.storage.put('usage', recordSamples(await this.ctx.storage.get<Record<string, number[]>>('usage') ?? {}, timings.usage));
    }
  }

  async estimates(): Promise<Timings> {
    await this.#split();
    const { memory = [], cores = [] } = await this.ctx.storage.get<Record<string, number[]>>('usage') ?? {};

    return {
      rows: medians(await this.#samples('row:')), files: medians(await this.#samples('file:')),
      usage: memory.length === 0 ? null : { memory: Math.max(...memory), cores: Math.max(...cores) },
    };
  }

  async #samples(prefix: string): Promise<Record<string, number[]>> {
    const listed = await this.ctx.storage.list<number[]>({ prefix });

    return Object.fromEntries([...listed].map(([key, samples]) => [key.slice(prefix.length), samples]));
  }

  async #split(): Promise<void> {
    const history = await this.ctx.storage.get<History>('history');

    if (history === undefined) return;
    const keyed = { ...prefixed('row:', history.rows), ...prefixed('file:', history.files) };

    for (const keys of chunks(Object.keys(keyed))) await this.ctx.storage.put(Object.fromEntries(keys.map((key) => [key, keyed[key]])));

    if (history.usage !== undefined) await this.ctx.storage.put('usage', history.usage);
    await this.ctx.storage.delete('history');
  }
}

function prefixed<T>(prefix: string, record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [prefix + key, value]));
}
