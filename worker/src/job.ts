/**
 * ArmadaJob: one map. It waits for the job's environment, starts a pool of vessels (one container each, as many as
 * the job allows and its items need), and hands them tasks from one queue, longest first, until it drains. A vessel
 * pays its boot once and then pulls task after task, so short and long tasks balance themselves. Each task's outcome
 * is appended to the job's event stream as it lands. A task a vessel lost to the infrastructure is queued again once;
 * a task that exited, red or green, never is. When the queue is empty, an idle vessel may run a straggler again only
 * if the job says its tasks are speculative; the first answer is kept. An open job takes more items until its client
 * closes it, starting vessels for them as they come.
 *
 * A gang task (an item's `gang`, `gangOf`) runs on that many vessels at once. The vessels that ask for work join the
 * gang forming, in rank order, before any other task starts, and the gang starts once every rank has joined; each rank
 * gets ARMADA_RANK and ARMADA_WORLD, and the gang a token its relay presents (`relay.ts`). A rank lost to the
 * infrastructure loses the whole gang, which is queued again as one task. The task's outcome is its first failing
 * rank's, else rank 0's, whose output and log are the task's. A gang's answer is never cached.
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
  ANSWER_PATH, ARTIFACTS_PATH, BUNDLE_PATH, cacheKey, environmentKey, gangOf, INLINE_BYTES, MAX_TASKS, OUT_PATH, OutcomeSchema, refusal, SIZES, TaskSchema, weightOf, workdirOf,
  type JobSpec, type JobStatus, type Json, type Outcome, type Task, type VesselRow,
} from '../../src/protocol';
import { said, SINGLE, textOf, type Env } from './env';
import { commandEnv, type Generation } from './environments';
import { instanceOf, TASK_GROUP } from './container';
import type { VesselSpec } from './vessel';

type Phase = JobStatus['phase'];

/** What the job keeps of its spec: everything but its items (in the `tasks` table), its env (under `env`) and whether
 *  it is open (under `open`). */
type Kept = Omit<JobSpec, 'items' | 'env' | 'open'>;

/** A task the vessel should run: its index, attempt, argv and environment. */
export interface Claim {
  readonly index: number;
  readonly attempt: number;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  /** The names of the secrets in `env`, whose values the vessel masks in the task's log. */
  readonly secrets: readonly string[];
  /** Where a green answer is cached, and until when, for a job that keeps a cache: the vessel writes it before it
   *  reports the outcome, so a later item like this one finds it. */
  readonly cache?: { readonly key: string; readonly expires: number };
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

/** How long a rank waits before it asks again whether its gang has formed. */
const GANG_WAIT_MS = 1_000;

/** The states a task is open in: not yet run, a gang gathering its ranks, running, or its answer landing. */
const OPEN = `state IN ('queued', 'forming', 'running', 'landing')`;

/** The containers the open tasks need at once: one each, a gang's each rank. */
const NEEDED = `SELECT COALESCE(SUM(CASE WHEN json_type(item, '$.item.gang') = 'integer' THEN json_extract(item, '$.item.gang') ELSE 1 END), 0) AS n
  FROM tasks WHERE ${OPEN}`;


const WATCHDOG_MS = 15_000;

/** A vessel that has not been heard from in this long, while booting or working, is lost. */
const SILENT_MS = { waiting: 60 * 60_000, booting: 8 * 60_000, working: 4 * 60_000 } as const;

/** Lost vessels a job replaces before it stops replacing them. */
const REPLACEMENTS = 8;

/** A task the infrastructure failed this many times is reported failed, not queued again. At two, a Dew CI run of 224
 *  tasks failed two of them, in which 24 of its 158 containers had stopped under their tasks. */
const INFRA_ATTEMPTS = 3;

/** A running task older than this, and than twice its weight, is a straggler an idle vessel may repeat. */
const STRAGGLER_MS = 30_000;

const JOB_DEADLINE_MS = 6 * 60 * 60_000;

/** The cache lookups a job makes at once. */
const CACHE_READS = 32;

const DAY_MS = 24 * 60 * 60_000;

export class ArmadaJob extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  /** The tasks whose cache read this object is making now (`answerFromCache`). */
  private readonly looking = new Set<number>();

  /** Whether this object has made sure of the `events` table's `at` column (`stamped`). */
  private stampedEvents = false;

