/**
 * ArmadaJob: one map. It waits for the job's environment, starts a pool of vessels (one container each, as many as
 * the job allows and its items need), and hands them tasks from one queue, longest first, until it drains. A vessel
 * pays its boot once and then pulls task after task, so short and long tasks balance themselves. Each task's outcome
 * is appended to the job's event stream as it lands. A task a vessel lost to the infrastructure is queued again once;
 * a task that exited, red or green, never is. When the queue is empty, an idle vessel may run a straggler again only
 * if the job says its tasks are speculative, and stays for one about to become a straggler rather than retire; the
 * first answer is kept, or a red the other copy ends with. A job that hedges also runs its heaviest tasks twice from
 * the start, each second copy as soon as the queue reaches its weight. An open job takes more items until its client
 * closes it, starting vessels for them as they come.
 *
 * A gang task (an item's `gang`, `gangOf`) runs on that many vessels at once. The vessels that ask for work join the
 * gang forming, in rank order, before any other task starts, and the gang starts once every rank has joined; each rank
 * gets ARMADA_RANK and ARMADA_WORLD, and the gang a token its relay presents (`relay.ts`). A rank lost to the
 * infrastructure before every rank launched fails the gang at once; after it launched, loses the whole gang, which
 * is queued again as one task. The task's outcome is its first failing rank's, else rank 0's, whose output and log
 * are the task's. A gang's answer is never cached.
 *
 * Concurrency: storage keeps the input gate shut, an RPC or R2 call opens it, so a method decides from storage and
 * writes before it calls out.
 *
 * The job's `env` may carry a credential. It is kept under its own key, read only to build a claim, and deleted before
 * anything else when the job concludes, however it concludes; no vessel stores it (`vessel.ts`).
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  ANSWER_PATH, ARTIFACTS_PATH, BootSchema, BUNDLE_PATH, JobSpecSchema, PY_BUNDLE_PATH, environmentKey, failureTail, gangOf, GANG_START_SECONDS, hex, JOB_DEADLINE_SECONDS, MAX_TASKS, OUT_PATH, OutcomeSchema, refusal, SIZES, TaskSchema, weightOf, workdirOf,
  type Boot, type JobSpec, type JobStatus, type Outcome, type Size, type Task, type TaskStatus, type VesselRow,
} from '../../src/protocol';
import { answer, keep, type CacheScope } from './cache';
import { runKey, said, SINGLE, statusToken, type Env } from './env';
import { commandEnv, type Generation } from './environments';
import { classOf, itemKey, tasksMemoryOf } from './estimates';
import { Placement, ranksOf, type Load } from './placement';
import { instanceOf } from './container';
import { Runs, type RunEnd } from './runs';
import type { VesselSpec } from './vessel';

type Phase = JobStatus['phase'];

/** What the job keeps of its spec: everything but its items (in the `tasks` table), its env (under `env`) and whether
 *  it is open (under `open`). */
/** The job's spec as it keeps it: its items are its tasks, its env its own key, its openness its own. */
const KeptSchema = v.omit(JobSpecSchema, ['items', 'env', 'open']);

type Kept = v.InferOutput<typeof KeptSchema>;

/** A task the vessel should run: its index, attempt, argv and environment. */
export interface Claim {
  readonly index: number;
  readonly attempt: number;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  /** The names of the secrets in `env`, whose values the vessel masks in the task's log. */
  readonly secrets: readonly string[];
  /** A second run of a straggler: its answer is kept only if it lands first. */
  readonly duplicate: boolean;
  /** This vessel's rank in the task's gang, for a gang task. */
  readonly gang?: Gang;
}

/** A rank's part in a gang: the vessel of each rank, in rank order, and what its relay presents to the Worker at
 *  `origin` to reach them. */
export interface Gang {
  readonly rank: number;
  readonly job: string;
  readonly vessels: readonly string[];
  readonly origin: string;
  readonly token: string;
}

/** How long a vessel waits before it asks again: a rank for its gang to form, or one in a packing job for a run of its
 *  full pool to end. */
const WAIT_MS = 1_000;

/** The name of a job's `number`th vessel. */
const vesselName = (number: number): string => `v${String(number)}`;

/** A name a job gives its vessels (`vesselName`), or an earlier Worker gave a replacement, `r` and its number. */
export const VESSEL_NAME = /^[vr][1-9]\d*$/u;

/** What a job owes once it is done (`settleUp`): its close to the fleet, its environment's use to the registry, and
 *  its hold on its bundle to the task registry. */
type Owed = 'closed' | 'used' | 'unpinned';

/** The states of a vessel that is alive: waiting for the fleet, starting, or taking tasks. */
const ALIVE = `('waiting', 'booting', 'working')`;

/** The states a task is open in: not yet run, a gang gathering its ranks, running, or its answer landing. */
const OPEN = `state IN ('queued', 'forming', 'running', 'landing')`;

/** The containers a task needs at once, as an SQL expression on its row. */
const RANKS = ranksOf('item');

/** The containers the open tasks need at once. */
const NEEDED = `SELECT COALESCE(SUM(${RANKS}), 0) AS n FROM tasks WHERE ${OPEN}`;

/** The most containers an open task needs at once, or 1 for a job with none: the containers the job must hold at once
 *  to run it. */
const WIDEST = `SELECT COALESCE(MAX(${RANKS}), 1) AS n FROM tasks WHERE ${OPEN}`;

/** Why a gang of `world` ranks of `size` can never run on a fleet of `cap` vCPUs, or null when it fits. */
export function fleetRefusal(items: readonly Task[], size: Size, cap: number): string | null {
  const world = Math.max(1, ...items.map((task) => gangOf(task.item)));
  const vcpus = world * SIZES[size].vcpus;

  return vcpus <= cap ? null : `a gang of ${String(world)} ${size} containers needs ${String(vcpus)} vCPUs at once, more than this deployment's fleet of ${String(cap)}`;
}

const WATCHDOG_MS = 15_000;

/** A vessel that has not been heard from in this long, while booting or working, is lost. */
const SILENT_MS = { waiting: 60 * 60_000, booting: 8 * 60_000, working: 4 * 60_000 } as const;

/** One run of a task: its index, which attempt it is, and whether it is a copy of a run already going. */
interface Attempt {
  readonly index: number;
  readonly attempt: number;
  readonly duplicate: boolean;
}

/** Vessels lost under a task that a job replaces before it stops replacing them. One lost before it took any task
 *  was lost to its container's start, which says nothing of the job's tasks: those are replaced apart, as many as the
 *  job's pool and at least as many as these (`vesselFailed`). */
const REPLACEMENTS = 8;

/** A task the infrastructure failed this many times is reported failed, not queued again. At two, a Dew CI run of 224
 *  tasks failed two of them, in which 24 of its 158 containers had stopped under their tasks. */
const INFRA_ATTEMPTS = 3;

/** A running task older than this, and than STRAGGLER_WEIGHTS times its weight, is a straggler an idle vessel may
 *  repeat. In Dew's CI a task ran up to 3.2 times its weight, at random rather than by container. */
const STRAGGLER_MS = 30_000;

const STRAGGLER_WEIGHTS = 1.5;

/** How far ahead an idle vessel looks for a task about to become a straggler, which it stays for rather than retire:
 *  vessels retired as the queue emptied, before any task was old enough to repeat, so none was ever repeated. */
const STANDBY_MS = 60_000;


/** Whether a job packs its tasks into its containers by their measured use: in `efficient` mode, unless it fixed its
 *  slots. */
const packs = (spec: Pick<Kept, 'mode' | 'slots'>): boolean => spec.mode === 'efficient' && spec.slots === 1;

/** A gang rank's states before its vessel acknowledged its launch (`started`): its state says so, whichever Worker
 *  stored it. */
const UNLAUNCHED = `('ready', 'starting')`;

/** A formed gang still launching, as an SQL condition on its task `t`: every rank joined and was handed its claim at
 *  the task's `started`, and one has not launched yet. */
const LAUNCHING = `t.state = 'running' AND EXISTS (SELECT 1 FROM members m WHERE m.idx = t.idx AND m.state IN ${UNLAUNCHED})`;

/** Where a task's green answer waits while its other copy may still end red (`complete`, `release`). */
const heldKey = (index: number) => `held/${String(index)}`;

/** The cache lookups a job makes at once. */
const CACHE_READS = 32;

