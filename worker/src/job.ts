/**
 * ArmadaJob: one map. It waits for the job's environment, starts a pool of vessels (one container each, as many as
 * the job allows and its items need), and hands them tasks from one queue, longest first, until it drains. A vessel
 * pays its boot once and then pulls task after task, so short and long tasks balance themselves. Each task's outcome
 * is appended to the job's event stream as it lands. A task a vessel lost to the infrastructure is queued again once;
 * a task that exited, red or green, never is. When the queue is empty, an idle vessel may run a straggler again only
 * if the job says its tasks are speculative; the first answer is kept.
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
  environmentKey, fill, itemValues, OutcomeSchema, SIZES, weightOf, workdirOf,
  type JobSpec, type JobStatus, type Outcome, type VesselRow,
} from '../../src/protocol';
import { said, SINGLE, type Env } from './env';
import { commandEnv, type Generation } from './environments';
import { instanceOf, STATE, TASK, TASK_GROUP } from './container';
import type { VesselSpec } from './vessel';

type Phase = JobStatus['phase'];

/** What the job keeps of its spec: everything but its items (in the `tasks` table) and its env (under `env`). */
type Kept = Omit<JobSpec, 'items' | 'env'>;

/** A task the vessel should run: its index, attempt, argv and environment. */
export interface Claim {
  readonly index: number;
  readonly attempt: number;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  /** A second run of a straggler: its answer is kept only if it lands first. */
  readonly duplicate: boolean;
}

const WATCHDOG_MS = 15_000;

/** A vessel that has not been heard from in this long, while booting or working, is lost. */
const SILENT_MS = { waiting: 60 * 60_000, booting: 8 * 60_000, working: 4 * 60_000 } as const;

/** Lost vessels a job replaces before it stops replacing them. */
const REPLACEMENTS = 8;

/** A task the infrastructure failed this many times is reported failed, not queued again. */
const INFRA_ATTEMPTS = 2;

/** A running task older than this, and than twice its weight, is a straggler an idle vessel may repeat. */
const STRAGGLER_MS = 30_000;

const JOB_DEADLINE_MS = 6 * 60 * 60_000;

