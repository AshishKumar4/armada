/**
 * How an efficient job places its tasks (`mode: 'efficient'`): what each task is expected to use, which queued task fits
 * beside what a container runs, how many containers its open tasks fill, which runs ran beside others, and what its runs
 * used, delivered to their classes' stores (`estimates.ts`). It keeps its own tables in the job's storage and reads the
 * job's `tasks` and `members`; the job hands out each run it chooses, as it does any other.
 *
 * A task's estimate is its own item's record where its item ran before, else its class's, read live from the class's
 * last answer; a task with neither, one not looked up yet, one that runs alone, a gang's rank and a hedged copy each
 * take a container whole.
 */
import type { Outcome, Size } from '../../src/protocol';
import { roomOf, type ArmadaEstimates, type Sample, type Usage } from './estimates';

/** How a run beside other tasks ended when the kernel killed it for memory. */
export const KILLED_FOR_MEMORY = 'killed for memory';

/** Each task with what it is expected to use and the containers it takes whole, as an SQL row source over the job's
 *  tasks. */
const ESTIMATED = `SELECT t.idx, t.state, t.weight, t.not_before, t.vessel, t.dup,
    COALESCE(p.cores, c.cores) AS cores, COALESCE(p.memory, c.memory) AS memory, COALESCE(p.disk, c.disk) AS disk,
    CASE WHEN json_type(t.item, '$.item.gang') IS 'integer' THEN json_extract(t.item, '$.item.gang') ELSE 1 END AS ranks,
    (p.idx IS NULL OR p.looked = 0 OR p.alone = 1 OR COALESCE(p.memory, c.memory) IS NULL OR json_type(t.item, '$.item.gang') IS 'integer') AS whole
  FROM tasks t LEFT JOIN placed p ON p.idx = t.idx LEFT JOIN classes c ON c.class = p.class`;

/** The task states whose runs hold a container. */
const HELD = `('running', 'landing')`;

/** What a vessel runs now: its runs, their estimates summed, whether one takes the container whole, and whether it holds
 *  a gang's rank still to be handed its claim. */
export interface Load extends Usage {
  readonly runs: number;
  readonly whole: boolean;
  readonly joined: boolean;
}

/** One task of a job, for its placement: its index, its class and its item's key (`estimates.ts`). */
export interface Placed {
  readonly index: number;
  readonly class: string;
  readonly item: string;
}

/** `usage` and `more` together. */
const plus = (usage: Usage, more: Usage): Usage => ({ cores: usage.cores + more.cores, memory: usage.memory + more.memory, disk: usage.disk + more.disk });

/** Whether `usage` stays within `room` in every dimension. */
const within = (usage: Usage, room: Usage): boolean => usage.cores <= room.cores && usage.memory <= room.memory && usage.disk <= room.disk;

const NONE: Usage = { cores: 0, memory: 0, disk: 0 };

