/**
 * ArmadaEstimates: what one class of task used, so a job packs the next ones into its containers (`placement.ts`). A
 * class is a pushed task's id, or a command's program, under one environment (`classOf`). Its object keeps the class's
 * last samples, one a run, and a record of each item it ran (`itemKey`): the item's own use, and whether it must run
 * alone. It answers with the class's estimate, which it alone computes, at its revision.
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

/** An item's record: its own use, its cores null until a run of it had its container to itself, and whether it runs
 *  alone (it failed beside other tasks, and passed alone). */
export interface ItemUsage extends Omit<Usage, 'cores'> {
  readonly cores: number | null;
  readonly alone: boolean;
}

/** One run's use, by the run (its job, task, attempt and vessel) and its item: a run delivered twice is one sample. A
 *  run `beside` other tasks shared its container's CPUs, so its cores say only what it was given, not what it needs. */
export interface Sample extends Usage {
  readonly run: string;
  readonly item: string;
  readonly beside: boolean;
}

/** A class's estimate, null below `MIN_SAMPLES`, and its revision, the newest sample it is of: of two answers, the one
 *  of the later revision is the newer, whichever arrives last. */
export interface Estimate {
  readonly usage: Usage | null;
  readonly revision: number;
}

/** What a class's object answers: its estimate and the records of the items asked for. */
export interface Reading {
  readonly estimate: Estimate;
  readonly items: Readonly<Record<string, ItemUsage>>;
}

/** The most parameters one statement of a Durable Object's SQL binds. */
const MAX_BINDINGS = 100;

/** The samples a class's estimate is of, its newest: enough for its quantiles, few enough to read whole at each
 *  answer. */
const SAMPLES = 200;

/** The runs a class keeps, far more than its estimate reads: a job sends again what a lost answer left, an alarm (15 s)
 *  later, and a class records nowhere near this many runs in that time, so the runs sent again are still here, and
 *  each counts once. */
const RUNS = 20_000;

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

/** What a task of a class is expected to use, from its samples: the 90th percentile of the cores of its runs `alone`, the
 *  95th of its memory and the most disk it wrote; null below `MIN_SAMPLES` of either. A task past its class's memory is
 *  killed and runs again alone (`placement.ts`), and its own record then holds what it used. */
export function classEstimate(samples: readonly Usage[], alone: readonly number[]): Usage | null {
  if (samples.length < MIN_SAMPLES || alone.length < MIN_SAMPLES) return null;

  return {
    cores: quantile(alone, 0.9), memory: quantile(samples.map((sample) => sample.memory), 0.95),
    disk: Math.max(...samples.map((sample) => sample.disk)),
  };
}

export class ArmadaEstimates extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY, run TEXT NOT NULL UNIQUE, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL,
      beside INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, cores REAL, memory REAL NOT NULL, disk REAL NOT NULL, alone INTEGER NOT NULL, at INTEGER NOT NULL)');
    // An earlier Worker recorded every run as if alone, and kept every item's cores.
    const samples = this.sql.exec<{ name: string }>('PRAGMA table_info(samples)').toArray().map((column) => column.name);

    if (!samples.includes('beside')) this.sql.exec('ALTER TABLE samples ADD COLUMN beside INTEGER NOT NULL DEFAULT 0');

    if (this.sql.exec<{ name: string; notnull: number }>('PRAGMA table_info(items)').toArray().some((column) => column.name === 'cores' && column.notnull === 1)) {
      this.sql.exec('CREATE TABLE items_kept (key TEXT PRIMARY KEY, cores REAL, memory REAL NOT NULL, disk REAL NOT NULL, alone INTEGER NOT NULL, at INTEGER NOT NULL)');
      this.sql.exec('INSERT INTO items_kept SELECT key, cores, memory, disk, alone, at FROM items');
      this.sql.exec('DROP TABLE items');
      this.sql.exec('ALTER TABLE items_kept RENAME TO items');
    }
  }

  /** The class's estimate, and the records of `items` it holds. */
  async read(items: readonly string[]): Promise<Reading> {
    const held: Record<string, ItemUsage> = {};

    // The platform's bound on one statement's parameters.
    for (let at = 0; at < items.length; at += MAX_BINDINGS) {
      const chunk = items.slice(at, at + MAX_BINDINGS);

      for (const row of this.sql.exec<{ key: string; cores: number | null; memory: number; disk: number; alone: number }>(
        `SELECT key, cores, memory, disk, alone FROM items WHERE key IN (${chunk.map(() => '?').join(', ')})`, ...chunk,
      ).toArray()) held[row.key] = { cores: row.cores, memory: row.memory, disk: row.disk, alone: row.alone === 1 };
    }

    return { estimate: this.estimate(), items: held };
  }

  /** What runs of the class used, and the items found to run alone; then the class's estimate. A run already recorded is
   *  not recorded again, so a delivery made twice (two sends at once, or one whose answer was lost) counts once. An item
   *  keeps the cores of its latest run alone, never of one beside others, which would pack it tighter each job; and the
   *  most memory and disk any run of it used, so a run that peaked once is packed for that peak. Once alone, it stays
   *  alone. */
  async record(samples: readonly Sample[], alone: readonly string[] = []): Promise<Estimate> {
    const now = Date.now();

    for (const sample of samples) {
      const fresh = this.sql.exec('INSERT OR IGNORE INTO samples (run, cores, memory, disk, beside) VALUES (?, ?, ?, ?, ?) RETURNING seq', sample.run, sample.cores, sample.memory, sample.disk, sample.beside ? 1 : 0).toArray();

      if (fresh.length === 0) continue;
      this.sql.exec(`INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT (key) DO UPDATE SET cores = COALESCE(excluded.cores, cores), memory = MAX(memory, excluded.memory), disk = MAX(disk, excluded.disk), at = excluded.at`,
      sample.item, sample.beside ? null : sample.cores, sample.memory, sample.disk, now);
    }

    for (const item of alone) {
      this.sql.exec(`INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (?, 0, 0, 0, 1, ?) ON CONFLICT (key) DO UPDATE SET alone = 1, at = excluded.at`, item, now);
    }

    this.sql.exec('DELETE FROM samples WHERE seq IN (SELECT seq FROM samples ORDER BY seq DESC LIMIT -1 OFFSET ?)', RUNS);
    this.sql.exec('DELETE FROM items WHERE key IN (SELECT key FROM items ORDER BY at DESC LIMIT -1 OFFSET ?)', ITEMS);

    return this.estimate();
  }

  /** The class's estimate from its newest samples, and the cores of its newest runs alone. A sample's `seq` only grows:
   *  the newest is never dropped. */
  private estimate(): Estimate {
    const newest = this.sql.exec<{ seq: number; cores: number; memory: number; disk: number }>('SELECT seq, cores, memory, disk FROM samples ORDER BY seq DESC LIMIT ?', SAMPLES).toArray();
    const alone = this.sql.exec<{ cores: number }>('SELECT cores FROM samples WHERE beside = 0 ORDER BY seq DESC LIMIT ?', SAMPLES).toArray().map((row) => row.cores);

    return { usage: classEstimate(newest, alone), revision: newest[0]?.seq ?? 0 };
  }
}