export class ArmadaJob extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;

  async create(id: string, spec: JobSpec): Promise<void> {
    if (await this.ctx.storage.get('spec')) throw new Error(`job ${id} exists`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (idx INTEGER PRIMARY KEY, item TEXT NOT NULL, weight REAL NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, infra INTEGER NOT NULL DEFAULT 0, vessel TEXT, started INTEGER, dup TEXT)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vessels (name TEXT PRIMARY KEY, state TEXT NOT NULL, tasks INTEGER NOT NULL DEFAULT 0,
      boot_ms INTEGER, busy_ms INTEGER NOT NULL DEFAULT 0, error TEXT, beat INTEGER NOT NULL)`);
    const { items, env, ...kept } = spec;

    items.forEach((item, index) => {
      this.sql.exec('INSERT INTO tasks (idx, item, weight, state) VALUES (?, ?, ?, ?)', index, JSON.stringify(item), weightOf(item), 'queued');
    });
    await this.ctx.storage.put({ id, spec: kept satisfies Kept, env, phase: 'preparing' satisfies Phase, key: await environmentKey(spec.recipe), createdAt: Date.now(), problems: [], replaced: 0 });
    await this.ctx.storage.setAlarm(Date.now());
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

    if (Date.now() - ((await this.ctx.storage.get<number>('createdAt')) ?? 0) > JOB_DEADLINE_MS) return await this.cancel('the job passed its deadline');

    if (phase === 'preparing') await this.awaitEnvironment(spec);
    else await this.watch();

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'done') await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  private async awaitEnvironment(spec: Kept): Promise<void> {
    const key = (await this.ctx.storage.get<string>('key')) ?? '';
    const readiness = await this.env.ENVIRONMENTS.getByName(SINGLE).ensure(key, spec.recipe, spec.commit ?? null);

    if ((await this.ctx.storage.get<Phase>('phase')) !== 'preparing') return;

    if (readiness.kind === 'failed') return await this.cancel(`the environment ${key.slice(0, 12)} could not be prepared: ${readiness.reason}`);

    if (readiness.kind === 'preparing') return;

    if (spec.commit !== undefined && spec.commit.base !== 'root' && spec.commit.base !== readiness.generation.sha) {
      return await this.cancel(`the environment was rebuilt from ${String(readiness.generation.sha).slice(0, 10)} after this job was packed against ${spec.commit.base.slice(0, 10)}; run again`);
    }

    const total = this.count('1 = 1');
    const pool = Math.min(spec.pool, total);
    const names = Array.from({ length: pool }, (_, index) => `v${String(index + 1)}`);

    await this.ctx.storage.put({ phase: 'running' satisfies Phase, environment: readiness.generation, startedAt: Date.now() });

    for (const name of names) this.sql.exec('INSERT INTO vessels (name, state, beat) VALUES (?, ?, ?)', name, 'waiting', Date.now());
    await Promise.all(names.map(async (name) => await this.launch(spec, readiness.generation, name)));
  }

  private async launch(spec: Kept, generation: Generation, name: string): Promise<void> {
    const id = (await this.ctx.storage.get<string>('id')) ?? '';
    const vessel: VesselSpec = {
      jobId: id, name, snapshot: generation.snapshot.id, instance: instanceOf(spec.recipe.size), vcpus: SIZES[spec.recipe.size].vcpus,
      workdir: workdirOf(spec.recipe), commit: spec.commit === undefined || spec.recipe.repo === undefined ? null : { ...spec.commit, project: spec.recipe.repo.project, history: spec.recipe.repo.history },
      tmpfs: spec.tmpfs, files: spec.files, handler: 'handler' in spec.run ? spec.run.handler : null, output: spec.output, timeout: spec.timeout,
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

  /** The next task for `name`, or null when there is none left for it: the vessel then stops. */
  async claim(name: string): Promise<Claim | null> {
    const spec = await this.spec();

    if (spec === undefined || (await this.ctx.storage.get<Phase>('phase')) !== 'running') return null;
    this.beat(name, 'working');
    const now = Date.now();
    const next = this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET state = 'running', vessel = ?, started = ?, attempts = attempts + 1
       WHERE idx = (SELECT idx FROM tasks WHERE state = 'queued' ORDER BY weight DESC, idx LIMIT 1) RETURNING idx, item, attempts`, name, now,
    ).toArray()[0];

    const env = (await this.ctx.storage.get<Record<string, string>>('env')) ?? {};

    if (next !== undefined) return this.claimOf(spec, env, next.idx, next.item, next.attempts, false);

    if (!spec.speculative) return null;
    // The queue is empty: repeat the oldest straggler nobody is repeating yet.
    const straggler = this.sql.exec<{ idx: number; item: string; attempts: number }>(
      `UPDATE tasks SET dup = ? WHERE idx = (SELECT idx FROM tasks WHERE state = 'running' AND dup IS NULL AND vessel != ?
       AND started < ? AND started < ? - weight * 2000 ORDER BY started LIMIT 1) RETURNING idx, item, attempts`, name, name, now - STRAGGLER_MS, now,
    ).toArray()[0];

    return straggler === undefined ? null : this.claimOf(spec, env, straggler.idx, straggler.item, straggler.attempts, true);
  }

  private claimOf(spec: Kept, own: Record<string, string>, index: number, item: string, attempt: number, duplicate: boolean): Claim {
    const parsed: unknown = JSON.parse(item);
    const env = { ...commandEnv(spec.recipe, own), ARMADA_ITEM: item, ARMADA_INDEX: String(index), ARMADA_OUT: `${TASK}/out`, ARMADA_CGROUP: TASK_GROUP };
    const values = { ...itemValues(parsed, index), out: `${TASK}/out`, files: `${STATE}/files`, workdir: workdirOf(spec.recipe), commit: spec.commit?.sha ?? '' };
    const argv = 'command' in spec.run ? spec.run.command.map((word) => fill(word, values)) : ['node', `${STATE}/handler.mjs`];

    return { index, attempt, argv, env, duplicate };
  }

  /** Whether `name`'s answer for `index` is the one kept: the first to land wins, a late duplicate is told no. */
  async accept(name: string, index: number): Promise<boolean> {
    const task = this.sql.exec<{ state: string; vessel: string | null; dup: string | null }>('SELECT state, vessel, dup FROM tasks WHERE idx = ?', index).toArray()[0];

    if (task === undefined || task.state !== 'running' || (task.vessel !== name && task.dup !== name)) return false;
    this.sql.exec(`UPDATE tasks SET state = 'landing', vessel = ? WHERE idx = ?`, name, index);

    return true;
  }

  /** The kept answer, once its output and log are in R2: appended to the stream. */
  async complete(name: string, outcome: Outcome, busyMs: number): Promise<void> {
    this.sql.exec(`UPDATE tasks SET state = ? WHERE idx = ? AND state = 'landing'`, outcome.kind, outcome.index);
    this.sql.exec('INSERT INTO events (outcome) VALUES (?)', JSON.stringify(outcome));
    this.sql.exec('UPDATE vessels SET tasks = tasks + 1, busy_ms = busy_ms + ?, beat = ? WHERE name = ?', busyMs, Date.now(), name);
    await this.settle();
  }

  /** Whether a vessel should keep running `index`: no, once someone else's answer landed or the job ended. */
  async still(name: string, index: number): Promise<boolean> {
    this.beat(name);
    const task = this.sql.exec<{ state: string }>('SELECT state FROM tasks WHERE idx = ?', index).toArray()[0];

    return (await this.ctx.storage.get<Phase>('phase')) === 'running' && task?.state === 'running';
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

    for (const task of this.sql.exec<{ idx: number; infra: number; dup: string | null }>(`SELECT idx, infra, dup FROM tasks WHERE vessel = ? AND state IN ('running', 'landing')`, name).toArray()) {
      if (task.dup !== null) {
        this.sql.exec('UPDATE tasks SET vessel = dup, dup = NULL WHERE idx = ?', task.idx);
      } else if (task.infra + 1 < INFRA_ATTEMPTS) {
        this.sql.exec(`UPDATE tasks SET state = 'queued', vessel = NULL, infra = infra + 1 WHERE idx = ?`, task.idx);
      } else {
        this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
        const outcome: Outcome = { index: task.idx, kind: 'failed', exitCode: -1, seconds: 0, vessel: name, attempt: INFRA_ATTEMPTS, tail: error.slice(-4000), output: false };

        this.sql.exec('INSERT INTO events (outcome) VALUES (?)', JSON.stringify(outcome));
      }
    }

    const replaced = (await this.ctx.storage.get<number>('replaced')) ?? 0;
    const generation = await this.ctx.storage.get<Generation>('environment');

    if (this.count(`state = 'queued'`) > 0 && replaced < REPLACEMENTS && generation !== undefined && (await this.ctx.storage.get<Phase>('phase')) === 'running') {
      const next = `r${String(replaced + 1)}`;

      await this.ctx.storage.put('replaced', replaced + 1);
      this.sql.exec('INSERT INTO vessels (name, state, beat) VALUES (?, ?, ?)', next, 'waiting', Date.now());
      await this.launch(spec, generation, next);
    }

    await this.settle();
  }

  /** Done once no task is queued or running and no vessel can still take one. */
  private async settle(): Promise<void> {
    if ((await this.ctx.storage.get<Phase>('phase')) !== 'running') return;
    const open = this.count(`state IN ('queued', 'running', 'landing')`);
    const alive = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM vessels WHERE state IN ('waiting', 'booting', 'working')`).one()['n']);

    if (open > 0 && alive > 0) return;

    if (open > 0) {
      for (const task of this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state IN ('queued', 'running', 'landing')`).toArray()) {
        const outcome: Outcome = { index: task.idx, kind: 'failed', exitCode: -1, seconds: 0, vessel: '', attempt: 0, tail: 'no vessel was left to run it', output: false };

        this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
        this.sql.exec('INSERT INTO events (outcome) VALUES (?)', JSON.stringify(outcome));
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
  }

  async cancel(reason: string): Promise<void> {
    if ((await this.ctx.storage.get<Phase>('phase')) === 'done') return;
    await this.ctx.storage.put('problems', [...(await this.ctx.storage.get<string[]>('problems')) ?? [], reason]);

    for (const task of this.sql.exec<{ idx: number }>(`SELECT idx FROM tasks WHERE state IN ('queued', 'running', 'landing')`).toArray()) {
      const outcome: Outcome = { index: task.idx, kind: 'failed', exitCode: -1, seconds: 0, vessel: '', attempt: 0, tail: reason, output: false };

      this.sql.exec(`UPDATE tasks SET state = 'failed' WHERE idx = ?`, task.idx);
      this.sql.exec('INSERT INTO events (outcome) VALUES (?)', JSON.stringify(outcome));
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
  async events(after: number): Promise<{ events: { seq: number; outcome: Outcome }[]; done: boolean }> {
    const rows = this.sql.exec<{ seq: number; outcome: string }>('SELECT seq, outcome FROM events WHERE seq > ? ORDER BY seq LIMIT 2000', after).toArray();
    const done = (await this.ctx.storage.get<Phase>('phase')) === 'done';
    const last = rows.at(-1)?.seq ?? after;
    const more = Number(this.sql.exec('SELECT COUNT(*) AS n FROM events WHERE seq > ?', last).one()['n']) > 0;

    return { events: rows.map((row) => ({ seq: row.seq, outcome: v.parse(OutcomeSchema, JSON.parse(row.outcome)) })), done: done && !more };
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
        total: this.count('1 = 1'), queued: this.count(`state = 'queued'`), running: this.count(`state IN ('running', 'landing')`),
        exited: this.count(`state = 'exited'`), red, failed: this.count(`state = 'failed'`),
      },
      vessels: vessels.map((row) => ({ name: row.name, state: row.state, tasks: row.tasks, bootMs: row.boot_ms, busyMs: row.busy_ms, error: row.error })),
      problems: (await this.ctx.storage.get<string[]>('problems')) ?? [],
      environment: generation === undefined ? null : { key: generation.key, sha: generation.sha, created: generation.created, seconds: generation.seconds },
    };
  }
}
