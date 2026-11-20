/**
 * How an efficient job places its tasks (`mode: 'efficient'`): what each task is expected to use, which queued task fits
 * beside what a container runs, how many containers its open tasks fill, which runs ran beside others, and what its runs
 * used, delivered to their classes' stores (`estimates.ts`). It keeps its own tables in the job's storage and reads the
 * job's `tasks` and `members`; the job hands out each run it chooses, as it does any other.
 *
 * A task's estimate is its own item's record where its item ran before, else its class's, read live from the class's
 * last answer; where its environment's class or item has none yet, its lineage's (`lineageKey`), so an environment
 * bumped packs from its first task. A container holds what fits two budgets of cores: their sustained cores within its
 * vCPUs and their busiest windows within `PEAK_SHARE` times them (`roomOf`). One not looked up yet, one with no
 * estimate at all, one that runs alone, one whose own runs alone kept a process pool busy (`POOL_CORES`: Dew row 6003,
 * a four-rank pool packed at its class's estimate got one core and aborted), a gang's rank and a task with a copy
 * running each take a container whole. A packed run that fails runs again alone (`packedFailure`).
 */
import type { Outcome, Size } from '../../src/protocol';
import { roomOf, type ArmadaEstimates, type Estimate, type Reading, type Sample, type Usage } from './estimates';

/** How a run beside other tasks ended when the kernel killed it for memory. */
export const KILLED_FOR_MEMORY = 'killed for memory';

/** The containers a task needs at once, as an SQL expression on its `item` column: one, or a gang's each rank. */
export const ranksOf = (item: string): string => `CASE WHEN json_type(${item}, '$.item.gang') IS 'integer' THEN json_extract(${item}, '$.item.gang') ELSE 1 END`;

/** What each run of a task spends of its job's budget, as an SQL expression on its `item` column (`costOf`): a job
 *  with a budget refuses any cost but a whole number. */
export const costOf = (item: string): string => `CASE WHEN json_type(${item}, '$.item.cost') IS 'integer' THEN json_extract(${item}, '$.item.cost') ELSE 1 END`;

/** The class stores a job asks at once. */
const STORE_CALLS = 32;

/** The sustained cores an item's own runs alone held at which it takes a container whole: a process pool's, which
 *  packed beside others would get a share of one core (Dew row 6003). */
export const POOL_CORES = 2.5;

/** An estimate's dimension: the item's own, else its class's, else its lineage's. */
const own = (column: string): string => `COALESCE(p.${column}, c.${column}, l.${column})`;

/** Each task with what it is expected to use and the containers it takes whole, as an SQL row source over the job's
 *  tasks. Its cores and sustained cores are one run's or one class's together, never one of each. */
const ESTIMATED = `SELECT t.idx, t.state, t.weight, t.not_before, t.vessel, t.dup,
    ${own('cores')} AS cores, CASE WHEN p.cores IS NOT NULL THEN COALESCE(p.sustained, p.cores) WHEN c.cores IS NOT NULL THEN c.sustained ELSE l.sustained END AS sustained,
    ${own('memory')} AS memory, ${own('disk')} AS disk, ${ranksOf('t.item')} AS ranks, ${costOf('t.item')} AS cost,
    (p.idx IS NULL OR p.looked < 2 OR p.alone = 1 OR ${own('memory')} IS NULL OR ${own('cores')} IS NULL OR COALESCE(p.sustained, 0) >= ${String(POOL_CORES)}
      OR ${ranksOf('t.item')} > 1 OR t.dup IS NOT NULL) AS whole
  FROM tasks t LEFT JOIN placed p ON p.idx = t.idx LEFT JOIN classes c ON c.class = p.class LEFT JOIN classes l ON l.class = p.lineage`;

/** The task states whose runs hold a container. */
const HELD = `('running', 'landing')`;

/** The member states of a gang's rank that holds its vessel. */
const RANKED = `('joined', 'ready', 'starting', 'running', 'landing')`;

