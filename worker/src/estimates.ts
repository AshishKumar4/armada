/**
 * ArmadaEstimates: what one class of task used, so a job packs the next ones into its containers (`placement.ts`). A
 * class is a pushed task's id, or a command's program, under one environment (`classOf`). Its object keeps the class's
 * last samples, one a run, and a record of each item it ran (`itemKey`): the item's own use, and whether it must run
 * alone. It answers with the class's estimate, which it alone computes.
 */
import { DurableObject } from 'cloudflare:workers';
import { canonical, sha256, SIZES, type JobSpec, type Size, type Task } from '../../src/protocol';
import type { Env } from './env';

/** What a task used, or is expected to use: its cores (CPU seconds over wall seconds), its peak memory and its disk, in
 *  bytes. */
export interface Usage {
  readonly cores: number;
  readonly memory: number;
  readonly disk: number;
}

/** An item's record: its own use, and whether it runs alone (it failed beside other tasks, and passed alone). */
export interface ItemUsage extends Usage {
  readonly alone: boolean;
}

/** One run's use, by the run (`runOf`) and its item: a run delivered twice is one sample. */
export interface Sample extends Usage {
  readonly run: string;
  readonly item: string;
}

/** What a class's object answers: its estimate, null below `MIN_SAMPLES`, and the records of the items asked for. */
export interface Reading {
  readonly estimate: Usage | null;
  readonly items: Readonly<Record<string, ItemUsage>>;
}

/** The samples a class keeps: enough for its quantiles, few enough to read whole at each answer. */
const SAMPLES = 200;

/** The item records a class keeps, the least recently run dropped first. */
const ITEMS = 20_000;

/** The fewest samples a class is estimated from: below it, a task of the class runs alone and is measured. */
export const MIN_SAMPLES = 8;

/** The memory a container keeps for itself beside its tasks: its main process, the runner's execs, a gang's relay. */
const SYSTEM_MEMORY = 512 * 2 ** 20;

/** The class of `task` in a job of `spec` on environment `key`: a pushed task's id, else its command's program and first
 *  argument, under the environment. */
export function classOf(spec: Pick<JobSpec, 'run'>, task: Task, key: string): string {
  if (spec.run.kind === 'task') return `task ${spec.run.id} ${key}`;

  return `command ${JSON.stringify((task.argv ?? []).slice(0, 2))} ${key}`;
}

/** An item's key in its class: its item and argv, whatever their keys' order. */
export async function itemKey(task: Task): Promise<string> {
  return await sha256(canonical({ item: task.item, argv: task.argv === undefined ? null : [...task.argv] }));
}

/** The memory every task of a container holds together, at most: the cgroup over all of them is capped at it, so a
 *  container whose tasks outgrew their estimates has one of them killed, never its own processes (`container.ts`). */
export const tasksMemoryOf = (size: Size): number => SIZES[size].memoryGiB * 2 ** 30 - SYSTEM_MEMORY;

/** What a container's tasks may be estimated to use together: every vCPU, since estimates are of cores at their 90th
 *  percentile; and of memory and disk, a margin under what it holds, since a task's use varies from its class's. */
export function roomOf(size: Size): Usage {
  return { cores: SIZES[size].vcpus, memory: tasksMemoryOf(size) * 0.85, disk: SIZES[size].diskGB * 1e9 * 0.8 };
}

/** The `fraction` quantile of `values`, by rank. */
const quantile = (values: readonly number[], fraction: number): number => values.toSorted((left, right) => left - right)[Math.min(values.length - 1, Math.floor(fraction * values.length))] ?? 0;

/** What a task of a class is expected to use, from its samples: the 90th percentile of its cores, the 95th of its
 *  memory and the most disk it wrote; null below `MIN_SAMPLES`. A task past its class's memory is killed and runs again
 *  alone (`placement.ts`), and its own record then holds what it used. */
export function classEstimate(samples: readonly Usage[]): Usage | null {
  if (samples.length < MIN_SAMPLES) return null;

  return {
    cores: quantile(samples.map((sample) => sample.cores), 0.9), memory: quantile(samples.map((sample) => sample.memory), 0.95),
    disk: Math.max(...samples.map((sample) => sample.disk)),
  };
}

export class ArmadaEstimates extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec('CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL UNIQUE, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL, alone INTEGER NOT NULL, at INTEGER NOT NULL)');
  }

  /** The class's estimate, and the records of `items` it holds. */
  async read(items: readonly string[]): Promise<Reading> {
    const held: Record<string, ItemUsage> = {};

    // A bound well inside SQLite's on one statement's parameters.
    for (let at = 0; at < items.length; at += 500) {
      const chunk = items.slice(at, at + 500);

      for (const row of this.sql.exec<{ key: string; cores: number; memory: number; disk: number; alone: number }>(
        `SELECT key, cores, memory, disk, alone FROM items WHERE key IN (${chunk.map(() => '?').join(', ')})`, ...chunk,
      ).toArray()) held[row.key] = { cores: row.cores, memory: row.memory, disk: row.disk, alone: row.alone === 1 };
    }

    return { estimate: this.estimate(), items: held };
  }

  /** What runs of the class used, and the items found to run alone; then the class's estimate. A run already recorded is
   *  not recorded again, so a delivery made twice (two sends at once, or one whose answer was lost) counts once. An item
   *  keeps its latest cores and the most memory and disk any run of it used, so a run that peaked once is packed for
   *  that peak; once alone, it stays alone. */
  async record(samples: readonly Sample[], alone: readonly string[] = []): Promise<Usage | null> {
    const now = Date.now();

    for (const sample of samples) {
      const fresh = this.sql.exec('INSERT OR IGNORE INTO samples (run, cores, memory, disk) VALUES (?, ?, ?, ?) RETURNING seq', sample.run, sample.cores, sample.memory, sample.disk).toArray();

      if (fresh.length === 0) continue;
      this.sql.exec(`INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT (key) DO UPDATE SET cores = excluded.cores, memory = MAX(memory, excluded.memory), disk = MAX(disk, excluded.disk), at = excluded.at`,
      sample.item, sample.cores, sample.memory, sample.disk, now);
    }

    for (const item of alone) {
      this.sql.exec(`INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (?, 0, 0, 0, 1, ?) ON CONFLICT (key) DO UPDATE SET alone = 1, at = excluded.at`, item, now);
    }

    this.sql.exec('DELETE FROM samples WHERE seq <= (SELECT MAX(seq) FROM samples) - ?', SAMPLES);
    this.sql.exec('DELETE FROM items WHERE key IN (SELECT key FROM items ORDER BY at DESC LIMIT -1 OFFSET ?)', ITEMS);

    return this.estimate();
  }

  /** The class's estimate from its newest samples. */
  private estimate(): Usage | null {
    return classEstimate(this.sql.exec<{ cores: number; memory: number; disk: number }>('SELECT cores, memory, disk FROM samples ORDER BY seq DESC LIMIT ?', SAMPLES).toArray());
  }
}
