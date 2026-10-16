/**
 * ArmadaTimings: what a project's graded runs measured, to weigh its next plan. A graded run reports each green row's
 * seconds and each file's; a red or hung row reports nothing, so a hang never becomes an estimate. It also reports the
 * most one task used, and the next run reads the most of the last runs, to pick its size.
 *
 * Each row and each file keeps its samples under a key of its own (`row:`, `file:`): one value holding them all
 * outgrew the platform's 2 MB per value at Kinu's 103 rows and their files, and the run's timings were refused with
 * SQLITE_TOOBIG (#43).
 *
 * A full run names what its project keeps: the rows its plan named and the files its commit holds, and the others go.
 * What a plan reads goes into each of its run's jobs, in the job's stored spec, so it is one plan's rows and one
 * commit's files, never every name a project ran: on 2026-10-16 Kinu's hammer rows, each named by the files a change
 * touched, made it 8.5 MB, and every `armada run` was refused with SQLITE_TOOBIG.
 */
import { DurableObject } from 'cloudflare:workers';
import { medians, recordSamples, type Recorded, type Timings } from '../../src/protocol';
import type { Env } from './env';

/** The most keys one storage call takes. */
const KEYS_A_CALL = 128;

function chunks<T>(items: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / KEYS_A_CALL) }, (_, at) => items.slice(at * KEYS_A_CALL, (at + 1) * KEYS_A_CALL));
}

export class ArmadaTimings extends DurableObject<Env> {
  async record({ keep, ...timings }: Recorded): Promise<void> {
    await this.#dropUnnamed();
    const keyed = { ...prefixed('row:', timings.rows), ...prefixed('file:', timings.files) };

    if (keep !== undefined) {
      const kept = new Set([...keep.rows.map((row) => `row:${row}`), ...keep.files.map((file) => `file:${file}`), ...Object.keys(keyed)]);
      const stored = [...(await this.ctx.storage.list({ prefix: 'row:' })).keys(), ...(await this.ctx.storage.list({ prefix: 'file:' })).keys()];

      for (const keys of chunks(stored.filter((key) => !kept.has(key)))) await this.ctx.storage.delete(keys);
    }

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
    await this.#dropUnnamed();
    const { memory = [], cores = [] } = await this.ctx.storage.get<Record<string, number[]>>('usage') ?? {};

    return {
      rows: medians(await this.#samples('row:')), files: medians(await this.#samples('file:')),
      usage: memory.length === 0 ? null : { memory: Math.max(...memory), cores: Math.max(...cores) },
    };
  }

  /** The rows and files an earlier Worker kept, every one a run ever recorded, which go once, before this store first
   *  answers. Nothing else comes in meanwhile. */
  async #dropUnnamed(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>('named')) === true) return;

    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>('named')) === true) return;
      const kept = [...(await this.ctx.storage.list({ prefix: 'row:' })).keys(), ...(await this.ctx.storage.list({ prefix: 'file:' })).keys()];

      for (const keys of chunks(kept)) await this.ctx.storage.delete(keys);
      await this.ctx.storage.put('named', true);
    });
  }

  async #samples(prefix: string): Promise<Record<string, number[]>> {
    const listed = await this.ctx.storage.list<number[]>({ prefix });

    return Object.fromEntries([...listed].map(([key, samples]) => [key.slice(prefix.length), samples]));
  }
}

function prefixed<T>(prefix: string, record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [prefix + key, value]));
}