/** What a vessel runs now: its runs, their estimates summed, whether one takes the container whole, and whether it holds
 *  a gang's rank still to be handed its claim. */
export interface Load extends Usage {
  readonly runs: number;
  readonly whole: boolean;
  readonly joined: boolean;
}

/** One task of a job, for its placement: its index, its class, its lineage's class and its item's key
 *  (`estimates.ts`). */
export interface Placed {
  readonly index: number;
  readonly class: string;
  readonly lineage: string;
  readonly item: string;
}

/** `usage` and `more` together. */
const plus = (usage: Usage, more: Usage): Usage => ({
  cores: usage.cores + more.cores, sustained: usage.sustained + more.sustained, memory: usage.memory + more.memory, disk: usage.disk + more.disk,
});

/** Whether `usage` stays within `room` in every dimension. */
const within = (usage: Usage, room: Usage): boolean => usage.cores <= room.cores && usage.sustained <= room.sustained && usage.memory <= room.memory && usage.disk <= room.disk;

const NONE: Usage = { cores: 0, sustained: 0, memory: 0, disk: 0 };

/** What a job asks of each class's store (`ask`), and does with its answer (`take`); `doing` names it in the log. */
interface Asking<Rows, Answer> {
  readonly doing: string;
  readonly ask: (store: DurableObjectStub<ArmadaEstimates>, rows: Rows) => Promise<Answer>;
  readonly take: (cls: string, rows: Rows, answer: Answer) => void;
}

/** Each class of `classes` asked of its store, `STORE_CALLS` classes at a time, each answer taken as it is in; a class
 *  whose store does not answer is said in the log and left for the next call. */
async function eachClass<Rows, Answer>(stores: DurableObjectNamespace<ArmadaEstimates>, classes: ReadonlyMap<string, Rows>, { doing, ask, take }: Asking<Rows, Answer>): Promise<void> {
  const all = [...classes];

  for (let from = 0; from < all.length; from += STORE_CALLS) {
    const batch = all.slice(from, from + STORE_CALLS);
    const answers = await Promise.allSettled(batch.map(async ([cls, rows]) => await ask(stores.getByName(cls), rows)));

    for (const [at, [cls, rows]] of batch.entries()) {
      const answered = answers[at];

      if (answered?.status === 'fulfilled') take(cls, rows, answered.value);
      else console.error(JSON.stringify({ estimates: cls, [doing]: String(answered?.reason) }));
    }
  }
}

