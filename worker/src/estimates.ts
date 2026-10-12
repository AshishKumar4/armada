/**
 * ArmadaEstimates: what one class of task used, so a job packs the next ones into its containers (`job.ts`). A class is
 * a pushed task's id, or a command's program, under one environment (`classOf`). Its object keeps the class's last
 * samples, and a record of each item it ran (`itemKey`): the item's own use, and whether it must run alone. A job
 * reads them once its environment is ready, and adds what its tasks used as they land.
 */
import { DurableObject } from 'cloudflare:workers';
import { canonical, type Json, type JobSpec, type Task } from '../../src/protocol';
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

/** One landed task's use, by its item. */
export interface Sample extends Usage {
  readonly item: string;
}

/** A class's last samples, and the records of the items asked for that it holds. */
export interface Estimates {
  readonly samples: readonly Usage[];
  readonly items: Readonly<Record<string, ItemUsage>>;
}

/** The samples a class keeps: enough for its quantiles, few enough to read whole at each job's start. */
const SAMPLES = 200;

/** The item records a class keeps, the least recently run dropped first. */
const ITEMS = 20_000;

/** The fewest samples a class is estimated from: below it, a task of the class runs alone and is measured. */
export const MIN_SAMPLES = 8;

/** The class of `task` in a job of `spec` on environment `key`: a pushed task's id, else its command's program and first
 *  argument, under the environment. */
export function classOf(spec: Pick<JobSpec, 'run'>, task: Task, key: string): string {
  if (spec.run.kind === 'task') return `task ${spec.run.id} ${key}`;

  return `command ${JSON.stringify((task.argv ?? []).slice(0, 2))} ${key}`;
}

/** An item's key in its class: its item and argv, whatever their keys' order. */
export async function itemKey(task: Task): Promise<string> {
  const value: Json = { item: task.item, argv: task.argv === undefined ? null : [...task.argv] };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The `fraction` quantile of `values`, by rank. */
const quantile = (values: readonly number[], fraction: number): number => values.toSorted((left, right) => left - right)[Math.min(values.length - 1, Math.floor(fraction * values.length))] ?? 0;

/** What a task of a class is expected to use, from its samples: the 90th percentile of its cores, the 95th of its
 *  memory and the most disk it wrote; null below `MIN_SAMPLES`. A task past its class's memory is killed and runs again
 *  alone (`job.ts`), and its own record then holds what it used. */
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
    this.sql.exec('CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY AUTOINCREMENT, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL, alone INTEGER NOT NULL, at INTEGER NOT NULL)');
  }

  /** The class's last samples, and the records of `items` it holds. */
  async read(items: readonly string[]): Promise<Estimates> {
    const samples = this.sql.exec<{ cores: number; memory: number; disk: number }>('SELECT cores, memory, disk FROM samples ORDER BY seq DESC LIMIT ?', SAMPLES).toArray();
    const held: Record<string, ItemUsage> = {};

    // A bound well inside SQLite's on one statement's parameters.
    for (let at = 0; at < items.length; at += 500) {
      const chunk = items.slice(at, at + 500);

      for (const row of this.sql.exec<{ key: string; cores: number; memory: number; disk: number; alone: number }>(
        `SELECT key, cores, memory, disk, alone FROM items WHERE key IN (${chunk.map(() => '?').join(', ')})`, ...chunk,
      ).toArray()) held[row.key] = { cores: row.cores, memory: row.memory, disk: row.disk, alone: row.alone === 1 };
    }

    return { samples: samples.map(({ cores, memory, disk }) => ({ cores, memory, disk })), items: held };
  }

  /** What tasks of the class used, and the items found to run alone. An item keeps its latest cores and the most memory
   *  and disk any run of it used, so a run that peaked once is packed for that peak; once alone, it stays alone. */
  async record(samples: readonly Sample[], alone: readonly string[] = []): Promise<void> {
    const now = Date.now();

    for (const sample of samples) {
      this.sql.exec('INSERT INTO samples (cores, memory, disk) VALUES (?, ?, ?)', sample.cores, sample.memory, sample.disk);
      this.sql.exec(`INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT (key) DO UPDATE SET cores = excluded.cores, memory = MAX(memory, excluded.memory), disk = MAX(disk, excluded.disk), at = excluded.at`,
      sample.item, sample.cores, sample.memory, sample.disk, now);
    }

    for (const item of alone) {
      this.sql.exec(`INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (?, 0, 0, 0, 1, ?) ON CONFLICT (key) DO UPDATE SET alone = 1, at = excluded.at`, item, now);
    }

    this.sql.exec('DELETE FROM samples WHERE seq <= (SELECT MAX(seq) FROM samples) - ?', SAMPLES);
    this.sql.exec('DELETE FROM items WHERE key IN (SELECT key FROM items ORDER BY at DESC LIMIT -1 OFFSET ?)', ITEMS);
  }
}