  async create(id: string, spec: JobSpec, origin = ''): Promise<void> {
    if (await this.ctx.storage.get('spec')) throw new Error(`job ${id} exists`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (idx INTEGER PRIMARY KEY, item TEXT NOT NULL, weight REAL NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, infra INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0,
      vessel TEXT, started INTEGER, dup TEXT)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT NOT NULL, at INTEGER)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vessels (name TEXT PRIMARY KEY, state TEXT NOT NULL, tasks INTEGER NOT NULL DEFAULT 0,
      boot_ms INTEGER, busy_ms INTEGER NOT NULL DEFAULT 0, error TEXT, beat INTEGER NOT NULL)`);
    this.members();
    const { items, env, open, ...kept } = spec;

    this.insert(items);
    await this.ctx.storage.put({ id, spec: kept satisfies Kept, env, open, origin, phase: 'preparing' satisfies Phase, key: await environmentKey(spec.recipe), createdAt: Date.now(), problems: [], replaced: 0 });
    await this.ctx.storage.setAlarm(Date.now());
    await this.env.FLEET.getByName(SINGLE).opened(id);
  }

  /** The ranks of each gang task, by vessel: `joined` while the gang forms, `ready` once it formed, `running` once the
   *  rank claimed it, `landing` while its answer lands, `done` with its outcome. Made here for a job an earlier Worker
   *  created. */
  private members(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS members (idx INTEGER NOT NULL, rank INTEGER NOT NULL, vessel TEXT NOT NULL, state TEXT NOT NULL,
      outcome TEXT, PRIMARY KEY (idx, rank))`);
  }

  /** The `events` table with its `at` column: added here to the table of a job an earlier Worker created. */
  private stamped(): void {
    if (this.stampedEvents) return;

    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(events)').toArray().some((column) => column.name === 'at')) this.sql.exec('ALTER TABLE events ADD COLUMN at INTEGER');
    this.stampedEvents = true;
  }

  /** A task's one outcome, onto the stream with when it landed. */
  private append(outcome: Outcome): void {
    this.stamped();
    this.sql.exec('INSERT INTO events (outcome, at) VALUES (?, ?)', JSON.stringify(outcome), Date.now());
  }

  /** The new tasks' indexes. */
  private insert(items: readonly Task[]): number[] {
    const first = this.count('1 = 1');

    items.forEach((task, at) => {
      this.sql.exec('INSERT INTO tasks (idx, item, weight, state) VALUES (?, ?, ?, ?)', first + at, JSON.stringify(task), weightOf(task.item), 'queued');
    });

    return items.map((_, at) => first + at);
  }

  /** More items for an open job, and the vessels they need; or why the job refuses them. */
  async add(items: readonly Task[]): Promise<string | null> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<boolean>('open')) !== true || (await this.ctx.storage.get<Phase>('phase')) === 'done') return 'the job takes no more items';
    const refused = refusal(spec.run, items, spec.pool) ?? (this.count('1 = 1') + items.length > MAX_TASKS ? `a job takes at most ${String(MAX_TASKS)} items` : null);

    if (refused !== null) return refused;
    const added = this.insert(items);

    await this.answerFromCache(spec, added);
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

  private async spec(): Promise<Kept | undefined> {
    const stored = await this.ctx.storage.get<Kept & { readonly env?: Record<string, string> }>('spec');

    if (stored?.env === undefined) return stored;
    // A job created before its env had a key of its own: the env moves there while the job runs, and is gone once
    // it is done.
    const { env, ...kept } = stored;

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'done') await this.ctx.storage.put('env', env);
    await this.ctx.storage.put('spec', kept);

    return kept;
  }

  override async alarm(): Promise<void> {
    const spec = await this.spec();
    const phase = await this.ctx.storage.get<Phase>('phase');

    if (spec === undefined || phase === undefined || phase === 'done') return;
    this.requeueUnread();

    if (Date.now() - ((await this.ctx.storage.get<number>('createdAt')) ?? 0) > JOB_DEADLINE_MS) return await this.cancel('the job passed its deadline', 'cancelled');

    if (phase === 'preparing') await this.awaitEnvironment(spec);
    else await this.watch();

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'done') await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  private async awaitEnvironment(spec: Kept): Promise<void> {
    const key = (await this.ctx.storage.get<string>('key')) ?? '';
    const readiness = await this.env.ENVIRONMENTS.getByName(SINGLE).ensure(key, spec.recipe, spec.commit ?? null);

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'preparing') return;

    if (readiness.kind === 'failed') return await this.cancel(`the environment ${key.slice(0, 12)} could not be prepared: ${readiness.reason}`, 'lost');

    if (readiness.kind === 'preparing') return;

    if (spec.commit !== undefined && spec.commit.base !== 'root' && spec.commit.base !== readiness.generation.sha) {
      return await this.cancel(`the environment was rebuilt from ${String(readiness.generation.sha).slice(0, 10)} after this job was packed against ${spec.commit.base.slice(0, 10)}; run again`, 'lost');
    }

    await this.answerFromCache(spec, this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state = 'queued' AND attempts = 0`).toArray().map((row) => row.idx));

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'preparing') return;
    await this.ctx.storage.put({ phase: 'running' satisfies Phase, environment: readiness.generation, startedAt: Date.now() });
    await this.grow();
    await this.settle();
  }

  /**
   * Answers each of `indexes` the job's cache holds, with nothing run: its output is copied to the task's, and its
   * outcome says `cached`. Each task is reserved (`checking`) before the first read, so no vessel claims one whose
   * output a copy could overwrite; a miss, or a read or copy that fails, gives it back to the queue.
   */
  private async answerFromCache(spec: Kept, indexes: readonly number[]): Promise<void> {
    if (spec.cache === undefined || spec.run.kind !== 'task' || spec.run.bundle === undefined) return;
    const reserved = indexes.flatMap((index) => this.sql.exec<{ idx: number; item: string }>(
      `UPDATE tasks SET state = 'checking' WHERE idx = ? AND state = 'queued' AND attempts = 0 RETURNING idx, item`, index,
    ).toArray());

    for (const row of reserved) this.looking.add(row.idx);
    const { bundle, id: task } = spec.run;
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const environment = (await this.ctx.storage.get<string>('key')) ?? '';

    for (let from = 0; from < reserved.length; from += CACHE_READS) {
      await Promise.all(reserved.slice(from, from + CACHE_READS).map(async (row) => {
        const index = row.idx;
        const answered = await this.cachedAnswer(bundle, task, environment, index, v.parse(TaskSchema, JSON.parse(row.item)).item).catch((cause: unknown) => {
          console.error(JSON.stringify({ job: id, index, cache: said(cause) }));

          return null;
        });

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

  /** The cached answer of `item` as task `index`'s outcome, with the key its output is read from; or null when the cache
   *  holds none. Nothing is copied: a small answer rides in the outcome, and a large one is read where it is cached. */
  private async cachedAnswer(bundle: string, task: string, environment: string, index: number, item: Json): Promise<{ readonly outcome: Outcome; readonly key: string } | null> {
    const key = await cacheKey(bundle, task, environment, item);
    const cached = await this.env.ARTIFACTS.head(key);

    if (cached === null || Number(cached.customMetadata?.['expires'] ?? 0) < Date.now()) return null;
    const small = cached.size <= INLINE_BYTES ? await (await this.env.ARTIFACTS.get(key))?.arrayBuffer() : undefined;
    const answer = cached.customMetadata?.['answer'];
    const value = small === undefined ? undefined : textOf(small);
    const outcome: Outcome = {
      index, kind: 'exited', exitCode: 0, seconds: 0, vessel: 'cache', attempt: 0, tail: '', output: true, cached: true,
      ...value === undefined ? {} : { value }, ...answer === 'value' || answer === 'command' ? { answer } : {},
    };

    return { outcome, key };
  }

  /** Where task `index`'s output is cached, for a task answered from the cache; else undefined. */
  async cachedFrom(index: number): Promise<string | undefined> {
    return await this.ctx.storage.get<string>(`cached:${String(index)}`);
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
    const alive = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM vessels WHERE state IN ('waiting', 'booting', 'working')`).one()['n']);
    const named = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM vessels WHERE name LIKE 'v%'`).one()['n']);
    const wanted = Math.min(spec.pool, Number(this.sql.exec(NEEDED).one()['n'])) - alive;
    const names = Array.from({ length: Math.max(0, wanted) }, (_, index) => `v${String(named + index + 1)}`);

    for (const name of names) this.sql.exec('INSERT INTO vessels (name, state, beat) VALUES (?, ?, ?)', name, 'waiting', Date.now());
    await Promise.all(names.map(async (name) => await this.launch(spec, generation, name)));
  }

  private async launch(spec: Kept, generation: Generation, name: string): Promise<void> {
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const vessel: VesselSpec = {
      jobId: id, name, snapshot: generation.snapshot.id, instance: instanceOf(spec.recipe.size), vcpus: SIZES[spec.recipe.size].vcpus,
      workdir: workdirOf(spec.recipe), commit: spec.commit === undefined || spec.recipe.repo === undefined ? null : { ...spec.commit, project: spec.recipe.repo.project, history: spec.recipe.repo.history },
      tmpfs: spec.tmpfs, files: spec.files, bundle: spec.run.kind === 'task' ? spec.run.bundle ?? null : null, output: spec.output, timeout: spec.timeout,
    };

    try {
      await this.env.VESSEL.getByName(`${id}/${name}`).begin(vessel);
    } catch (cause) {
      await this.vesselFailed(name, `could not start: ${said(cause)}`);
    }
  }

  private count(where: string): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).one()['n']);
  }

  private beat(name: string, state?: VesselRow['state']): void {
    if (state === undefined) this.sql.exec('UPDATE vessels SET beat = ? WHERE name = ?', Date.now(), name);
    else this.sql.exec('UPDATE vessels SET beat = ?, state = ? WHERE name = ?', Date.now(), state, name);
  }

  /** A vessel is up: how long its container took to answer. */
  async booted(name: string, bootMs: number): Promise<void> {
    this.sql.exec('UPDATE vessels SET boot_ms = ?, state = ?, beat = ? WHERE name = ?', bootMs, 'working', Date.now(), name);
  }

  async waiting(name: string): Promise<void> {
    this.beat(name, 'waiting');
  }

  /** The next task for `name`; how long to wait, while the gang it joined gathers its ranks or the only tasks left wait
   *  out a retry's backoff; or null when there is none left for it: the vessel then stops. */
  async claim(name: string): Promise<Claim | { readonly waitMs: number } | null> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<Phase>('phase')) !== 'running') return null;
    this.beat(name, 'working');
    this.members();
    const now = Date.now();
    // Secrets are read for each claim and never kept: the job holds only their names.
    const env = { ...(await this.ctx.storage.get<Record<string, string>>('env')) ?? {}, ...await this.secrets(spec) };
    const ganged = await this.rank(spec, env, name);

    if (ganged !== undefined) return ganged;
    const first = this.sql.exec<{ idx: number; item: string }>(`SELECT idx, item FROM tasks WHERE state = 'queued' AND not_before <= ? ORDER BY weight DESC, idx LIMIT 1`, now).toArray()[0];

    if (first !== undefined && gangOf(v.parse(TaskSchema, JSON.parse(first.item)).item) > 1) {
      // A gang forms from the vessels that ask next, this one rank 0.
      this.sql.exec(`UPDATE tasks SET state = 'forming' WHERE idx = ?`, first.idx);
      this.sql.exec(`INSERT INTO members (idx, rank, vessel, state) VALUES (?, 0, ?, 'joined')`, first.idx, name);

      return { waitMs: GANG_WAIT_MS };
    }
    const next = first === undefined ? undefined : this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET state = 'running', vessel = ?, started = ?, attempts = attempts + 1 WHERE idx = ? RETURNING idx, item, attempts`, name, now, first.idx,
    ).toArray()[0];

    if (next !== undefined) return await this.cached(spec, this.claimOf(spec, env, next.idx, next.item, next.attempts, false), next.item);
    const [later] = this.sql.exec<{ at: number | null }>(`SELECT MIN(not_before) AS at FROM tasks WHERE state = 'queued'`).toArray();

    // At most a minute at a time, so a waiting vessel still beats.
    if (later?.at !== null && later?.at !== undefined) return { waitMs: Math.min(60_000, Math.max(1000, later.at - now)) };

    if (!spec.speculative) {
      this.beat(name, 'done');

      return null;
    }
    // The queue is empty: repeat the oldest straggler nobody is repeating yet.
    const straggler = this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET dup = ? WHERE idx = (SELECT idx FROM tasks WHERE state = 'running' AND dup IS NULL AND vessel != ? AND idx NOT IN (SELECT idx FROM members)
       AND started < ? AND started < ? - weight * 2000 ORDER BY started LIMIT 1) RETURNING idx, item, attempts`, name, name, now - STRAGGLER_MS, now,
    ).toArray()[0];

    if (straggler !== undefined) return await this.cached(spec, this.claimOf(spec, env, straggler.idx, straggler.item, straggler.attempts, true), straggler.item);
    // It retires: marked now, so items an open job takes before its retirement lands get a vessel of their own.
    this.beat(name, 'done');

    return null;
  }

  /** `name`'s rank in a gang: its claim once the gang formed, a wait while it forms, joining the one forming if it is in
   *  none; undefined when no gang is forming or holds it. */
  private async rank(spec: Kept, env: Record<string, string>, name: string): Promise<Claim | { readonly waitMs: number } | undefined> {
    let mine = this.sql.exec<{ idx: number; state: string }>(
      `SELECT m.idx, m.state FROM members m JOIN tasks t ON t.idx = m.idx WHERE m.vessel = ? AND m.state IN ('joined', 'ready') AND t.state IN ('forming', 'running')`, name,
    ).toArray()[0];

    if (mine === undefined) {
      const forming = this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state = 'forming' ORDER BY idx LIMIT 1`).toArray()[0];

      if (forming === undefined) return undefined;
      this.sql.exec(`INSERT INTO members (idx, rank, vessel, state) VALUES (?, (SELECT COUNT(*) FROM members WHERE idx = ?), ?, 'joined')`, forming.idx, forming.idx, name);
      mine = { idx: forming.idx, state: 'joined' };
    }
    const task = this.sql.exec<{ item: string; attempts: number }>('SELECT item, attempts FROM tasks WHERE idx = ?', mine.idx).one();
    const world = gangOf(v.parse(TaskSchema, JSON.parse(task.item)).item);

    if (mine.state === 'joined') {
      if (Number(this.sql.exec('SELECT COUNT(*) AS n FROM members WHERE idx = ?', mine.idx).one()['n']) < world) return { waitMs: GANG_WAIT_MS };
      // Every rank has joined: the gang starts, under a token its relays present.
      this.sql.exec(`UPDATE tasks SET state = 'running', started = ?, attempts = attempts + 1, vessel = (SELECT vessel FROM members WHERE idx = ? AND rank = 0)
        WHERE idx = ?`, Date.now(), mine.idx, mine.idx);
      this.sql.exec(`UPDATE members SET state = 'ready' WHERE idx = ?`, mine.idx);
      await this.ctx.storage.put(`gang:${String(mine.idx)}`, [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
    const vessels = this.sql.exec<{ vessel: string }>('SELECT vessel FROM members WHERE idx = ? ORDER BY rank', mine.idx).toArray().map((row) => row.vessel);
    const rank = vessels.indexOf(name);
    const { attempts } = this.sql.exec<{ attempts: number }>('SELECT attempts FROM tasks WHERE idx = ?', mine.idx).one();

    this.sql.exec(`UPDATE members SET state = 'running' WHERE idx = ? AND vessel = ?`, mine.idx, name);
    const gang: Gang = {
      rank, vessels, job: (await this.ctx.storage.get<string>('id')) ?? '', origin: (await this.ctx.storage.get<string>('origin')) ?? '',
      token: (await this.ctx.storage.get<string>(`gang:${String(mine.idx)}`)) ?? '',
    };
    const claim = this.claimOf(spec, env, mine.idx, task.item, attempts, false);

    return { ...claim, env: { ...claim.env, ARMADA_RANK: String(rank), ARMADA_WORLD: String(world) }, gang };
  }

  /** `name`'s membership of gang task `index`, or undefined for a task that is no gang's or a vessel in none. */
  private member(name: string, index: number): { readonly rank: number; readonly state: string } | undefined {
    this.members();

    return this.sql.exec<{ rank: number; state: string }>('SELECT rank, state FROM members WHERE idx = ? AND vessel = ?', index, name).toArray()[0];
  }

  private claimOf(spec: Kept, own: Record<string, string>, index: number, stored: string, attempt: number, duplicate: boolean): Claim {
    const task = v.parse(TaskSchema, JSON.parse(stored));
    const env = {
      ...commandEnv(spec.recipe, own), ARMADA_ITEM: JSON.stringify(task.item) ?? 'null', ARMADA_INDEX: String(index), ARMADA_ATTEMPT: String(attempt),
      ARMADA_OUT: OUT_PATH, ARMADA_ANSWER: ANSWER_PATH, ARMADA_ARTIFACTS: ARTIFACTS_PATH, ARMADA_CGROUP: TASK_GROUP, ...spec.run.kind === 'task' ? { ARMADA_TASK: spec.run.id } : {},
    };

    return { index, attempt, argv: spec.run.kind === 'task' ? ['node', BUNDLE_PATH] : task.argv ?? ['false'], env, secrets: spec.secrets, duplicate };
  }

  /** `claim` with where its green answer is cached, when the job keeps a cache. */
  private async cached(spec: Kept, claim: Claim, stored: string): Promise<Claim> {
    if (spec.cache === undefined || spec.run.kind !== 'task' || spec.run.bundle === undefined) return claim;
    const key = await cacheKey(spec.run.bundle, spec.run.id, (await this.ctx.storage.get<string>('key')) ?? '', v.parse(TaskSchema, JSON.parse(stored)).item);

    return { ...claim, cache: { key, expires: Date.now() + spec.cache.days * DAY_MS } };
  }

  /** The values of the secrets the job names that are still set: the runner says which was deleted. */
  private async secrets(spec: Kept): Promise<Record<string, string>> {
    return spec.secrets.length === 0 ? {} : await this.env.SECRETS.getByName(SINGLE).values(spec.secrets);
  }

  /** Whether `name`'s answer for `index` is the one kept: the first to land wins, a late duplicate is told no. */
  async accept(name: string, index: number): Promise<boolean> {
    const task = this.sql.exec<{ state: string; vessel: string | null; dup: string | null }>('SELECT state, vessel, dup FROM tasks WHERE idx = ?', index).toArray()[0];
    const member = this.member(name, index);

    if (member !== undefined) {
      if (task?.state !== 'running' || member.state !== 'running') return false;
      this.sql.exec(`UPDATE members SET state = 'landing' WHERE idx = ? AND vessel = ?`, index, name);

      return true;
    }

    if (task === undefined || task.state !== 'running' || (task.vessel !== name && task.dup !== name)) return false;
    this.sql.exec(`UPDATE tasks SET state = 'landing', vessel = ? WHERE idx = ?`, name, index);

    return true;
  }

  /** The kept answer, once its output and log are in R2: appended to the stream, or, for a failure the job's retries
   *  name, the task queued again after its backoff. */
  async complete(name: string, outcome: Outcome, busyMs: number): Promise<void> {
    const member = this.member(name, outcome.index);
    // A gang's outcome is kept once its ranks decide it (`ranked`).
    const kept = member === undefined ? outcome : this.ranked(name, member.rank, outcome);
    const retries = (await this.spec())?.retries;
    const task = kept === null ? undefined
      : this.sql.exec<{ retries: number }>(`SELECT retries FROM tasks WHERE idx = ? AND state = ?`, kept.index, member === undefined ? 'landing' : 'running').toArray()[0];
    const named = kept !== null && kept.exitCode !== 0
      && (retries?.exitCodes.includes(kept.exitCode) === true || (kept.error !== undefined && retries?.errors.includes(kept.error) === true));

    if (kept !== null && task !== undefined && retries !== undefined && named && task.retries + 1 < retries.attempts) {
      const backoff = retries.backoffSeconds * 1000 * 2 ** task.retries;

      // A gang forms again: its other ranks stop (`still`).
      this.sql.exec('DELETE FROM members WHERE idx = ?', kept.index);
      this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, dup = NULL, retries = retries + 1, not_before = ? WHERE idx = ?`, Date.now() + backoff, kept.index);
    } else if (kept !== null && task !== undefined) {
      // A task the job already ended (cancelled, or failed with a lost vessel) keeps the one outcome it has.
      this.sql.exec(`UPDATE tasks SET state = ? WHERE idx = ?`, kept.kind, kept.index);
      this.append(kept);
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

  /** Whether a vessel should keep running `index`: no, once someone else's answer landed, its gang ended or the job did. */
  async still(name: string, index: number): Promise<boolean> {
    this.beat(name);
    const task = this.sql.exec<{ state: string }>('SELECT state FROM tasks WHERE idx = ?', index).toArray()[0];
    const member = this.member(name, index);

    return (await this.ctx.storage.get<Phase>('phase')) === 'running' && task?.state === 'running'
      && (member === undefined || member.state === 'running' || member.state === 'landing');
  }

  /** A vessel finished: the queue had nothing left for it. */
  async retired(name: string): Promise<void> {
    this.beat(name, 'done');
    await this.settle();
  }

  /** A vessel was lost: its task goes back on the queue (or is failed after its second loss), and a vessel replaces it
   *  while there is work it could take. */
  async vesselFailed(name: string, error: string): Promise<void> {
    const spec = await this.spec();

    if (spec === undefined) return;
    this.sql.exec('UPDATE vessels SET state = ?, error = ?, beat = ? WHERE name = ?', 'failed', error.slice(0, 2000), Date.now(), name);
    this.sql.exec('UPDATE tasks SET dup = NULL WHERE dup = ?', name);
    this.lostRank(name, error);

    for (const task of this.sql.exec<{ idx: number; infra: number; dup: string | null }>(`SELECT idx, infra, dup FROM tasks WHERE vessel = ? AND state IN ('running', 'landing')`, name).toArray()) {
      if (task.dup !== null) {
        this.sql.exec('UPDATE tasks SET vessel = dup, dup = NULL WHERE idx = ?', task.idx);
      } else if (task.infra + 1 < INFRA_ATTEMPTS) {
        this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, infra = infra + 1 WHERE idx = ?`, task.idx);
      } else {
        this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
        const outcome: Outcome = { index: task.idx, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: name, attempt: INFRA_ATTEMPTS, tail: error.slice(-4000), output: false };

        this.append(outcome);
      }
    }

    const replaced = (await this.ctx.storage.get<number>('replaced')) ?? 0;
    const generation = await this.ctx.storage.get<Generation>('environment');

    if (this.count(`state IN ('queued', 'forming')`) > 0 && replaced < REPLACEMENTS && generation !== undefined && (await this.ctx.storage.get<Phase>('phase')) === 'running') {
      const next = `r${String(replaced + 1)}`;

      await this.ctx.storage.put('replaced', replaced + 1);
      this.sql.exec('INSERT INTO vessels (name, state, beat) VALUES (?, ?, ?)', next, 'waiting', Date.now());
      await this.launch(spec, generation, next);
    }

    await this.settle();
  }

  /** A lost vessel's gangs: a forming one closes its ranks up; a running one is lost whole, queued again as one task,
   *  or failed once the infrastructure lost it INFRA_ATTEMPTS times. Its other ranks stop (`still`). */
  private lostRank(name: string, error: string): void {
    this.members();

    for (const { idx, state, infra } of this.sql.exec<{ idx: number; state: string; infra: number }>(
      `SELECT t.idx, t.state, t.infra FROM members m JOIN tasks t ON t.idx = m.idx WHERE m.vessel = ? AND t.state IN ('forming', 'running', 'landing')`, name,
    ).toArray()) {
      if (state === 'forming') {
        this.sql.exec('DELETE FROM members WHERE idx = ? AND vessel = ?', idx, name);
        this.sql.exec('UPDATE members SET rank = (SELECT COUNT(*) FROM members AS before WHERE before.idx = members.idx AND before.rank < members.rank) WHERE idx = ?', idx);
        continue;
      }
      this.sql.exec('DELETE FROM members WHERE idx = ?', idx);

      if (infra + 1 < INFRA_ATTEMPTS) {
        this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, infra = infra + 1 WHERE idx = ?`, idx);
        continue;
      }
      this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, idx);
      const outcome: Outcome = { index: idx, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: name, attempt: INFRA_ATTEMPTS, tail: error.slice(-4000), output: false };

      this.append(outcome);
    }
  }

  /** Done once the job is closed, no task is queued or running, and no vessel can still take one. A task whose cache read
   *  is still out is settled by the method that reads it. */
  private async settle(): Promise<void> {
    if ((await this.ctx.storage.get<Phase>('phase')) !== 'running' || (await this.ctx.storage.get<boolean>('open')) === true) return;

    if (this.count(`state = 'checking'`) > 0) return;
    const open = this.count(OPEN);
    const alive = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM vessels WHERE state IN ('waiting', 'booting', 'working')`).one()['n']);

    if (open > 0 && alive > 0) return;

    if (open > 0) {
      const [failed] = this.sql.exec<{ error: string | null }>(`SELECT error FROM vessels WHERE state = 'failed' ORDER BY beat DESC LIMIT 1`).toArray();
      const started = Number(this.sql.exec('SELECT COUNT(*) AS n FROM vessels WHERE boot_ms IS NOT NULL').one()['n']);

      // A snapshot that does not start fails every vessel the same way, so the job names its environment once.
      if (started === 0 && failed?.error) {
        const key = (await this.ctx.storage.get<string>('key')) ?? '';

        await this.ctx.storage.put('problems', [...(await this.ctx.storage.get<string[]>('problems')) ?? [], `no container started from environment ${key.slice(0, 12)}: ${failed.error}`]);
      }

      for (const task of this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE ${OPEN}`).toArray()) {
        const outcome: Outcome = { index: task.idx, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: '', attempt: 0, tail: 'no vessel was left to run it', output: false };

        this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
        this.append(outcome);
      }
    }

    await this.conclude();
  }

  private async conclude(): Promise<void> {
    // Reading the spec moves the env of a job an earlier Worker created out of it, so this deletes that env too.
    await this.spec();
    await this.ctx.storage.delete('env');
    await this.ctx.storage.put({ phase: 'done' satisfies Phase, finishedAt: Date.now() });
    await this.ctx.storage.deleteAlarm();
    await this.env.FLEET.getByName(SINGLE).closed((await this.ctx.storage.get<string>('id')) ?? '');
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
    const live = this.sql.exec<{ name: string }>(`SELECT name FROM vessels WHERE state IN ('waiting', 'booting', 'working')`).toArray();

    // The job is concluded already; a vessel that cannot be told ends at its container's inactivity timeout.
    await Promise.allSettled(live.map(async ({ name }) => await this.env.VESSEL.getByName(`${id}/${name}`).stop()));
  }

  private async watch(): Promise<void> {
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const now = Date.now();

    for (const vessel of this.sql.exec<{ name: string; state: 'waiting' | 'booting' | 'working'; beat: number }>(`SELECT name, state, beat FROM vessels WHERE state IN ('waiting', 'booting', 'working')`).toArray()) {
      if (now - vessel.beat <= SILENT_MS[vessel.state]) continue;
      await Promise.allSettled([this.env.VESSEL.getByName(`${id}/${vessel.name}`).stop()]);
      await this.vesselFailed(vessel.name, `not heard from for ${String(Math.floor((now - vessel.beat) / 1000))} s while ${vessel.state}`);
    }
  }

  /** Outcomes after `after`, in order, and whether the job is done. */
  async events(after: number): Promise<{ events: { seq: number; outcome: Outcome; at?: number }[]; done: boolean }> {
    this.stamped();
    const rows = this.sql.exec<{ seq: number; outcome: string; at: number | null }>('SELECT seq, outcome, at FROM events WHERE seq > ? ORDER BY seq LIMIT 2000', after).toArray();
    const done = (await this.ctx.storage.get<Phase>('phase')) === 'done';
    const last = rows.at(-1)?.seq ?? after;
    const more = Number(this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE seq > ?', last).one()['n']) > 0;

    return { events: rows.map((row) => ({ seq: row.seq, outcome: v.parse(OutcomeSchema, JSON.parse(row.outcome)), ...row.at === null ? {} : { at: row.at } })), done: done && !more };
  }

  /** Each task running now on each container it runs on: a task on its vessel and on the vessel repeating it, a gang
   *  on each rank's. */
  private running(): { index: number; vessel: string; started: number }[] {
    this.members();

    return this.sql.exec<{ index: number; vessel: string; started: number }>(`SELECT idx AS "index", vessel, started FROM tasks
      WHERE state IN ('running', 'landing') AND vessel IS NOT NULL AND idx NOT IN (SELECT idx FROM members)
      UNION ALL SELECT idx, dup, started FROM tasks WHERE state = 'running' AND dup IS NOT NULL
      UNION ALL SELECT m.idx, m.vessel, t.started FROM members m JOIN tasks t ON t.idx = m.idx WHERE t.state IN ('running', 'landing') AND m.state IN ('running', 'landing')
      ORDER BY 1, 2`).toArray();
  }

  async status(): Promise<JobStatus | null> {
    const id = await this.ctx.storage.get<string>('id');

    if (id === undefined) return null;
    const generation = await this.ctx.storage.get<Generation>('environment');
    const vessels = this.sql.exec<{ name: string; state: VesselRow['state']; tasks: number; boot_ms: number | null; busy_ms: number; error: string | null }>(
      'SELECT name, state, tasks, boot_ms, busy_ms, error FROM vessels ORDER BY rowid',
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
      vessels: vessels.map((row) => ({ name: row.name, state: row.state, tasks: row.tasks, bootMs: row.boot_ms, busyMs: row.busy_ms, error: row.error })),
      problems: (await this.ctx.storage.get<string[]>('problems')) ?? [],
      environment: generation === undefined ? null : { key: generation.key, sha: generation.sha, created: generation.created, seconds: generation.seconds },
      running: this.running(),
    };
  }
}