export class Placement {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS placed (idx INTEGER PRIMARY KEY, class TEXT NOT NULL, item TEXT NOT NULL, looked INTEGER NOT NULL DEFAULT 0,
      cores REAL, memory REAL, disk REAL, alone INTEGER NOT NULL DEFAULT 0, failure TEXT)`);
    sql.exec('CREATE TABLE IF NOT EXISTS classes (class TEXT PRIMARY KEY, cores REAL, memory REAL, disk REAL)');
    sql.exec('CREATE TABLE IF NOT EXISTS outbox (run TEXT PRIMARY KEY, class TEXT NOT NULL, item TEXT NOT NULL, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS isolate (class TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY (class, item))');
    sql.exec('CREATE TABLE IF NOT EXISTS beside (vessel TEXT NOT NULL, idx INTEGER NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY (vessel, idx, attempt))');
  }

  /** New tasks, each with its class and item, to be looked up. */
  add(tasks: readonly Placed[]): void {
    for (const task of tasks) this.sql.exec('INSERT OR IGNORE INTO placed (idx, class, item) VALUES (?, ?, ?)', task.index, task.class, task.item);
  }

  /** Each task not looked up yet, given its item's record, and its class's estimate: a lookup applies only to a task
   *  still not looked up, so it never undoes what happened to the task meanwhile, such as its running alone. A class whose
   *  store does not answer is looked up at the next call; its tasks take containers whole meanwhile. */
  async look(stores: DurableObjectNamespace<ArmadaEstimates>): Promise<void> {
    const unlooked = this.sql.exec<{ idx: number; class: string; item: string }>('SELECT idx, class, item FROM placed WHERE looked = 0').toArray();

    for (const cls of new Set(unlooked.map((row) => row.class))) {
      const rows = unlooked.filter((row) => row.class === cls);
      const [read] = await Promise.allSettled([stores.getByName(cls).read([...new Set(rows.map((row) => row.item))])]);

      if (read.status === 'rejected') {
        console.error(JSON.stringify({ estimates: cls, looking: String(read.reason) }));
        continue;
      }

      this.estimated(cls, read.value.estimate);

      for (const row of rows) {
        const own = read.value.items[row.item];

        this.sql.exec('UPDATE placed SET looked = 1, cores = ?, memory = ?, disk = ?, alone = MAX(alone, ?) WHERE idx = ? AND looked = 0',
          own?.cores ?? null, own?.memory ?? null, own?.disk ?? null, own?.alone === true ? 1 : 0, row.idx);
      }
    }
  }

  /** What vessel `name` runs now. A hedged copy and a gang's rank take a container whole, as a run its estimate says
   *  does. */
  loadOf(name: string): Load {
    const held = this.sql.exec<{ runs: number; cores: number | null; memory: number | null; disk: number | null; whole: number | null; copy: number | null }>(
      `SELECT COUNT(*) AS runs, SUM(cores) AS cores, SUM(memory) AS memory, SUM(disk) AS disk, MAX(whole) AS whole, MAX(dup = ?) AS copy
        FROM (${ESTIMATED}) WHERE state IN ${HELD} AND (vessel = ? OR dup = ?)`, name, name, name,
    ).one();

    const ranks = this.sql.exec<{ state: string }>(`SELECT state FROM members WHERE vessel = ? AND state IN ('joined', 'ready', 'starting', 'running', 'landing')`, name).toArray();

    return {
      runs: held.runs + ranks.length, cores: held.cores ?? 0, memory: held.memory ?? 0, disk: held.disk ?? 0,
      whole: held.whole === 1 || held.copy === 1 || ranks.length > 0, joined: ranks.some((rank) => rank.state === 'joined' || rank.state === 'ready'),
    };
  }

  /** The heaviest queued task whose estimate fits beside `load` in a container of `size`, while the job runs fewer than
   *  `pool` runs; null when none does, or `load` takes its container whole. Choosing changes nothing: the job hands the
   *  run out, then marks who it runs beside (`beside`). */
  fit(load: Load, size: Size, { runs, pool, now }: { readonly runs: number; readonly pool: number; readonly now: number }): number | null {
    if (load.whole || runs >= pool) return null;
    const left = roomOf(size);

    return this.sql.exec<{ idx: number }>(
      `SELECT idx FROM (${ESTIMATED}) WHERE state = 'queued' AND not_before <= ? AND whole = 0 AND cores <= ? AND memory <= ? AND disk <= ?
        ORDER BY weight DESC, idx LIMIT 1`, now, left.cores - load.cores, left.memory - load.memory, left.disk - load.disk,
    ).toArray()[0]?.idx ?? null;
  }

  /** The containers a job's open tasks fill, at most `pool` runs at once, and `hedged` copies of them, each of which takes
   *  a container whole: those the tasks that take one whole need, their gang's every rank, and first-fit decreasing over
   *  the others' estimates, by memory, the dimension a container runs out of first. At least the widest open gang's,
   *  which cannot start on fewer. The same `within` decides it as decides a claim (`fit`). */
  containers(size: Size, { pool, hedged }: { readonly pool: number; readonly hedged: number }): number {
    const room = roomOf(size);

    const open = this.sql.exec<{ cores: number | null; memory: number | null; disk: number | null; ranks: number; whole: number }>(
      `SELECT cores, memory, disk, ranks, whole FROM (${ESTIMATED}) WHERE state IN ('queued', 'forming', 'running', 'landing')
        ORDER BY state IN ${HELD} DESC, weight DESC, idx LIMIT ?`, pool,
    ).toArray();

    const whole = open.filter((task) => task.whole === 1).reduce((sum, task) => sum + task.ranks, 0);
    const bins: Usage[] = [];

    for (const task of open.filter((each) => each.whole === 0).map((each) => ({ cores: each.cores ?? 0, memory: each.memory ?? 0, disk: each.disk ?? 0 })).toSorted((left, right) => right.memory - left.memory)) {
      const bin = bins.findIndex((held) => within(plus(held, task), room));

      if (bin === -1) bins.push(task);
      else bins[bin] = plus(bins[bin] ?? NONE, task);
    }

    const widest = Number(this.sql.exec(`SELECT COALESCE(MAX(ranks), 0) AS n FROM (${ESTIMATED}) WHERE whole = 1 AND state IN ('queued', 'forming')`).one()['n']);

    return Math.min(pool, Math.max(whole + bins.length + hedged, widest));
  }

  /** Vessel `name` was handed run `attempt` of task `index` beside what it runs: that run and each of the others ran
   *  beside one another. A run alone has no mark, so a later run of the same task starts with none. */
  beside(name: string, index: number, attempt: number): void {
    for (const run of this.sql.exec<{ idx: number; attempts: number }>(`SELECT idx, attempts FROM tasks WHERE state IN ${HELD} AND vessel = ?`, name).toArray()) {
      this.sql.exec('INSERT OR IGNORE INTO beside (vessel, idx, attempt) VALUES (?, ?, ?)', name, run.idx, run.attempts);
    }

    this.sql.exec('INSERT OR IGNORE INTO beside (vessel, idx, attempt) VALUES (?, ?, ?)', name, index, attempt);
  }

  /** How `outcome`, `name`'s run of its task, ended, when that run ran beside other tasks and ended red, past its timeout
   *  or killed for memory, and its task has not run alone since: it is then to run again alone (`alone`). Null for any
   *  other run: a run alone, a hedged copy (which runs alone), or one cancelled or lost, which the platform's retries took
   *  already. */
  packedFailure(name: string, outcome: Outcome): string | null {
    const marked = this.sql.exec('SELECT 1 AS n FROM beside WHERE vessel = ? AND idx = ? AND attempt = ?', name, outcome.index, outcome.attempt).toArray().length > 0;
    const failure = this.sql.exec<{ failure: string | null }>('SELECT failure FROM placed WHERE idx = ?', outcome.index).toArray()[0]?.failure ?? null;

    if (!marked || failure !== null || outcome.reason === 'cancelled' || outcome.reason === 'lost') return null;

    if (outcome.reason === 'timeout') return 'past its timeout';

    if (outcome.kind !== 'exited' || outcome.exitCode === 0) return null;

    return outcome.oomKilled === true ? KILLED_FOR_MEMORY : `exit ${String(outcome.exitCode)}`;
  }

  /** Task `index` runs alone from now on, after its run beside others ended `failure`. */
  alone(index: number, failure: string): void {
    this.sql.exec('UPDATE placed SET alone = 1, failure = ? WHERE idx = ?', failure, index);
  }

  /** Task `index` landed `outcome`: how its run beside others failed, when it ran again alone for it. Green alone after a
   *  failure other than memory, its item runs alone in the jobs after; one killed for memory is left to its own record,
   *  which holds the memory it reached and packs it apart from what it would not fit beside. */
  landed(index: number, outcome: Outcome): string | null {
    const task = this.sql.exec<{ class: string; item: string; failure: string | null }>('SELECT class, item, failure FROM placed WHERE idx = ?', index).toArray()[0];

    this.sql.exec('DELETE FROM beside WHERE idx = ?', index);

    if (task?.failure === null || task?.failure === undefined) return null;

    if (task.failure !== KILLED_FOR_MEMORY && outcome.kind === 'exited' && outcome.exitCode === 0) {
      this.sql.exec('INSERT OR IGNORE INTO isolate (class, item) VALUES (?, ?)', task.class, task.item);
    }

    return task.failure;
  }

  /** What `run`, a run of task `index`, used, to deliver to its class: only a run measured whole, its disk included, which
   *  a run in a slot of its own is. */
  learn(run: string, index: number, { cpuSeconds, peakMemory, diskBytes, seconds }: Outcome): void {
    if (cpuSeconds === undefined || peakMemory === undefined || diskBytes === undefined || seconds <= 0) return;
    this.sql.exec('INSERT OR IGNORE INTO outbox (run, class, item, cores, memory, disk) SELECT ?, class, item, ?, ?, ? FROM placed WHERE idx = ?', run, cpuSeconds / seconds, peakMemory, diskBytes, index);
  }

  /** Delivers to each class's store what the job has for it and has not delivered, and takes its answer as the class's
   *  estimate. A delivery is idempotent (`ArmadaEstimates.record`), so what two sends at once both carry counts once; one
   *  a store does not take stays for the next send. */
  async flush(stores: DurableObjectNamespace<ArmadaEstimates>): Promise<void> {
    const classes = this.sql.exec<{ class: string }>('SELECT class FROM outbox UNION SELECT class FROM isolate').toArray().map((row) => row.class);

    for (const cls of classes) {
      const samples: Sample[] = this.sql.exec<{ run: string; item: string; cores: number; memory: number; disk: number }>('SELECT run, item, cores, memory, disk FROM outbox WHERE class = ?', cls).toArray();
      const items = this.sql.exec<{ item: string }>('SELECT item FROM isolate WHERE class = ?', cls).toArray().map((row) => row.item);
      const [recorded] = await Promise.allSettled([stores.getByName(cls).record(samples, items)]);

      if (recorded.status === 'rejected') {
        console.error(JSON.stringify({ estimates: cls, delivering: String(recorded.reason) }));
        continue;
      }

      this.estimated(cls, recorded.value);

      for (const { run } of samples) this.sql.exec('DELETE FROM outbox WHERE run = ?', run);

      for (const item of items) this.sql.exec('DELETE FROM isolate WHERE class = ? AND item = ?', cls, item);
    }
  }

  /** Whether the job has something still to deliver. */
  pending(): boolean {
    return this.sql.exec('SELECT 1 AS n FROM outbox UNION SELECT 1 AS n FROM isolate LIMIT 1').toArray().length > 0;
  }

  /** `cls`'s estimate, as its store last answered. */
  private estimated(cls: string, estimate: Usage | null): void {
    this.sql.exec('INSERT INTO classes (class, cores, memory, disk) VALUES (?, ?, ?, ?) ON CONFLICT (class) DO UPDATE SET cores = excluded.cores, memory = excluded.memory, disk = excluded.disk',
      cls, estimate?.cores ?? null, estimate?.memory ?? null, estimate?.disk ?? null);
  }
}