export class Placement {
  constructor(private readonly sql: SqlStorage) {
    // `looked`: 0 not looked up, 1 its class's answer taken, 2 its lineage's too (`look`).
    sql.exec(`CREATE TABLE IF NOT EXISTS placed (idx INTEGER PRIMARY KEY, class TEXT NOT NULL, item TEXT NOT NULL, looked INTEGER NOT NULL DEFAULT 0,
      cores REAL, memory REAL, disk REAL, alone INTEGER NOT NULL DEFAULT 0, failure TEXT, lineage TEXT, sustained REAL)`);
    sql.exec('CREATE TABLE IF NOT EXISTS classes (class TEXT PRIMARY KEY, cores REAL, memory REAL, disk REAL, revision INTEGER NOT NULL, sustained REAL)');
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (run TEXT PRIMARY KEY, class TEXT NOT NULL, item TEXT NOT NULL, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL,
      beside INTEGER NOT NULL DEFAULT 0, sustained REAL)`);
    // An earlier Worker's tables: a job it made takes up where it was, its tasks with no lineage looked up as it left them.
    const columns = (table: string): string[] => sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name);

    if (!columns('outbox').includes('beside')) sql.exec('ALTER TABLE outbox ADD COLUMN beside INTEGER NOT NULL DEFAULT 0');

    if (!columns('outbox').includes('sustained')) sql.exec('ALTER TABLE outbox ADD COLUMN sustained REAL');

    if (!columns('classes').includes('sustained')) sql.exec('ALTER TABLE classes ADD COLUMN sustained REAL');

    if (!columns('placed').includes('lineage')) {
      sql.exec('ALTER TABLE placed ADD COLUMN lineage TEXT');
      sql.exec('ALTER TABLE placed ADD COLUMN sustained REAL');
      sql.exec('UPDATE placed SET looked = 2 WHERE looked = 1');
    }

    sql.exec('CREATE TABLE IF NOT EXISTS isolate (class TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY (class, item))');
    // Each run handed out beside others, and whether it got a copy since (`copied`).
    sql.exec('CREATE TABLE IF NOT EXISTS beside (vessel TEXT NOT NULL, idx INTEGER NOT NULL, attempt INTEGER NOT NULL, copied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vessel, idx, attempt))');

    if (!sql.exec<{ name: string }>('PRAGMA table_info(beside)').toArray().some((column) => column.name === 'copied')) sql.exec('ALTER TABLE beside ADD COLUMN copied INTEGER NOT NULL DEFAULT 0');
  }

  /** New tasks, each with its class, its lineage's and its item, to be looked up. */
  add(tasks: readonly Placed[]): void {
    for (const task of tasks) this.sql.exec('INSERT OR IGNORE INTO placed (idx, class, lineage, item) VALUES (?, ?, ?, ?)', task.index, task.class, task.lineage, task.item);
  }

  /** Each task not looked up yet, given its item's record and its class's estimate; then its lineage's, where its own
   *  class held no record of its item. A lookup applies only to a task still at that step, so it never undoes what
   *  happened to the task meanwhile, such as its running alone. A class whose store does not answer is looked up at the
   *  next call; its tasks take containers whole meanwhile. */
  async look(stores: DurableObjectNamespace<ArmadaEstimates>): Promise<void> {
    const unlooked = this.sql.exec<{ idx: number; class: string; item: string }>('SELECT idx, class, item FROM placed WHERE looked = 0').toArray();
    const ask = async (store: DurableObjectStub<ArmadaEstimates>, rows: readonly { item: string }[]): Promise<Reading> => await store.read([...new Set(rows.map((row) => row.item))]);

    await eachClass(stores, Map.groupBy(unlooked, (row) => row.class), {
      doing: 'looking',
      ask,
      take: (cls, rows, reading) => {
        this.taken(cls, rows, reading, 0);
      },
    });
    // Its own class's record of its item stands; one it lacks is its lineage's, an item that ran under an environment
    // of the lineage before.
    const lineal = this.sql.exec<{ idx: number; lineage: string; item: string }>('SELECT idx, lineage, item FROM placed WHERE looked = 1').toArray();

    await eachClass(stores, Map.groupBy(lineal, (row) => row.lineage), {
      doing: 'looking',
      ask,
      take: (cls, rows, reading) => {
        this.taken(cls, rows, reading, 1);
      },
    });
  }

  /** `cls`'s answer (`reading`) taken for `rows`, each still at step `step`: its estimate, and each item's record where
   *  the task has none yet, its cores, sustained cores, memory and disk one run's; the task one step further. */
  private taken(cls: string, rows: readonly { idx: number; item: string }[], { estimate, items }: Reading, step: number): void {
    this.estimated(cls, estimate);

    for (const row of rows) {
      const kept = items[row.item];
      const fresh = kept !== undefined && kept.cores !== null;

      this.sql.exec(`UPDATE placed SET looked = ?, alone = MAX(alone, ?),
          cores = CASE WHEN cores IS NULL AND ? THEN ? ELSE cores END, sustained = CASE WHEN cores IS NULL AND ? THEN ? ELSE sustained END,
          memory = COALESCE(memory, ?), disk = COALESCE(disk, ?)
        WHERE idx = ? AND looked = ?`,
      step + 1, kept?.alone === true ? 1 : 0, fresh ? 1 : 0, kept?.cores ?? null, fresh ? 1 : 0, kept?.sustained ?? null,
      kept?.memory ?? null, kept?.disk ?? null, row.idx, step);
    }

    // A task with no lineage (made by an earlier Worker) is looked up whole at its class's answer.
    if (step === 0) this.sql.exec('UPDATE placed SET looked = 2 WHERE looked = 1 AND lineage IS NULL');
  }

  /** What vessel `name` runs now: its tasks and the copies it runs, and the gang ranks it holds, each of which takes it
   *  whole. */
  loadOf(name: string): Load {
    const held = this.sql.exec<{ runs: number; cores: number | null; sustained: number | null; memory: number | null; disk: number | null; whole: number | null }>(
      `SELECT COUNT(*) AS runs, SUM(cores) AS cores, SUM(sustained) AS sustained, SUM(memory) AS memory, SUM(disk) AS disk, MAX(whole) AS whole
        FROM (${ESTIMATED}) WHERE state IN ${HELD} AND (vessel = ? OR dup = ?)`, name, name,
    ).one();

    const ranks = this.sql.exec<{ state: string }>(`SELECT state FROM members WHERE vessel = ? AND state IN ${RANKED}`, name).toArray();

    return {
      runs: held.runs + ranks.length, cores: held.cores ?? 0, sustained: held.sustained ?? 0, memory: held.memory ?? 0, disk: held.disk ?? 0,
      whole: held.whole === 1 || ranks.length > 0, joined: ranks.some((rank) => rank.state === 'joined' || rank.state === 'ready'),
    };
  }

  /** The heaviest queued task whose estimate fits beside `load` in a container of `size`, and whose cost fits what the
   *  job's budget has left (`afford`, null for a job with none); null when none does, or `load` takes its container whole.
   *  Choosing changes nothing: the job hands the run out, then marks who it runs beside (`beside`). */
  fit(load: Load, size: Size, now: number, afford: number | null): number | null {
    if (load.whole) return null;
    const left = roomOf(size);

    return this.sql.exec<{ idx: number }>(
      `SELECT idx FROM (${ESTIMATED}) WHERE state = 'queued' AND not_before <= ? AND whole = 0 AND cores <= ? AND sustained <= ? AND memory <= ? AND disk <= ?
        AND (? IS NULL OR cost <= ?) ORDER BY weight DESC, idx LIMIT 1`, now, left.cores - load.cores, left.sustained - load.sustained, left.memory - load.memory,
      left.disk - load.disk, afford, afford,
    ).toArray()[0]?.idx ?? null;
  }

  /** The containers a job's open tasks fill, at most `pool` runs at once, and `hedged` copies of them, each of which takes
   *  a container whole: those the tasks that take one whole need, their gang's every rank, and first-fit decreasing over
   *  the others' estimates, by memory, the dimension a container runs out of first. At least the widest open gang's,
   *  which cannot start on fewer. The same `within` decides it as decides a claim (`fit`). `only` names the open tasks
   *  a budget runs at once (`ArmadaJob.admitted`), null for every one. */
  containers(size: Size, { pool, hedged, only }: { readonly pool: number; readonly hedged: number; readonly only: readonly number[] | null }): number {
    const room = roomOf(size);
    const among = only === null ? null : JSON.stringify(only);

    const open = this.sql.exec<{ cores: number | null; sustained: number | null; memory: number | null; disk: number | null; ranks: number; whole: number }>(
      `SELECT cores, sustained, memory, disk, ranks, whole FROM (${ESTIMATED}) WHERE state IN ('queued', 'forming', 'running', 'landing')
        AND (? IS NULL OR idx IN (SELECT value FROM json_each(?))) ORDER BY state IN ${HELD} DESC, weight DESC, idx LIMIT ?`, among, among, pool,
    ).toArray();

    const whole = open.filter((task) => task.whole === 1).reduce((sum, task) => sum + task.ranks, 0);
    const bins: Usage[] = [];

    for (const task of open.filter((each) => each.whole === 0).map((each) => ({ cores: each.cores ?? 0, sustained: each.sustained ?? 0, memory: each.memory ?? 0, disk: each.disk ?? 0 }))
      .toSorted((left, right) => right.memory - left.memory)) {
      const bin = bins.findIndex((held) => within(plus(held, task), room));

      if (bin === -1) bins.push(task);
      else bins[bin] = plus(bins[bin] ?? NONE, task);
    }

    const widest = Number(this.sql.exec(`SELECT COALESCE(MAX(ranks), 0) AS n FROM (${ESTIMATED}) WHERE whole = 1 AND state IN ('queued', 'forming')
      AND (? IS NULL OR idx IN (SELECT value FROM json_each(?)))`, among, among).one()['n']);

    return Math.min(pool, Math.max(whole + bins.length + hedged, widest));
  }

  /** Vessel `name` was handed run `attempt` of task `index` beside what it runs: if a run there is still running, that
   *  run and the new one ran beside each other. A run whose process exited, landing, runs beside nothing; nor does a run
   *  alone, so a later run of the same task starts with no mark. */
  beside(name: string, index: number, attempt: number): void {
    const running = this.sql.exec<{ idx: number; attempts: number }>(`SELECT idx, attempts FROM tasks WHERE state = 'running' AND vessel = ? AND idx != ?`, name, index).toArray();

    if (running.length === 0) return;

    for (const run of [...running, { idx: index, attempts: attempt }]) {
      this.sql.exec('INSERT OR IGNORE INTO beside (vessel, idx, attempt) VALUES (?, ?, ?)', name, run.idx, run.attempts);
    }
  }

  /** Run `attempt` of task `index` got a copy: its copies decide it (`ArmadaJob.accept`), so neither runs again alone for
   *  a red, and nothing runs beside it from now on (`whole`). It still ran beside others until then (`learn`). */
  copied(index: number, attempt: number): void {
    this.sql.exec('UPDATE beside SET copied = 1 WHERE idx = ? AND attempt = ?', index, attempt);
  }

  /** How `outcome`, `name`'s run of its task, ended, when that run ran beside other tasks and ended red, past its timeout
   *  or killed for memory, and its task has not run alone since: it is then to run again alone (`alone`). Null for any
   *  other run: a run alone, a copied one, or one cancelled or lost, which the platform's retries took already. */
  packedFailure(name: string, outcome: Outcome): string | null {
    const marked = this.sql.exec('SELECT 1 AS n FROM beside WHERE vessel = ? AND idx = ? AND attempt = ? AND (copied = 0 OR ?)', name, outcome.index, outcome.attempt, outcome.oomKilled === true ? 1 : 0).toArray().length > 0;
    const failure = this.sql.exec<{ failure: string | null }>('SELECT failure FROM placed WHERE idx = ?', outcome.index).toArray()[0]?.failure ?? null;

    if (!marked || failure !== null || outcome.reason === 'cancelled' || outcome.reason === 'lost') return null;

    if (outcome.reason === 'timeout') return 'past its timeout';

    // A child the cgroup killed for memory fails its run whatever its wrapper exits: Dew's records a red row and exits 0.
    if (outcome.oomKilled === true) return KILLED_FOR_MEMORY;

    if (outcome.kind !== 'exited' || outcome.exitCode === 0) return null;

    return `exit ${String(outcome.exitCode)}`;
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

  /** What `run`, vessel `name`'s run of task `index`, used, to deliver to its class and its lineage's (its cores its
   *  busiest window's, `peakCores`, where the container read it, and its sustained cores, its CPU seconds over its wall
   *  seconds): only a run measured whole, its disk included, which a run in a slot of its own is. It ran beside others
   *  when it was marked so (`beside`), or when its job runs a fixed number of `slots` in each container. */
  learn(run: string, name: string, { index, attempt, cpuSeconds, peakCores, peakMemory, diskBytes, seconds }: Outcome, slots: number): void {
    if (cpuSeconds === undefined || peakMemory === undefined || diskBytes === undefined || seconds <= 0) return;
    const marked = this.sql.exec('SELECT 1 AS n FROM beside WHERE vessel = ? AND idx = ? AND attempt = ?', name, index, attempt).toArray().length > 0;
    const sustained = cpuSeconds / seconds;

    const used = [Math.max(peakCores ?? sustained, sustained), sustained, peakMemory, diskBytes, marked || slots > 1 ? 1 : 0] as const;

    // One sample to each class it counts in, its class's and its lineage's, the run told apart by where it goes.
    for (const [column, suffix] of [['class', ''], ['lineage', ' lineage']] as const) {
      this.sql.exec(`INSERT OR IGNORE INTO outbox (run, class, item, cores, sustained, memory, disk, beside)
        SELECT ?, ${column}, item, ?, ?, ?, ?, ? FROM placed WHERE idx = ? AND ${column} IS NOT NULL`, run + suffix, ...used, index);
    }
  }

  /** Delivers to each class's store what the job has for it and has not delivered, and takes its answer as the class's
   *  estimate. A delivery is idempotent (`ArmadaEstimates.record`), so what two sends at once both carry counts once; one
   *  a store does not take stays for the next send. */
  async flush(stores: DurableObjectNamespace<ArmadaEstimates>): Promise<void> {
    const samples = this.sql.exec<{ run: string; class: string; item: string; cores: number; sustained: number | null; memory: number; disk: number; beside: number }>(
      'SELECT run, class, item, cores, sustained, memory, disk, beside FROM outbox').toArray();

    const isolated = this.sql.exec<{ class: string; item: string }>('SELECT class, item FROM isolate').toArray();
    const samplesOf = Map.groupBy(samples, (row) => row.class);
    const aloneOf = Map.groupBy(isolated, (row) => row.class);

    const classes = new Map([...new Set([...samplesOf.keys(), ...aloneOf.keys()])].map((cls) => [cls, {
      samples: (samplesOf.get(cls) ?? []).map(({ run, item, cores, sustained, memory, disk, beside }): Sample => ({ run, item, cores, sustained: sustained ?? cores, memory, disk, beside: beside === 1 })),
      alone: (aloneOf.get(cls) ?? []).map((row) => row.item),
    }]));

    await eachClass(stores, classes, {
      doing: 'delivering',
      ask: async (store, { samples: delivered, alone }) => await store.record(delivered, alone),
      take: (cls, { samples: delivered, alone }, estimate) => {
        this.estimated(cls, estimate);

        for (const { run } of delivered) this.sql.exec('DELETE FROM outbox WHERE run = ?', run);

        for (const item of alone) this.sql.exec('DELETE FROM isolate WHERE class = ? AND item = ?', cls, item);
      },
    });
  }

  /** Whether the job has something still to deliver. */
  pending(): boolean {
    return this.sql.exec('SELECT 1 AS n FROM outbox UNION SELECT 1 AS n FROM isolate LIMIT 1').toArray().length > 0;
  }

  /** `cls`'s estimate, as its store answered, unless the job holds a newer one already: answers can arrive out of order. */
  private estimated(cls: string, { usage, revision }: Estimate): void {
    this.sql.exec(`INSERT INTO classes (class, cores, sustained, memory, disk, revision) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (class) DO UPDATE SET cores = excluded.cores, sustained = excluded.sustained, memory = excluded.memory, disk = excluded.disk, revision = excluded.revision
      WHERE excluded.revision >= classes.revision`,
    cls, usage?.cores ?? null, usage?.sustained ?? null, usage?.memory ?? null, usage?.disk ?? null, revision);
  }
}