/** A job's own record of what its tasks' classes used: the samples each class's store gave it and those its tasks
 *  landed with, which estimate its tasks still to run, and those, and the items found to run alone, not yet sent to the
 *  store. In the job's storage, beside its tasks, as `Runs` is. */
export class Learned {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS learned (seq INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, item TEXT, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL, sent INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS alone (class TEXT NOT NULL, item TEXT NOT NULL, sent INTEGER NOT NULL, PRIMARY KEY (class, item))');
  }

  /** The samples `cls`'s store holds, kept as sent: once a job, so a class read again is not counted twice. */
  seed(cls: string, samples: readonly Usage[]): void {
    if (this.sql.exec('SELECT 1 AS n FROM learned WHERE class = ? AND item IS NULL LIMIT 1', cls).toArray().length > 0) return;

    for (const sample of samples) this.sql.exec('INSERT INTO learned (class, item, cores, memory, disk, sent) VALUES (?, NULL, ?, ?, ?, 1)', cls, sample.cores, sample.memory, sample.disk);
  }

  /** What a task of `cls` running `item` used, to learn from and to send. */
  add(cls: string, item: string, usage: Usage): void {
    this.sql.exec('INSERT INTO learned (class, item, cores, memory, disk, sent) VALUES (?, ?, ?, ?, ?, 0)', cls, item, usage.cores, usage.memory, usage.disk);
  }

  /** `item` of `cls` runs alone from now on, here and in the jobs after. */
  alone(cls: string, item: string): void {
    this.sql.exec('INSERT OR IGNORE INTO alone (class, item, sent) VALUES (?, ?, 0)', cls, item);
  }

  /** `cls`'s estimate from the newest samples this job holds of it. */
  estimate(cls: string): Usage | null {
    return classEstimate(this.sql.exec<{ cores: number; memory: number; disk: number }>('SELECT cores, memory, disk FROM learned WHERE class = ? ORDER BY seq DESC LIMIT ?', cls, SAMPLES).toArray());
  }

  /** Sends each class's store what it has not had yet. A store that does not answer has it sent at the next flush. */
  async flush(estimates: DurableObjectNamespace<ArmadaEstimates>): Promise<void> {
    const pending = this.sql.exec<{ seq: number; class: string; item: string; cores: number; memory: number; disk: number }>(
      'SELECT seq, class, item, cores, memory, disk FROM learned WHERE sent = 0 ORDER BY seq',
    ).toArray();

    const alone = this.sql.exec<{ class: string; item: string }>('SELECT class, item FROM alone WHERE sent = 0').toArray();
    const classes = new Set([...pending.map((row) => row.class), ...alone.map((row) => row.class)]);

    for (const cls of classes) {
      const samples = pending.filter((row) => row.class === cls);
      const items = alone.filter((row) => row.class === cls).map((row) => row.item);

      await estimates.getByName(cls).record(samples.map(({ item, cores, memory, disk }) => ({ item, cores, memory, disk })), items);

      // Marked after the store has them, by what was read: a sample added while the store was called is sent next time.
      for (const { seq } of samples) this.sql.exec('UPDATE learned SET sent = 1 WHERE seq = ?', seq);

      for (const item of items) this.sql.exec('UPDATE alone SET sent = 1 WHERE class = ? AND item = ?', cls, item);
    }
  }
}