export class ArmadaJob extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  private readonly runs = new Runs(this.ctx.storage.sql);

  /** How its tasks are packed into its containers, in efficient mode (`placement.ts`). */
  private readonly placement = new Placement(this.ctx.storage.sql);

  /** The tasks whose cache read this object is making now (`answerFromCache`). */
  private readonly looking = new Set<number>();

  /** The job's status token (`statusToken`), derived once an object: claims made at once all wait on the one. */
  private token: Promise<string> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The whole schema, once per object: created for a new job's, and an earlier Worker's tables get the columns
    // they are missing (dup for copies, slot/dup_slot for slots, the events' landing time).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (idx INTEGER PRIMARY KEY, item TEXT NOT NULL, weight REAL NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, infra INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0,
      vessel TEXT, started INTEGER, dup TEXT)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT NOT NULL, at INTEGER)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vessels (name TEXT PRIMARY KEY, state TEXT NOT NULL, tasks INTEGER NOT NULL DEFAULT 0,
      boot_ms INTEGER, busy_ms INTEGER NOT NULL DEFAULT 0, error TEXT, beat INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS members (idx INTEGER NOT NULL, rank INTEGER NOT NULL, vessel TEXT NOT NULL, state TEXT NOT NULL,
      outcome TEXT, PRIMARY KEY (idx, rank))`);
    // The vessels staying, each until a time, for a task about to become a straggler (`claim`).
    this.sql.exec('CREATE TABLE IF NOT EXISTS standby (vessel TEXT PRIMARY KEY, until INTEGER NOT NULL)');
    const tasks = this.sql.exec<{ name: string }>('PRAGMA table_info(tasks)').toArray().map((column) => column.name);

    for (const column of ['dup', 'slot', 'dup_slot']) {
      if (!tasks.includes(column)) this.sql.exec(`ALTER TABLE tasks ADD COLUMN ${column} INTEGER`);
    }

    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(events)').toArray().some((column) => column.name === 'at')) this.sql.exec('ALTER TABLE events ADD COLUMN at INTEGER');

    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(vessels)').toArray().some((column) => column.name === 'boot')) this.sql.exec('ALTER TABLE vessels ADD COLUMN boot TEXT');
  }

  async create(id: string, spec: JobSpec, origin = ''): Promise<void> {
    if (await this.ctx.storage.get('spec')) throw new Error(`job ${id} exists`);
    const { items, env, open, ...kept } = spec;
    const key = await environmentKey(spec.recipe);

    await this.insert(items, kept, key);
    await this.ctx.storage.put({ id, spec: kept satisfies Kept, env, open, origin, recorded: true, phase: 'preparing' satisfies Phase, key, createdAt: Date.now(), problems: [], replaced: 0 });
    // Counted open before it can run, so its conclusion, which counts it closed, comes after.
    await this.env.FLEET.getByName(SINGLE).opened(id);
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** A task's one outcome, onto the stream with when it landed. */
  private append(outcome: Outcome): void {
    this.sql.exec('INSERT INTO events (outcome, at) VALUES (?, ?)', JSON.stringify(outcome), Date.now());
  }

  /** The new tasks, each with its class and item key on environment `key`; their indexes. */
  private async insert(items: readonly Task[], spec: Pick<Kept, 'run'>, key: string): Promise<number[]> {
    const keys = await Promise.all(items.map(async (task) => await itemKey(task)));
    const first = this.count('1 = 1');

    for (const [at, task] of items.entries()) this.sql.exec('INSERT INTO tasks (idx, item, weight, state) VALUES (?, ?, ?, ?)', first + at, JSON.stringify(task), weightOf(task.item), 'queued');
    this.placement.add(items.map((task, at) => ({ index: first + at, class: classOf(spec, task, key), item: keys[at] ?? '' })));

    return items.map((_, at) => first + at);
  }

  /** More items for an open job, and the vessels they need; or why the job refuses them. */
  async add(items: readonly Task[]): Promise<string | null> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<boolean>('open')) !== true || (await this.ctx.storage.get<Phase>('phase')) === 'done') return 'the job takes no more items';

    const refused = refusal(spec.run, items, spec.pool, spec.slots) ?? fleetRefusal(items, spec.recipe.size, Number(this.env.FLEET_VCPUS))
      ?? (this.count('1 = 1') + items.length > MAX_TASKS ? `a job takes at most ${String(MAX_TASKS)} items` : null);

    if (refused !== null) return refused;
    const added = await this.insert(items, spec, (await this.ctx.storage.get<string>('key')) ?? '');

    await this.answerFromCache(spec, added);
    await this.look(spec);
    await this.grow();
    await this.settle();

    return null;
  }

  /** No more items: the job settles once its queue drains. */
  async close(): Promise<void> {
    await this.ctx.storage.put('open', false);
    await this.settle();
  }

  /** Each task's item, in order, as the JSON `{"items": [...]}`: a JSON value is too deep a type for an RPC's. */
  async items(): Promise<string> {
    return JSON.stringify({ items: this.sql.exec<{ item: string }>('SELECT item FROM tasks ORDER BY idx').toArray().map((row) => v.parse(TaskSchema, JSON.parse(row.item)).item) });
  }

  /** The job's spec, read through its schema: one an earlier Worker stored lacks the fields added since, which take
   *  their defaults. One stored before its env had a key of its own holds the env, which moves there while the job
   *  runs and is gone once it is done. */
  private async spec(): Promise<Kept | undefined> {
    const stored = await this.ctx.storage.get<Kept & { readonly env?: Record<string, string>; readonly mode?: Kept['mode'] }>('spec');

    if (stored === undefined) return undefined;
    // A job an earlier Worker stored ran one task a container, and keeps that layout to its end.
    const kept = { ...v.parse(KeptSchema, stored), mode: stored.mode ?? 'fast' };

    if (stored.env === undefined) return kept;

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'done') await this.ctx.storage.put('env', stored.env);
    await this.ctx.storage.put('spec', kept);

    return kept;
  }

  override async alarm(): Promise<void> {
    const spec = await this.spec();
    const phase = await this.ctx.storage.get<Phase>('phase');

    if (spec === undefined || phase === undefined) return;

    if (phase === 'done') return await this.settleUp();
    this.requeueUnread();

    const deadline = spec.deadline ?? JOB_DEADLINE_SECONDS;

    if (Date.now() - ((await this.ctx.storage.get<number>('createdAt')) ?? 0) >= deadline * 1000) return await this.cancel(`JobDeadlineExceeded: the job did not finish within ${String(deadline)} s`, 'lost');

    if (phase === 'running') {
      await this.watchGangs(spec);

      if ((await this.ctx.storage.get<Phase>('phase')) !== 'done') await this.watch();
      // The queue and what it needs change between alarms: estimates come in, and tasks land or are lost.
      await this.look(spec);
      await this.grow();
      await this.send();
    }

    if ((await this.ctx.storage.get<Generation>('environment')) === undefined) await this.awaitEnvironment(spec);

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'done') await this.schedule(spec);
  }

  /** Watch at most every 15 seconds, sooner for a job or gang's own deadline. Claims only move an alarm earlier,
   *  never let a heartbeat defer a deadline. */
  private async schedule(spec: Kept, sooner = false): Promise<void> {
    const now = Date.now();
    const created = (await this.ctx.storage.get<number>('createdAt')) ?? now;
    const began = (await this.ctx.storage.get<number>('startedAt')) ?? now;

    const formed = this.sql.exec<{ since: number | null }>(`SELECT MIN(COALESCE(t.started, ?)) AS since FROM tasks t WHERE ${LAUNCHING}`, began).one().since;

    const next = Math.min(now + WATCHDOG_MS, created + (spec.deadline ?? JOB_DEADLINE_SECONDS) * 1000,
      formed === null ? Infinity : formed + (spec.gangStartTimeout ?? GANG_START_SECONDS) * 1000,
      sooner ? (await this.ctx.storage.getAlarm()) ?? Infinity : Infinity);

    await this.ctx.storage.setAlarm(Math.max(now, next));
  }

  /** The job's environment, once it is ready: before the job's first vessel, and again after the snapshot its vessels
   *  started from was lost (`vesselFailed`). */
  private async awaitEnvironment(spec: Kept): Promise<void> {
    if ((await this.ctx.storage.get<Phase>('phase')) === 'done') return;
    const key = (await this.ctx.storage.get<string>('key')) ?? '';
    const readiness = await this.env.ENVIRONMENTS.getByName(SINGLE).ensure(key, spec.recipe, spec.commit ?? null);
    const phase = await this.ctx.storage.get<Phase>('phase');

    if (phase === 'done' || (await this.ctx.storage.get<Generation>('environment')) !== undefined) return;

    if (readiness.kind === 'failed') return await this.cancel(`the environment ${key.slice(0, 12)} could not be prepared: ${readiness.reason}`, 'lost');

    if (readiness.kind === 'preparing') return;

    if (spec.commit !== undefined && spec.commit.base !== 'root' && spec.commit.base !== readiness.generation.sha) {
      return await this.cancel(`the environment was rebuilt from ${String(readiness.generation.sha).slice(0, 10)} after this job was packed against ${spec.commit.base.slice(0, 10)}; run again`, 'lost');
    }

    if (phase === 'preparing') {
      await this.answerFromCache(spec, this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state = 'queued' AND attempts = 0`).toArray().map((row) => row.idx));

      if ((await this.ctx.storage.get<Phase>('phase')) !== 'preparing') return;
      await this.ctx.storage.put({ phase: 'running' satisfies Phase, startedAt: Date.now() });
    }

    await this.ctx.storage.put('environment', readiness.generation);
    await this.look(spec);
    await this.grow();
    await this.settle();
  }

  /** Each task not looked up yet given what its class's store holds of it (`Placement.look`): only a job that packs its
   *  tasks looks. */
  private async look(spec: Kept): Promise<void> {
    if (packs(spec)) await this.placement.look(this.env.ESTIMATES);
  }

  /** What the job's runs used, delivered to their classes' stores (`Placement.flush`). */
  private async send(): Promise<void> {
    await this.placement.flush(this.env.ESTIMATES);
  }

  /**
   * Answers each of `indexes` the job's cache holds, with nothing run: its output is read where it is cached, and its
   * outcome says `cached`. Each task is reserved (`checking`) before the first read, so no vessel claims one whose
   * output a copy could overwrite; a miss, or a read that fails, gives it back to the queue.
   */
  private async answerFromCache(spec: Kept, indexes: readonly number[]): Promise<void> {
    if (spec.cache === undefined || spec.run.kind !== 'task' || spec.run.bundle === undefined) return;

    const reserved = indexes.flatMap((index) => this.sql.exec<{ idx: number; item: string }>(
      `UPDATE tasks SET state = 'checking' WHERE idx = ? AND state = 'queued' AND attempts = 0 RETURNING idx, item`, index,
    ).toArray());

    for (const row of reserved) this.looking.add(row.idx);
    const { bundle, id: task } = spec.run;
    const scope: CacheScope = { bundle, task, environment: (await this.ctx.storage.get<string>('key')) ?? '' };

    for (let from = 0; from < reserved.length; from += CACHE_READS) {
      await Promise.all(reserved.slice(from, from + CACHE_READS).map(async (row) => {
        const index = row.idx;

        const answered = await answer(this.env.ARTIFACTS, scope, index, v.parse(TaskSchema, JSON.parse(row.item)).item);

        this.looking.delete(index);

        if (answered === null) {
          this.sql.exec(`UPDATE tasks SET state = 'queued' WHERE idx = ? AND state = 'checking'`, index);

          return;
        }

        const landed = this.sql.exec<{ idx: number }>(`UPDATE tasks SET state = 'exited' WHERE idx = ? AND state = 'checking' RETURNING idx`, index).toArray();

        if (landed.length === 0) return;
        // Where its output is read from is kept before the outcome a client can read lands.
        await this.ctx.storage.put(`cached:${String(index)}`, answered.key);
        this.append(answered.outcome);
      }));
    }
  }

  /** Where task `index`'s `leaf` file is read from: the cached output, for a task answered from the cache; else the
   *  files of its kept run, the run its outcome names, or none for a task with no outcome yet. */
  async fileOf(index: number, leaf: 'output' | 'log' | 'artifacts'): Promise<string | null> {
    const cached = leaf === 'output' ? await this.ctx.storage.get<string>(`cached:${String(index)}`) : undefined;

    if (cached !== undefined) return cached;
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const [last] = this.sql.exec<{ outcome: string }>(`SELECT outcome FROM events WHERE json_extract(outcome, '$.index') = ? ORDER BY seq DESC LIMIT 1`, index).toArray();

    return last === undefined ? null : runKey(id, index, v.parse(OutcomeSchema, JSON.parse(last.outcome)), leaf);
  }

  /** Tasks reserved for a cache read this object is not making: one an earlier start of it was, cut off. They go back
   *  to the queue, since no copy of theirs can still land. */
  private requeueUnread(): void {
    for (const row of this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state = 'checking'`).toArray()) {
      if (!this.looking.has(row.idx)) this.sql.exec(`UPDATE tasks SET state = 'queued' WHERE idx = ?`, row.idx);
    }
  }

  /** Vessels for the tasks not yet done, up to the pool, beside those still alive. */
  private async grow(): Promise<void> {
    const spec = await this.spec();
    const generation = await this.ctx.storage.get<Generation>('environment');

    if (spec === undefined || generation === undefined || (await this.ctx.storage.get<Phase>('phase')) !== 'running') return;
    const alive = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM vessels WHERE state IN ${ALIVE}`).one()['n']);
    const named = Number(this.sql.exec('SELECT COUNT(*) AS n FROM vessels').one()['n']);
    // A lane for each hedged copy, which runs on another container than its first; a gang is never hedged.
    const hedged = Math.min(spec.hedge, this.count(`${OPEN} AND json_type(item, '$.item.gang') IS NOT 'integer'`));
    const wanted = Math.min(this.needed(spec, hedged), await this.capacity(spec)) - alive;
    const names = Array.from({ length: Math.max(0, wanted) }, (_, index) => vesselName(named + index + 1));

    for (const name of names) this.sql.exec('INSERT INTO vessels (name, state, beat) VALUES (?, ?, ?)', name, 'waiting', Date.now());
    await Promise.all(names.map(async (name) => await this.launch(spec, generation, name)));
  }

  /** The most vessels the job may hold at once: its pool, less a place for each vessel it lost past its replacements
   *  (`vesselFailed`). */
  private async capacity(spec: Kept): Promise<number> {
    return spec.pool - ((await this.ctx.storage.get<number>('forfeited')) ?? 0);
  }

  /** The containers the open tasks, and `hedged` copies of them, need at once, up to the pool: one each (a gang's each
   *  rank) over the slots a fixed container carries; packing, as many as their estimates fill (`Placement.containers`). */
  private needed(spec: Kept, hedged = 0): number {
    if (packs(spec)) return this.placement.containers(spec.recipe.size, { pool: spec.pool, hedged });

    return Math.min(spec.pool, Math.ceil((Number(this.sql.exec(NEEDED).one()['n']) + hedged) / spec.slots));
  }

  private async launch(spec: Kept, generation: Generation, name: string): Promise<void> {
    const id = (await this.ctx.storage.get<string>('id')) ?? '';

    const vessel: VesselSpec = {
      jobId: id, name, snapshot: generation.snapshot.id, instance: instanceOf(spec.recipe.size), vcpus: SIZES[spec.recipe.size].vcpus,
      workdir: workdirOf(spec.recipe), commit: spec.commit === undefined || spec.recipe.repo === undefined ? null : { ...spec.commit, project: spec.recipe.repo.project, history: spec.recipe.repo.history },
      tmpfs: spec.tmpfs, files: spec.files, bundle: spec.run.kind === 'task' ? spec.run.bundle ?? null : null,
      runtime: spec.run.kind === 'task' ? spec.run.runtime : 'node', output: spec.output, timeout: spec.timeout,
      slots: spec.slots, pack: packs(spec),
      slotMemoryBytes: packs(spec) ? tasksMemoryOf(spec.recipe.size) : Math.floor(SIZES[spec.recipe.size].memoryGiB * 2 ** 30 / spec.slots),
      reserve: Number(this.sql.exec(WIDEST).one()['n']) * SIZES[spec.recipe.size].vcpus,
      deadlineAt: ((await this.ctx.storage.get<number>('createdAt')) ?? Date.now()) + (spec.deadline ?? JOB_DEADLINE_SECONDS) * 1000,
    };

    try {
      await this.env.VESSEL.getByName(`${id}/${name}`).begin(vessel);
    } catch (cause) {
      await this.vesselFailed(name, `could not start: ${said({ cause })}`);
    }
  }

  private count(where: string): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).one()['n']);
  }

  private beat(name: string, state?: VesselRow['state']): void {
    if (state === undefined) this.sql.exec('UPDATE vessels SET beat = ? WHERE name = ?', Date.now(), name);
    else this.sql.exec('UPDATE vessels SET beat = ?, state = ? WHERE name = ?', Date.now(), state, name);
  }

  /** A vessel is up: how long its container took to answer, and its boot by phase (absent from an earlier Worker's
   *  vessel). */
  async booted(name: string, bootMs: number, boot?: Boot): Promise<void> {
    this.sql.exec(`UPDATE vessels SET boot_ms = ?, boot = ?, state = ?, beat = ? WHERE name = ? AND state IN ${ALIVE}`, bootMs, boot === undefined ? null : JSON.stringify(boot), 'working', Date.now(), name);
  }

  /** Vessel `name` waits for the fleet's capacity, or was granted it and boots: its watchdog bounds its silence by that
   *  (`SILENT_MS`). A word from a vessel that ended changes nothing. */
  async moved(name: string, state: 'waiting' | 'booting'): Promise<void> {
    this.sql.exec(`UPDATE vessels SET state = ?, beat = ? WHERE name = ? AND state IN ${ALIVE}`, state, Date.now(), name);
  }

  /** Whether `name` still has a task assigned: a slotted vessel claims its next while the others run, so an empty
   *  queue retires it only once nothing of its runs. */
  private busy(name: string): boolean {
    return this.sql.exec(`SELECT 1 AS n FROM tasks WHERE (vessel = ? OR dup = ?) AND state IN ('running', 'landing')`, name, name).toArray().length > 0
      || this.sql.exec(`SELECT 1 AS n FROM members WHERE vessel = ? AND state IN ('joined', 'ready', 'starting', 'running', 'landing')`, name).toArray().length > 0;
  }

  /** The next task for `name`'s `slot`; how long to wait, while the gang it joined gathers its ranks or the only
   *  tasks left wait out a retry's backoff; or null when there is none left for it: the vessel stops once its last
   *  slot is done. A task handed out is a run of it until its vessel says it ended (`Runs`). */
  async claim(name: string, slot = 0): Promise<Claim | { readonly waitMs: number } | null> {
    const claimed = await this.next(name, slot);

    if (claimed === null || 'waitMs' in claimed) return claimed;
    this.runs.began({ vessel: name, slot, index: claimed.index, attempt: claimed.attempt }, Date.now());

    if (claimed.duplicate) this.placement.copied(claimed.index, claimed.attempt);

    return claimed;
  }

  private async next(name: string, slot: number): Promise<Claim | { readonly waitMs: number } | null> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<Phase>('phase')) !== 'running') return null;
    // Secrets are read for each claim and never kept: the job holds only their names. A driver job's deployToken
    // adds the deployment's bearer at claim, masked as one more secret and stored nowhere. Every task gets its job's
    // id, its container's name, and where and with what it reads its job's tasks: a task can then tell whether the
    // run that left something behind still runs.
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const origin = (await this.ctx.storage.get<string>('origin')) ?? '';

    this.token ??= statusToken(this.env.ARMADA_TOKEN, id);

    const own = {
      ...await this.ctx.storage.get<Record<string, string>>('env'), ...await this.secrets(spec),
      ARMADA_JOB_ID: id, ARMADA_VESSEL: name, ARMADA_STATUS_URL: `${origin}/status/${id}`, ARMADA_STATUS_TOKEN: await this.token,
    };

    const env = spec.deployToken ? { ...own, ARMADA_TOKEN: this.env.ARMADA_TOKEN } : own;

    // Decided after the secrets' read, which lets other calls in: a job that ended meanwhile hands out nothing, and a
    // vessel that failed or retired asks nothing more, so a claim racing its last report takes no task and its row
    // stays dead. Another slot loop's call can land here after `vesselFailed`.
    if ((await this.ctx.storage.get<Phase>('phase')) !== 'running') return null;
    const vessel = this.sql.exec<{ state: VesselRow['state'] }>('SELECT state FROM vessels WHERE name = ?', name).toArray()[0];

    if (vessel?.state === 'failed' || vessel?.state === 'done') return null;
    this.beat(name, 'working');
    // A vessel that claimed is no longer standing by for a straggler.
    this.sql.exec('DELETE FROM standby WHERE vessel = ?', name);
    const now = Date.now();
    // A packing job's vessel already running a task takes only what fits beside it (`fitting`), and nothing beside a
    // task that takes it whole; this slot then ends, and the vessel runs on. One holding a gang's rank still to start
    // takes that rank's claim (`rank`).
    const load = packs(spec) ? this.placement.loadOf(name) : null;
    // A packing job's pool bounds its runs at once, however they are held (`Placement.held`): while it is full, no vessel
    // takes a new one.
    const full = load !== null && this.held() >= spec.pool;

    if (load !== null && load.runs > 0 && !load.joined) return full ? null : this.fitting(spec, env, { name, slot, now }, load);
    // No await between finding no forming gang and creating one: simultaneous first claims would all miss `rank`,
    // then only the first form it, with the others retiring against the now-empty queue instead of joining.
    const ganged = this.rank(spec, env, name, full);

    if (ganged !== undefined) return await ganged;

    if (full) {
      // An empty vessel stays for the work its job has yet to run, and takes it as a run ends.
      if (this.count(`state IN ('queued', 'forming')`) > 0) return { waitMs: WAIT_MS };

      if (!this.busy(name)) this.beat(name, 'done');

      return null;
    }

    const first = this.sql.exec<{ idx: number; item: string; weight: number }>(`SELECT idx, item, weight FROM tasks WHERE state = 'queued' AND not_before <= ? ORDER BY weight DESC, idx LIMIT 1`, now).toArray()[0];

    if (first !== undefined && gangOf(v.parse(TaskSchema, JSON.parse(first.item)).item) > 1) {
      // A gang forms from the vessels that ask next, this one rank 0.
      this.sql.exec(`UPDATE tasks SET state = 'forming' WHERE idx = ?`, first.idx);
      this.sql.exec(`INSERT INTO members (idx, rank, vessel, state) VALUES (?, 0, ?, 'joined')`, first.idx, name);

      return { waitMs: WAIT_MS };
    }

    const hedged = this.hedged(spec, name, slot, first?.weight ?? 0);

    if (hedged !== undefined) return this.claimOf(spec, env, hedged.item, { index: hedged.idx, attempt: hedged.attempts, duplicate: true });

    const next = first === undefined ? undefined : this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET state = 'running', vessel = ?, started = ?, slot = ?, attempts = attempts + 1 WHERE idx = ? RETURNING idx, item, attempts`, name, now, slot, first.idx,
    ).toArray()[0];

    if (next !== undefined) return this.claimOf(spec, env, next.item, { index: next.idx, attempt: next.attempts, duplicate: false });
    const [later] = this.sql.exec<{ at: number | null }>(`SELECT MIN(not_before) AS at FROM tasks WHERE state = 'queued'`).toArray();

    // At most a minute at a time, so a waiting vessel still beats.
    if (later?.at !== null && later?.at !== undefined) return { waitMs: Math.min(60_000, Math.max(1000, later.at - now)) };

    if (!spec.speculative) {
      // Marked done only once nothing of this vessel's runs: a slotted one's other slots still can.
      if (!this.busy(name)) this.beat(name, 'done');

      return null;
    }

    // The queue is empty: repeat the oldest straggler nobody is repeating yet.
    const lone = `state = 'running' AND dup IS NULL AND vessel != ? AND idx NOT IN (SELECT idx FROM members)`;
    const due = `MAX(started + ${String(STRAGGLER_MS)}, started + weight * ${String(STRAGGLER_WEIGHTS * 1000)})`;

    const straggler = this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET dup = ?, dup_slot = ? WHERE idx = (SELECT idx FROM tasks WHERE ${lone} AND ${due} <= ? ORDER BY started LIMIT 1) RETURNING idx, item, attempts`,
      name, slot, name, now,
    ).toArray()[0];

    if (straggler !== undefined) return this.claimOf(spec, env, straggler.item, { index: straggler.idx, attempt: straggler.attempts, duplicate: true });
    // Stay for a task about to become a straggler, one vessel for each, rather than retire.
    const soon = this.sql.exec<{ n: number; at: number | null }>(`SELECT COUNT(*) AS n, MIN(${due}) AS at FROM tasks WHERE ${lone} AND ${due} <= ?`, name, now + STANDBY_MS).one();
    const staying = Number(this.sql.exec('SELECT COUNT(*) AS n FROM standby WHERE until > ?', now).one()['n']);

    if (soon.at !== null && soon.n > staying) {
      this.sql.exec('INSERT INTO standby (vessel, until) VALUES (?, ?)', name, soon.at);

      return { waitMs: Math.max(1000, soon.at - now) };
    }

    // It retires: marked now, so items an open job takes before its retirement lands get a vessel of their own.
    if (!this.busy(name)) this.beat(name, 'done');

    return null;
  }

  /** The runs the job holds at once, which a packing job's pool bounds: each run a live vessel was handed and has not
   *  ended (`Runs`), a copy told to stop included until it says it did, and each rank of a gang from when it joins until
   *  it is handed its run. */
  private held(): number {
    return Number(this.sql.exec(`SELECT
        (SELECT COUNT(*) FROM runs r JOIN vessels v ON v.name = r.vessel WHERE v.state IN ${ALIVE})
      + (SELECT COUNT(*) FROM members m JOIN tasks t ON t.idx = m.idx WHERE t.state IN ('forming', 'running') AND m.state IN ('joined', 'ready')) AS n`).one()['n']);
  }

  /** The queued task that fits beside what vessel `name` runs (`load`), handed out to `slot` beside them
   *  (`Placement.fit`); or null when none does. */
  private fitting(spec: Kept, env: Record<string, string>, { name, slot, now }: { readonly name: string; readonly slot: number; readonly now: number }, load: Load): Claim | null {
    const index = this.placement.fit(load, spec.recipe.size, now);

    if (index === null) return null;

    const next = this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET state = 'running', vessel = ?, started = ?, slot = ?, attempts = attempts + 1 WHERE idx = ? AND state = 'queued' RETURNING idx, item, attempts`, name, now, slot, index,
    ).toArray()[0];

    if (next === undefined) return null;
    this.placement.beside(name, next.idx, next.attempts);

    return this.claimOf(spec, env, next.item, { index: next.idx, attempt: next.attempts, duplicate: false });
  }

  /** One of the job's `hedge` heaviest tasks, running on one vessel, that `name` runs a second copy of: the heaviest no
   *  lighter than the task `waiting` next, so each copy starts as soon as the queue reaches its weight. A gang is not
   *  repeated. The first answer is kept (`accept`), and the other copy stops (`still`). */
  private hedged(spec: Kept, name: string, slot: number, waiting: number): { idx: number; item: string; attempts: number } | undefined {
    if (spec.hedge === 0) return undefined;

    return this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET dup = ?, dup_slot = ? WHERE idx = (SELECT idx FROM tasks WHERE state = 'running' AND dup IS NULL AND vessel != ? AND weight >= ?
       AND idx IN (SELECT idx FROM tasks ORDER BY weight DESC, idx LIMIT ?) AND idx NOT IN (SELECT idx FROM members) ORDER BY weight DESC, idx LIMIT 1)
       RETURNING idx, item, attempts`, name, slot, name, waiting, spec.hedge,
    ).toArray()[0];
  }

  /** `name`'s rank in a gang: its claim once the gang formed, a wait while it forms, joining the one forming if it is in
   *  none and the job's pool is not `full`; undefined when no gang is forming or holds it. */
  private rank(spec: Kept, env: Record<string, string>, name: string, full: boolean): Promise<Claim> | { readonly waitMs: number } | undefined {
    let mine = this.sql.exec<{ idx: number; state: string }>(
      `SELECT m.idx, m.state FROM members m JOIN tasks t ON t.idx = m.idx WHERE m.vessel = ? AND m.state IN ('joined', 'ready') AND t.state IN ('forming', 'running')`, name,
    ).toArray()[0];

    if (mine === undefined) {
      const forming = this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state = 'forming' ORDER BY idx LIMIT 1`).toArray()[0];

      if (forming === undefined || full) return undefined;
      this.sql.exec(`INSERT INTO members (idx, rank, vessel, state) VALUES (?, (SELECT COUNT(*) FROM members WHERE idx = ?), ?, 'joined')`, forming.idx, forming.idx, name);
      mine = { idx: forming.idx, state: 'joined' };
    }

    const task = this.sql.exec<{ item: string; attempts: number }>('SELECT item, attempts FROM tasks WHERE idx = ?', mine.idx).one();
    const world = gangOf(v.parse(TaskSchema, JSON.parse(task.item)).item);
    let token: string | undefined;

    if (mine.state === 'joined') {
      if (Number(this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE idx = ?', mine.idx).one()['n']) < world) return { waitMs: WAIT_MS };
      // Every rank has joined: hand out claims under one relay token, and the gang's launch starts now (`LAUNCHING`). A
      // claim is not a launched task: each vessel acknowledges its launch (`started`), and the gang's start bound stays
      // armed until all do.
      this.sql.exec(`UPDATE tasks SET state = 'running', started = ?, attempts = attempts + 1, vessel = (SELECT vessel FROM members WHERE idx = ? AND rank = 0)
        WHERE idx = ?`, Date.now(), mine.idx, mine.idx);
      this.sql.exec(`UPDATE members SET state = 'ready' WHERE idx = ?`, mine.idx);
      token = hex(crypto.getRandomValues(new Uint8Array(24)));
    }

    return this.rankClaim(spec, env, name, { index: mine.idx, item: task.item, token });
  }

  /** A formed rank's claim: the only part of admission that needs to wait, for its relay token's storage. The claim
   *  that formed the gang arms its launch bound (`LAUNCHING`). */
  private async rankClaim(spec: Kept, env: Record<string, string>, name: string, { index, item, token }: { readonly index: number; readonly item: string; readonly token?: string }): Promise<Claim> {
    if (token !== undefined) {
      await this.ctx.storage.put(`gang:${String(index)}`, token);
      await this.schedule(spec, true);
    }

    const vessels = this.sql.exec<{ vessel: string }>('SELECT vessel FROM members WHERE idx = ? ORDER BY rank', index).toArray().map((row) => row.vessel);
    const rank = vessels.indexOf(name);
    const { attempts } = this.sql.exec<{ attempts: number }>('SELECT attempts FROM tasks WHERE idx = ?', index).one();

    this.sql.exec(`UPDATE members SET state = 'starting' WHERE idx = ? AND vessel = ?`, index, name);

    const gang: Gang = {
      rank, vessels, job: (await this.ctx.storage.get<string>('id')) ?? '', origin: (await this.ctx.storage.get<string>('origin')) ?? '',
      token: (await this.ctx.storage.get<string>(`gang:${String(index)}`)) ?? '',
    };

    const world = gangOf(v.parse(TaskSchema, JSON.parse(item)).item);
    const claim = this.claimOf(spec, env, item, { index, attempt: attempts, duplicate: false });

    return { ...claim, env: { ...claim.env, ARMADA_RANK: String(rank), ARMADA_WORLD: String(world) }, gang };
  }

  /** `name`'s membership of gang task `index`, or undefined for a task that is no gang's or a vessel in none. */
  private member(name: string, index: number): { readonly rank: number; readonly state: string } | undefined {
    return this.sql.exec<{ rank: number; state: string }>('SELECT rank, state FROM members WHERE idx = ? AND vessel = ?', index, name).toArray()[0];
  }

  /** A gang rank actually launched, not merely claimed. A late launch belongs to no later attempt, and a gang that
   *  lost a rank or passed its start deadline keeps no late launch. */
  async started(name: string, index: number, attempt: number): Promise<boolean> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<Phase>('phase')) !== 'running') return false;
    await this.watchGangs(spec);
    const task = this.sql.exec<{ state: string; attempts: number }>('SELECT state, attempts FROM tasks WHERE idx = ?', index).toArray()[0];

    if (task?.state !== 'running' || task.attempts !== attempt) return false;

    return this.sql.exec(`UPDATE members SET state = 'running' WHERE idx = ? AND vessel = ? AND state IN ('starting', 'running') RETURNING rank`, index, name).toArray().length > 0;
  }

  private claimOf(spec: Kept, own: Record<string, string>, stored: string, { index, attempt, duplicate }: Attempt): Claim {
    const task = v.parse(TaskSchema, JSON.parse(stored));

    const common = {
      ...commandEnv(spec.recipe, own), ARMADA_ITEM: JSON.stringify(task.item) ?? 'null', ARMADA_INDEX: String(index), ARMADA_ATTEMPT: String(attempt),
      ARMADA_OUT: OUT_PATH, ARMADA_ANSWER: ANSWER_PATH, ARMADA_ARTIFACTS: ARTIFACTS_PATH,
    };

    const { run } = spec;
    // The names its log masks: the job's secrets, and the deployment's bearer a driver job gets.
    const claim = { index, attempt, secrets: spec.deployToken ? [...spec.secrets, 'ARMADA_TOKEN'] : spec.secrets, duplicate };

    // A pushed task's bundle runs under its runtime; a command task runs its own argv.
    if (run.kind === 'command') return { ...claim, argv: task.argv ?? ['false'], env: common };

    return { ...claim, argv: run.runtime === 'python' ? ['python3', PY_BUNDLE_PATH] : ['node', BUNDLE_PATH], env: { ...common, ARMADA_TASK: run.id } };
  }

  /** The values of the secrets the job names that are still set: the runner says which was deleted. */
  private async secrets(spec: Kept): Promise<Record<string, string>> {
    return spec.secrets.length === 0 ? {} : await this.env.SECRETS.getByName(SINGLE).values(spec.secrets);
  }

  /** Whether `name`'s answer for `index`, which exited `exitCode`, is the one kept. A copy's answer is its command's
   *  verdict and final: the first copy to answer decides, and the other copy, told to stop (`still`), never does.
   *  A red the other copy answers with while the first answer is still landing is kept in its place, so a red from any
   *  copy that ran to its end makes the task red, and a flaky or order-dependent failure is never hidden behind a
   *  green copy: a green is held, unreported, until the other copy has stopped or ended (`complete`, `release`). Only a
   *  lost container (`vesselFailed`) falls through to the other copy. A late duplicate is told no. */
  async accept(name: string, index: number, exitCode: number, run?: RunEnd): Promise<boolean> {
    // The process exited: the run is over, whatever its answer is worth. A word that names no run ends none.
    if (run !== undefined) this.runs.ended({ vessel: name, index, ...run });
    const task = this.sql.exec<{ state: string; vessel: string | null; dup: string | null; attempts: number }>('SELECT state, vessel, dup, attempts FROM tasks WHERE idx = ?', index).toArray()[0];
    const member = this.member(name, index);

    // An answer of an attempt the task has moved on from is no answer of the task's.
    if (run !== undefined && task !== undefined && run.attempt !== task.attempts) return false;

    if (member !== undefined) {
      // A rank landing already asks again when its vessel restarted mid-finish: it is still the one landing.
      if (task?.state !== 'running' || (member.state !== 'running' && member.state !== 'landing')) return false;
      this.sql.exec(`UPDATE members SET state = 'landing' WHERE idx = ? AND vessel = ?`, index, name);

      return true;
    }

    if (task === undefined || (task.vessel !== name && task.dup !== name)) return false;

    // So does the run landing as the task's.
    if (task.state === 'landing' && task.vessel === name) return true;

    if (task.state === 'running') {
      // The copy answering lands as the task's; the other stays named, with its slot, so a red it reaches its end with
      // can still land.
      if (task.vessel === name) this.sql.exec(`UPDATE tasks SET state = 'landing' WHERE idx = ?`, index);
      else this.sql.exec(`UPDATE tasks SET state = 'landing', vessel = dup, dup = vessel, slot = dup_slot, dup_slot = slot WHERE idx = ?`, index);

      return true;
    }

    if (task.state !== 'landing' || task.dup !== name) return false;

    if (exitCode === 0) {
      // The other copy ended green too: the first answer stands.
      this.sql.exec('UPDATE tasks SET dup = NULL WHERE idx = ?', index);
      await this.release(index);
      await this.settle();

      return false;
    }

    await this.ctx.storage.delete(heldKey(index));
    this.sql.exec('UPDATE tasks SET vessel = ?, dup = NULL, slot = dup_slot, dup_slot = NULL WHERE idx = ?', name, index);

    return true;
  }

  /** `name` killed its run of `index` when told to (`still`), so a copy's other copy's green, held until now, is
   *  reported. */
  async stopped(name: string, index: number, run?: RunEnd): Promise<void> {
    if (run !== undefined) this.runs.ended({ vessel: name, index, ...run });
    const task = this.sql.exec<{ dup: string | null }>('SELECT dup FROM tasks WHERE idx = ?', index).toArray()[0];

    if (task?.dup !== name) return;
    this.sql.exec('UPDATE tasks SET dup = NULL, dup_slot = NULL WHERE idx = ?', index);
    await this.release(index);
    await this.settle();
  }

  /** Reports the green answer held for `index` (`complete`), once its other copy can no longer end red: unless the job
   *  ended the task meanwhile, which keeps the one outcome it has. */
  private async release(index: number): Promise<void> {
    const held = await this.ctx.storage.get<Outcome>(heldKey(index));

    if (held === undefined) return;
    await this.ctx.storage.delete(heldKey(index));
    await this.land(held, 'landing');
  }

  /** `outcome` as its task's final one, if the task is still `from`: appended, and a green answer of a cached task kept
   *  in the cache, now that no other copy can end it red. A gang's is not: its answer is rank 0's alone. */
  private async land(outcome: Outcome, from: 'running' | 'landing'): Promise<void> {
    const task = this.sql.exec<{ item: string }>(`UPDATE tasks SET state = ? WHERE idx = ? AND state = ? RETURNING item`, outcome.kind, outcome.index, from).toArray()[0];

    if (task === undefined) return;
    // A task that ran again alone after failing beside others says how (`Placement.landed`).
    const after = this.placement.landed(outcome.index, outcome);

    this.append(after === null ? outcome : { ...outcome, aloneAfter: after });
    const spec = await this.spec();

    if (spec?.cache === undefined || spec.run.kind !== 'task' || spec.run.bundle === undefined || outcome.kind !== 'exited' || outcome.exitCode !== 0 || !outcome.output) return;
    const { item } = v.parse(TaskSchema, JSON.parse(task.item));

    if (gangOf(item) > 1) return;
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const scope = { bundle: spec.run.bundle, task: spec.run.id, environment: (await this.ctx.storage.get<string>('key')) ?? '' };

    await keep(this.env.ARTIFACTS, scope, { item, days: spec.cache.days, output: runKey(id, outcome.index, outcome, 'output'), marker: outcome.answer });
  }

  /** The task an answer lands for, with its retries: a plain task landing on `name`, or a gang's, running. */
  private landing(name: string, { index, attempt }: Pick<Outcome, 'index' | 'attempt'>, ganged: boolean): { readonly retries: number } | undefined {
    if (ganged) return this.sql.exec<{ retries: number }>(`SELECT retries FROM tasks WHERE idx = ? AND attempts = ? AND state = 'running'`, index, attempt).toArray()[0];

    return this.sql.exec<{ retries: number }>(`SELECT retries FROM tasks WHERE idx = ? AND attempts = ? AND state = 'landing' AND vessel = ?`, index, attempt, name).toArray()[0];
  }

  /** The kept answer, once its output and log are in R2: appended to the stream, or, for a failure the job's retries
   *  name, the task queued again after its backoff. */
  async complete(name: string, outcome: Outcome, busyMs: number): Promise<void> {
    const member = this.member(name, outcome.index);
    // A gang's outcome is kept once its ranks decide it (`ranked`).
    const kept = member === undefined ? outcome : this.ranked(name, member.rank, outcome);
    const retries = (await this.spec())?.retries;
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    // A copy whose landing answer the other copy's red replaced (`accept`) keeps nothing.
    const task = kept === null ? undefined : this.landing(name, kept, member !== undefined);

    // What a run used is learnt from the run that lands: not from a copy the other replaced, nor one after the job ended.
    if (task !== undefined && member === undefined) this.placement.learn(`${id}/${String(outcome.index)}/${String(outcome.attempt)}/${name}`, outcome.index, outcome);
    const packed = kept !== null && task !== undefined && member === undefined ? this.placement.packedFailure(name, kept) : null;

    const named = kept !== null && kept.exitCode !== 0
      && (retries?.exitCodes.includes(kept.exitCode) === true || (kept.error !== undefined && retries?.errors.includes(kept.error) === true));

    if (kept !== null && packed !== null) {
      // It failed beside other tasks in its container: it runs again alone, before any retry of its own.
      this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, slot = NULL, not_before = 0 WHERE idx = ?`, kept.index);
      this.placement.alone(kept.index, packed);
    } else if (kept !== null && task !== undefined && retries !== undefined && named && task.retries + 1 < retries.attempts) {
      const backoff = retries.backoffSeconds * 1000 * 2 ** task.retries;

      // A gang forms again: its other ranks stop (`still`).
      this.sql.exec('DELETE FROM members WHERE idx = ?', kept.index);
      this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, dup = NULL, dup_slot = NULL, retries = retries + 1, not_before = ? WHERE idx = ?`, Date.now() + backoff, kept.index);
    } else if (kept !== null && task !== undefined && member === undefined && kept.exitCode === 0
      && this.sql.exec<{ dup: string | null }>('SELECT dup FROM tasks WHERE idx = ?', kept.index).one().dup !== null) {
      // The other copy may still end red, which would be the task's verdict: the green waits for it (`release`).
      await this.ctx.storage.put(heldKey(kept.index), kept);
    } else if (kept !== null && task !== undefined) {
      await this.land(kept, member === undefined ? 'landing' : 'running');
    }

    this.sql.exec('UPDATE vessels SET tasks = tasks + 1, busy_ms = busy_ms + ?, beat = ? WHERE name = ?', busyMs, Date.now(), name);
    await this.settle();
  }

  /** A gang rank's answer: the gang's outcome once a rank failed (that rank's) or every rank exited 0 (rank 0's), else
   *  null while ranks still run. */
  private ranked(name: string, rank: number, outcome: Outcome): Outcome | null {
    this.sql.exec(`UPDATE members SET state = 'done', outcome = ? WHERE idx = ? AND vessel = ? AND state = 'landing'`, JSON.stringify(outcome), outcome.index, name);
    const world = Number(this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE idx = ?', outcome.index).one()['n']);

    if (outcome.kind !== 'exited' || outcome.exitCode !== 0) {
      return rank === 0 ? outcome : { ...outcome, output: false, value: undefined, answer: undefined, artifacts: undefined, tail: `rank ${String(rank)} of ${String(world)}:\n${outcome.tail}` };
    }

    const done = this.sql.exec<{ outcome: string }>(`SELECT outcome FROM members WHERE idx = ? AND state = 'done' ORDER BY rank`, outcome.index).toArray();

    return done.length < world ? null : v.parse(OutcomeSchema, JSON.parse(done[0]?.outcome ?? 'null'));
  }

  /** Whether `name`'s run of `index` in `slot`, at `attempt`, should keep running: only while it is one of the task's
   *  runs now (its copy, the other copy, or its gang's rank) of the attempt now; no once someone else's answer landed, the
   *  task was handed out again, its gang ended, or the job did. */
  async still(name: string, index: number, slot = 0, attempt?: number): Promise<boolean> {
    this.beat(name);

    const task = this.sql.exec<{ state: string; attempts: number; vessel: string | null; slot: number | null; dup: string | null; dup_slot: number | null }>(
      'SELECT state, attempts, vessel, slot, dup, dup_slot FROM tasks WHERE idx = ?', index,
    ).toArray()[0];

    const member = this.member(name, index);

    const owned = member === undefined
      ? (task?.vessel === name && (task.slot ?? 0) === slot) || (task?.dup === name && (task.dup_slot ?? 0) === slot)
      : member.state === 'running' || member.state === 'landing';

    return (await this.ctx.storage.get<Phase>('phase')) === 'running' && task?.state === 'running' && (attempt === undefined || task.attempts === attempt) && owned;
  }

  /** A vessel finished: the queue had nothing left for it. A run it lost track of ends once its container is `gone`. */
  async retired(name: string, gone = false): Promise<void> {
    if (gone) this.runs.gone(name);
    this.beat(name, 'done');
    await this.settle();
  }

  /** A vessel was lost: its task goes back on the queue (or is failed after its second loss), and a vessel replaces it
   *  while there is work it could take. A vessel whose start found its snapshot `missing` is not replaced from it:
   *  every start from it would fail alike, so the pool refills from the job's environment, prepared again. Its runs
   *  end only once its container is `gone`. */
  async vesselFailed(name: string, error: string, { missing, gone = false }: { readonly missing?: string; readonly gone?: boolean } = {}): Promise<void> {
    const spec = await this.spec();

    if (spec === undefined) return;

    // A container that may still be up may still run its tasks.
    if (gone) this.runs.gone(name);

    const took = Number(this.sql.exec('SELECT tasks FROM vessels WHERE name = ?', name).toArray()[0]?.['tasks'] ?? 0) > 0
      || Number(this.sql.exec(`SELECT COUNT(*) AS n FROM tasks WHERE (vessel = ? OR dup = ?) AND state IN ('running', 'landing')`, name, name).one()['n']) > 0
      || Number(this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE vessel = ?', name).one()['n']) > 0;

    // Only a vessel alive until now leaves a place in the pool: a report of one already failed or retired leaves none.
    const live = this.sql.exec(`SELECT 1 AS n FROM vessels WHERE name = ? AND state IN ${ALIVE}`, name).toArray().length > 0;

    this.sql.exec('UPDATE vessels SET state = ?, error = ?, beat = ? WHERE name = ?', 'failed', error.slice(0, 2000), Date.now(), name);
    // A lost vessel no longer stays for a straggler, so a live one may.
    this.sql.exec('DELETE FROM standby WHERE vessel = ?', name);

    if (missing === undefined && live) {
      // Its place is refilled from its budget, a lost start's apart from a loss under a task; past it, the job forfeits
      // the place, and runs on with one vessel fewer (`grow`). Decided before anything below lets an alarm grow the
      // pool, which would refill the place for nothing.
      const spent = (await this.ctx.storage.get<number>(took ? 'replaced' : 'rebooted')) ?? 0;
      const forfeited = (await this.ctx.storage.get<number>('forfeited')) ?? 0;

      if (spent < (took ? REPLACEMENTS : Math.max(REPLACEMENTS, spec.pool))) await this.ctx.storage.put(took ? 'replaced' : 'rebooted', spent + 1);
      else await this.ctx.storage.put('forfeited', forfeited + 1);
    }

    // A lost copy cannot end red: the other copy's held green is reported.
    for (const { idx } of this.sql.exec<{ idx: number }>('UPDATE tasks SET dup = NULL, dup_slot = NULL WHERE dup = ? RETURNING idx', name).toArray()) await this.release(idx);
    this.lostRank(name, error);

    for (const task of this.sql.exec<{ idx: number; infra: number; dup: string | null; state: string }>(`SELECT idx, infra, dup, state FROM tasks WHERE vessel = ? AND state IN ('running', 'landing')`, name).toArray()) {
      if (task.state === 'landing' && (await this.ctx.storage.get(heldKey(task.idx))) !== undefined) {
        // Its answer is in, held for the other copy.
        continue;
      }

      if (task.dup !== null) {
        // The other copy runs on, if it has not stopped yet, as the only one, keeping the slot it ran in.
        this.sql.exec(`UPDATE tasks SET state = 'running', vessel = dup, dup = NULL, slot = dup_slot, dup_slot = NULL WHERE idx = ?`, task.idx);
      } else {
        this.lost(task.idx, task.infra, name, error);
      }
    }

    const generation = await this.ctx.storage.get<Generation>('environment');

    if (missing !== undefined) {
      // No replacement is spent on it. The job's own snapshot is prepared again; a start from one it already moved
      // on from leaves the pool to refill from the new one.
      if (generation?.snapshot.id === missing) {
        await this.ctx.storage.delete('environment');
        await this.env.ENVIRONMENTS.getByName(SINGLE).lost(generation.key, missing);
      }

      await this.awaitEnvironment(spec);
    }

    await this.grow();
    await this.settle();
  }

  /** A lost vessel's gangs, each lost whole as the platform's loss of one of its ranks, forming, launching or
   *  launched: queued again as one task to form anew, or failed after INFRA_ATTEMPTS losses. Its other ranks' runs end
   *  at their next `still`, and a late launch or answer of theirs is of an attempt no longer the task's. */
  private lostRank(name: string, error: string): void {
    for (const { idx, infra } of this.sql.exec<{ idx: number; infra: number }>(
      `SELECT t.idx, t.infra FROM members m JOIN tasks t ON t.idx = m.idx WHERE m.vessel = ? AND t.state IN ('forming', 'running', 'landing')`, name,
    ).toArray()) {
      this.sql.exec('DELETE FROM members WHERE idx = ?', idx);
      this.lost(idx, infra, name, error);
    }
  }

  /** Task `index`, which the infrastructure lost on `name` `infra` times before, queued again, or failed once that makes
   *  INFRA_ATTEMPTS. */
  private lost(index: number, infra: number, name: string, error: string): void {
    if (infra + 1 < INFRA_ATTEMPTS) {
      this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, slot = NULL, dup = NULL, dup_slot = NULL, infra = infra + 1 WHERE idx = ?`, index);

      return;
    }

    this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, index);
    this.append({ index, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: name, attempt: INFRA_ATTEMPTS, tail: error.slice(-4000), output: false });
  }

  /** A formed gang whose ranks did not all launch within its start bound fails: its launch is bounded by wall time, not
   *  by its ranks' heartbeats or task timers, which arm only once it launched. A forming gang is not bounded: its ranks
   *  join as vessels come free, however long their tasks before take (#35). */
  private async watchGangs(spec: Kept): Promise<void> {
    const timeout = spec.gangStartTimeout ?? GANG_START_SECONDS;
    const launching = this.sql.exec<{ idx: number; started: number }>(`SELECT t.idx, t.started FROM tasks t WHERE ${LAUNCHING}`).toArray();

    for (const { idx, started } of launching) {
      if (Date.now() - started < timeout * 1000) continue;
      const pending = this.sql.exec<{ rank: number }>(`SELECT rank FROM members WHERE idx = ? AND state IN ${UNLAUNCHED} ORDER BY rank`, idx).toArray().map(({ rank }) => rank);

      await this.failGang(idx, 'GangStartDeadlineExceeded', `gang start deadline exceeded after ${String(timeout)} s: not every rank launched (pending ranks ${pending.join(', ')})`);
    }
  }

  /** One failed gang, reported before stopping its peers: even a stop RPC that never answers cannot hide the failure.
   *  Membership stays to refuse late answers, and each run ends only when its container is confirmed gone. */
  private async failGang(index: number, error: string, reason: string, vessel = ''): Promise<void> {
    const task = this.sql.exec<{ attempts: number }>(`UPDATE tasks SET state = 'failed' WHERE idx = ? AND state IN ('forming', 'running', 'landing') RETURNING attempts`, index).toArray()[0];

    if (task === undefined) return;
    this.append({ index, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel, attempt: task.attempts, tail: reason, output: false, error });
    await this.ctx.storage.put('problems', [...(await this.ctx.storage.get<string[]>('problems')) ?? [], `${error}: ${reason}`]);
    await this.settle();

    const id = (await this.ctx.storage.get<string>('id')) ?? '';

    const peers = this.sql.exec<{ name: string }>(`SELECT v.name FROM vessels v JOIN members m ON m.vessel = v.name
      WHERE m.idx = ? AND v.state IN ${ALIVE}`, index).toArray();

    const stopped = await Promise.allSettled(peers.map(async ({ name }) => await this.env.VESSEL.getByName(`${id}/${name}`).stop()));

    for (const [at, { name }] of peers.entries()) {
      const each = stopped[at];

      if (each?.status !== 'fulfilled' || !each.value) continue;
      this.runs.gone(name);
      this.beat(name, 'done');
    }

    // Stopping a partial gang must not strand the job's remaining tasks with a pool too small to run them.
    await this.grow();
  }

  /** Done once the job is closed, no task is queued or running, and no vessel can still take one. The job grows to what
   *  its open tasks need, within its capacity (`grow`), so a task still to start that needs more containers at once than
   *  its capacity never runs, and is lost: every one once its capacity is spent. A running task holds its own, and a
   *  gang's rank that ended may leave. A task whose cache read is still out is settled by the method that reads it. */
  private async settle(): Promise<void> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<Phase>('phase')) !== 'running' || (await this.ctx.storage.get<boolean>('open')) === true) return;

    if (this.count(`state = 'checking'`) > 0) return;
    const alive = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM vessels WHERE state IN ${ALIVE}`).one()['n']);
    const capacity = await this.capacity(spec);
    // A job without its environment is waiting for it prepared again, and vessels for its open tasks with it.
    const awaiting = (await this.ctx.storage.get<Generation>('environment')) === undefined;
    const stranded = awaiting ? [] : this.sql.exec<{ idx: number; ranks: number }>(`SELECT idx, ${RANKS} AS ranks FROM tasks WHERE state IN ('queued', 'forming') AND ${RANKS} > ?`, capacity).toArray();

    if (stranded.length > 0) {
      // Why the vessels are not there, in their own last distinct failures, most recent first.
      const errors = [...new Set(this.sql.exec<{ error: string }>(`SELECT error FROM vessels WHERE state = 'failed' AND error IS NOT NULL ORDER BY beat DESC, rowid DESC`)
        .toArray().map(({ error }) => error))].slice(0, 3);

      const started = Number(this.sql.exec('SELECT COUNT(*) AS n FROM vessels WHERE boot_ms IS NOT NULL').one()['n']);

      // A snapshot that does not start fails every vessel the same way, so the job names its environment once.
      if (alive === 0 && started === 0 && errors.length > 0) {
        const key = (await this.ctx.storage.get<string>('key')) ?? '';

        await this.ctx.storage.put('problems', [...(await this.ctx.storage.get<string[]>('problems')) ?? [], `no container started from environment ${key.slice(0, 12)}: ${errors[0] ?? ''}`]);
      }

      for (const task of stranded) {
        const left = capacity <= 0 ? 'no vessel was left to run it' : `only ${String(capacity)} of the ${String(task.ranks)} vessels its ranks need were left`;
        const tail = [left, ...errors.map((error) => failureTail('', error))].join('\n');

        this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
        this.append({ index: task.idx, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: '', attempt: 0, tail, output: false });
      }
    }

    if (this.count(OPEN) > 0) return;
    await this.conclude();
  }

  private async conclude(): Promise<void> {
    // Reading the spec moves the env of a job an earlier Worker created out of it, so this deletes that env too.
    await this.spec();
    await this.ctx.storage.delete('env');
    await this.ctx.storage.put({ phase: 'done' satisfies Phase, finishedAt: Date.now(), owed: ['closed', 'used', 'unpinned'] satisfies Owed[] });
    await this.settleUp();
  }

  /** What the done job still owes, said: its close to the fleet, its environment's use up to now to the registry, its
   *  hold on its bundle, and its runs' use to their classes' stores (`send`). Each is idempotent and said again at the next alarm until it is
   *  taken; the alarm stays until all are. */
  private async settleUp(): Promise<void> {
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const owed = (await this.ctx.storage.get<Owed[]>('owed')) ?? [];

    const taken = await Promise.allSettled(owed.map(async (each) => {
      if (each === 'closed') await this.env.FLEET.getByName(SINGLE).closed(id);
      else if (each === 'unpinned') await this.env.TASKS.getByName(SINGLE).unpin(id);
      // The environment was in use until now: its recent hour starts here (`ArmadaEnvironments.used`).
      else await this.env.ENVIRONMENTS.getByName(SINGLE).used(await this.environment());
    }));

    const left = owed.filter((each, at) => {
      const told = taken[at];

      if (told?.status === 'rejected') console.error(JSON.stringify({ job: id, owed: each, error: String(told.reason) }));

      return told?.status !== 'fulfilled';
    });

    await this.ctx.storage.put('owed', left);
    await this.send();

    if (left.length > 0 || this.placement.pending()) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  /** Ends the job: each task not done fails, `cancelled` by its client or its deadline, or `lost` with its environment. */
  async cancel(reason: string, why: 'cancelled' | 'lost'): Promise<void> {
    if ((await this.ctx.storage.get<Phase>('phase')) === 'done') return;
    await this.ctx.storage.put({ problems: [...(await this.ctx.storage.get<string[]>('problems')) ?? [], reason], open: false });

    for (const task of this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state IN ('queued', 'checking', 'forming', 'running', 'landing')`).toArray()) {
      const outcome: Outcome = { index: task.idx, kind: 'failed', reason: why, exitCode: -1, seconds: 0, vessel: '', attempt: 0, tail: reason, output: false };

      this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
      this.append(outcome);
    }

    await this.conclude();
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const live = this.sql.exec<{ name: string }>(`SELECT name FROM vessels WHERE state IN ${ALIVE}`).toArray();

    // The job is concluded already; a vessel that cannot be told ends at its container's inactivity timeout, and its
    // runs stay until then.
    const stopped = await Promise.allSettled(live.map(async ({ name }) => await this.env.VESSEL.getByName(`${id}/${name}`).stop()));

    for (const [at, { name }] of live.entries()) {
      const each = stopped[at];

      if (each?.status === 'fulfilled' && each.value) this.runs.gone(name);
    }
  }

  private async watch(): Promise<void> {
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const now = Date.now();

    for (const vessel of this.sql.exec<{ name: string; state: 'waiting' | 'booting' | 'working'; beat: number }>(`SELECT name, state, beat FROM vessels WHERE state IN ${ALIVE}`).toArray()) {
      if (now - vessel.beat <= SILENT_MS[vessel.state]) continue;
      const [stopped] = await Promise.allSettled([this.env.VESSEL.getByName(`${id}/${vessel.name}`).stop()]);

      await this.vesselFailed(vessel.name, `not heard from for ${String(Math.floor((now - vessel.beat) / 1000))} s while ${vessel.state}`, { gone: stopped.status === 'fulfilled' && stopped.value });
    }
  }

  /** Outcomes after `after`, in order, and whether the job is done. */
  async events(after: number): Promise<{ events: { seq: number; outcome: Outcome; at?: number }[]; done: boolean }> {
    const rows = this.sql.exec<{ seq: number; outcome: string; at: number | null }>('SELECT seq, outcome, at FROM events WHERE seq > ? ORDER BY seq LIMIT 2000', after).toArray();
    const done = (await this.ctx.storage.get<Phase>('phase')) === 'done';
    const last = rows.at(-1)?.seq ?? after;
    const more = Number(this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE seq > ?', last).one()['n']) > 0;

    return { events: rows.map((row) => ({ seq: row.seq, outcome: v.parse(OutcomeSchema, JSON.parse(row.outcome)), at: row.at ?? undefined })), done: done && !more };
  }

  /** Each task running now on each container it runs on: a task on its vessel and on the vessel repeating it, a gang
   *  on each rank's. */
  private running(): { index: number; vessel: string; started: number; slot: number }[] {

    return this.sql.exec<{ index: number; vessel: string; started: number; slot: number | null }>(`SELECT idx AS "index", vessel, started, slot FROM tasks
      WHERE state IN ('running', 'landing') AND vessel IS NOT NULL AND idx NOT IN (SELECT idx FROM members)
      UNION ALL SELECT idx, dup, started, dup_slot FROM tasks WHERE state = 'running' AND dup IS NOT NULL
      UNION ALL SELECT m.idx, m.vessel, t.started, NULL FROM members m JOIN tasks t ON t.idx = m.idx WHERE t.state IN ('running', 'landing') AND m.state IN ('running', 'landing')
      ORDER BY 1, 2`).toArray().map((row) => ({ index: row.index, vessel: row.vessel, started: row.started, slot: row.slot ?? 0 }));
  }

  /** The key of the environment the job's containers start from, which `prune` keeps while the job is open. */
  async environment(): Promise<string> {
    return (await this.ctx.storage.get<string>('key')) ?? '';
  }

  /** Task `index`'s status for its job's status token (`GET /status/<job>/<index>`), with every run of it that may
   *  still be going (`Runs`); or why there is none: the job has no such task, or an earlier Worker made the job and
   *  recorded none of its runs, so none can be said to be over. */
  async taskStatus(index: number): Promise<{ readonly status: TaskStatus } | { readonly refused: string; readonly code: 404 | 409 }> {
    const id = await this.ctx.storage.get<string>('id');
    const task = this.sql.exec<{ state: string; attempts: number }>('SELECT state, attempts FROM tasks WHERE idx = ?', index).toArray()[0];

    if (id === undefined || task === undefined) return { refused: 'no such task', code: 404 };

    if ((await this.ctx.storage.get<boolean>('recorded')) !== true) return { refused: `job ${id} began before its runs were recorded, so none can be said to be over`, code: 409 };
    const phase = (await this.ctx.storage.get<Phase>('phase')) ?? 'done';
    const [last] = this.sql.exec<{ outcome: string }>(`SELECT outcome FROM events WHERE json_extract(outcome, '$.index') = ? ORDER BY seq DESC LIMIT 1`, index).toArray();
    const ended = task.state === 'exited' || task.state === 'failed' ? task.state : undefined;
    const outcome = ended === undefined || last === undefined ? undefined : v.parse(OutcomeSchema, JSON.parse(last.outcome));

    return {
      status: {
        job: id, phase, index, attempt: task.attempts, state: ended ?? (task.state === 'running' || task.state === 'landing' ? 'running' : 'queued'),
        running: this.runs.of(index), exitCode: outcome?.exitCode, reason: outcome?.reason,
      },
    };
  }

  async status(): Promise<JobStatus | null> {
    const id = await this.ctx.storage.get<string>('id');

    if (id === undefined) return null;
    const generation = await this.ctx.storage.get<Generation>('environment');

    const vessels = this.sql.exec<{ name: string; state: VesselRow['state']; tasks: number; boot_ms: number | null; boot: string | null; busy_ms: number; error: string | null }>(
      'SELECT name, state, tasks, boot_ms, boot, busy_ms, error FROM vessels ORDER BY rowid',
    ).toArray();

    const red = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM events WHERE json_extract(outcome, '$.kind') = 'exited' AND json_extract(outcome, '$.exitCode') != 0`).one()['n']);

    return {
      id, label: (await this.spec())?.label ?? '',
      phase: (await this.ctx.storage.get<Phase>('phase')) ?? 'done',
      key: (await this.ctx.storage.get<string>('key')) ?? '',
      createdAt: (await this.ctx.storage.get<number>('createdAt')) ?? 0,
      startedAt: (await this.ctx.storage.get<number>('startedAt')) ?? null,
      finishedAt: (await this.ctx.storage.get<number>('finishedAt')) ?? null,
      tasks: {
        total: this.count('1 = 1'), queued: this.count(`state IN ('queued', 'checking')`), running: this.count(`state IN ('running', 'landing')`),
        exited: this.count(`state = 'exited'`), red, failed: this.count(`state = 'failed'`),
      },
      vessels: vessels.map((row) => ({
        name: row.name, state: row.state, tasks: row.tasks, bootMs: row.boot_ms, boot: row.boot === null ? undefined : v.parse(BootSchema, JSON.parse(row.boot)), busyMs: row.busy_ms, error: row.error,
      })),
      problems: (await this.ctx.storage.get<string[]>('problems')) ?? [],
      environment: generation === undefined ? null : { key: generation.key, sha: generation.sha, created: generation.created, seconds: generation.seconds },
      running: this.running(),
    };
  }
}
