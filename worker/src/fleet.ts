/**
 * ArmadaFleet: the vCPUs and memory running at once across every job of this deployment, held under its own
 * FLEET_VCPUS and FLEET_MEMORY_MIB: a container of each size holds both (`roomOf`), as the account limits both, and
 * a medium one, 4 vCPU in 12 GiB, fills an account's memory before its vCPUs (2026-10-30: 3000 vCPU and 6 TiB held
 * 512 of them, and a fleet that counted vCPUs alone granted 725). A container over the cap waits for capacity rather
 * than being refused by the platform mid-job; one the platform refuses for the account's own room waits in the
 * fleet's line all the same, and the fleet holds no more than it held then for WANT_MS (`crowded`). A hold names its
 * holder and lapses at its lease, so a holder that died returns it. Each hold is a row of its own, as is each holder
 * waiting in line, and what they keep is summed where they are (`charge`): a call reads and writes only the rows it
 * changes, and costs the same however many containers the fleet holds.
 *
 * Past the cap, it lends a job's containers what the rest of the account leaves idle, read from Cloudflare's API
 * (`readAccount`) under the token `armada deploy` gives it, while it lends. Every hold asks before each new task
 * (`renews`), and one recalled starts no new task and ends what it runs within RECALL_GRACE_MS (`beat`): the fleet
 * recalls its newest loans once the account fills, its read goes stale, or a holder that may not borrow (a preparation,
 * a gang's rank) waits for room under the cap; and the newest holds below a waiting holder's priority (`acquire`).
 *
 * It also keeps the jobs not yet done, and whether new ones are admitted: `armada deploy` drains the deployed version
 * (it admits no new job, and the open ones finish) before it replaces it. The drain names the version it drains, so
 * the version deployed after it admits jobs from its first request, once the deployment-wide objects run its
 * interface. And it keeps the ids of the last RECENT jobs made, which the dashboard lists.
 */
import * as v from 'valibot';
import { SIZES, type Fleet } from '../../src/protocol';
import { readAccount, type Reader } from '../../src/account';
import { INACTIVITY_MS } from './container';
import { ArmadaSingle, said, SINGLE, type Env } from './env';

/** The jobs made last that the fleet keeps the ids of. */
export const RECENT = 500;

/** How long a hold lasts past its job's deadline: a container that would not stop runs this long more. */
const LEASE_MS = INACTIVITY_MS;

/** How soon a container the fleet had no room for asks again. */
export const CAPACITY_RETRY_MS = 5_000;

/** How often the fleet reads the account while it lends, or a holder wants a loan. */
export const SAMPLE_MS = 30_000;

/** How old a read of the account may be and still be lent from. */
const SAMPLE_LIFE_MS = 4 * SAMPLE_MS;

/** How long a want counts once its holder stops asking, which it does every CAPACITY_RETRY_MS while it waits. */
export const WANT_MS = 60_000;

/** How long a recalled hold's container runs the tasks it has once recalled: one that ends by then lands, and one that
 *  runs on is ended and queued again (`beat`). Dew's train waited out its deadline on lower jobs' tasks of minutes to
 *  tens of minutes, each ended only at its next task's start (#63, #66). */
export const RECALL_GRACE_MS = 60_000;

/** The account's share left idle for other apps to start containers in, which then show in the next read. */
const HEADROOM = 0.1;

/** What holds take of the account: vCPUs, and memory in MiB. */
export interface Room {
  readonly vcpus: number;
  readonly memory: number;
}

/** The room a container of `vcpus` vCPUs takes: its size's memory (SIZES), and for a count of vCPUs no size has, as a
 *  gang's reserve is a sum, the memory of the smallest size with as many at its own memory per vCPU, past the largest
 *  at its. */
export function roomOf(vcpus: number): Room {
  const sizes = Object.values(SIZES).toSorted((left, right) => left.vcpus - right.vcpus);
  const size = sizes.find((each) => each.vcpus >= vcpus) ?? sizes[sizes.length - 1];

  return { vcpus, memory: size === undefined ? 0 : vcpus * size.memoryGiB * 1024 / size.vcpus };
}

const within = (room: Room, limit: Room): boolean => room.vcpus <= limit.vcpus && room.memory <= limit.memory;

const larger = (left: Room, right: Room): Room => ({ vcpus: Math.max(left.vcpus, right.vcpus), memory: Math.max(left.memory, right.memory) });

/** A read of the account: the most the fleet holds until the next. */
export interface Lending {
  readonly limit: Room;
  readonly at: number;
}

/** The platform refused a container for want of the account's room (`crowded`): the most the fleet holds until
 *  `until`, what it held then. */
interface Crowded {
  readonly room: Room;
  readonly until: number;
}

/** A grant: within the fleet's cap, or lent past it. */
export type Grant = 'held' | 'borrowed';

/** An object's container goes, and `holder`'s vCPUs, where it holds any, return to the fleet once it is gone: one that
 *  will not stop ends at the inactivity timeout it was started with, `inactivityMs`, and holds them until then. Whether
 *  it is gone. */
export async function letGo(ctx: DurableObjectState, env: Env, { holder, inactivityMs }: { readonly holder: string | undefined; readonly inactivityMs: number }): Promise<boolean> {
  const [destroyed] = await Promise.allSettled([ctx.container?.destroy()]);
  const gone = destroyed.status === 'fulfilled';

  if (holder !== undefined) await env.FLEET.getByName(SINGLE).release(holder, gone ? 0 : inactivityMs);

  return gone;
}

/** A grant as any fleet answers it: one still on earlier code for a while after a deploy answers true or false. */
export function grantOf(answer: Grant | boolean | null): Grant | null {
  if (answer === true) return 'held';

  return answer === false ? null : answer;
}

/** The job of `holder`, which is `<job>/<vessel>`. */
const jobOf = (holder: string): string => holder.slice(0, holder.lastIndexOf('/'));

/** The memory of a hold or an ask of `vcpus` (`roomOf`), and of its job's `reserve` at its containers' memory per vCPU. */
function memoryOf(vcpus: number, reserve: number) {
  const { memory } = roomOf(vcpus);

  return { memory, reserveMemory: vcpus > 0 ? memory * reserve / vcpus : 0 };
}

/** Rows a sum or a recall picks: a condition on a table's rows, and what it binds. */
interface Where {
  readonly where: string;
  readonly bindings: readonly SqlStorageValue[];
}

const ALL: Where = { where: '1', bindings: [] };

/** No ask in line. */
const NONE: Where = { where: '0', bindings: [] };

/** The holds not recalled: a recalled hold still runs its tasks for its grace, and counts as gone already. */
const UNRECALLED: Where = { where: 'recalled IS NULL', bindings: [] };

/** `holder`'s own ask. */
const own = (holder: string): Where => ({ where: 'holder = ?', bindings: [holder] });

/** The asks ahead of `holder`, at `place` in line for `priority`: of a higher priority, or of its own and older. */
const aheadOf = (holder: string, priority: number, place: number): Where => ({
  where: 'holder != ? AND (priority > ? OR (priority = ? AND place < ?))', bindings: [holder, priority, priority, place],
});

/** The asks ahead of `holder`, and its own. */
const throughOf = (holder: string, priority: number, place: number): Where => ({
  where: 'holder = ? OR priority > ? OR (priority = ? AND place < ?)', bindings: [holder, priority, priority, place],
});

/** Holds a recall frees, and the order it frees them in. */
interface Recallable {
  readonly picked: Where;
  readonly order: string;
}

/** The fleet's loans, the newest first: it recalls them when it holds more than it may. */
const LOANS: Recallable = { picked: { where: 'borrowed = 1', bindings: [] }, order: 'granted DESC, holder' };

/** The holds a holder of job `job` and `priority` that waits has recalled: other jobs' below it, the lowest first, then
 *  the newest. */
const belowOf = (priority: number, job: string): Recallable => ({
  picked: { where: 'job != ? AND recallable = 1 AND priority < ?', bindings: [job, priority] }, order: 'priority, granted DESC, holder',
});

/** How long a drain holds unless it is asked again: longer than a deploy's install, the Worker upload and its
 *  secrets, takes between two asks. */
export const DRAIN_MS = 10 * 60_000;

export interface Drained {
  readonly version: string;
  readonly until: number;
}

export class ArmadaFleet extends ArmadaSingle {
  private readonly sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Each hold: its holder, `<job>/<vessel>`, and its job; its vCPUs and memory, and its job's reserve in both; when it
    // lapses; its first grant's place among the fleet's grants, as the newest loan is recalled first; whether it was
    // lent past the cap; its job's priority; when it was recalled; whether a recall may free it, which a preparation's
    // hold, run to its end, and a container's that would not stop are not; and whether its vessel renews it, as one of a
    // job with no deadline does each slice of its work (`beat`). An earlier Worker kept every hold in one value, which
    // this one does not read: `armada deploy` drains every job before it replaces the Worker, and the holds that outlive
    // their jobs, of containers that would not stop, lapse within INACTIVITY_MS.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS holds (holder TEXT PRIMARY KEY, job TEXT NOT NULL, vcpus REAL NOT NULL, memory REAL NOT NULL, reserve REAL NOT NULL,
      reserve_memory REAL NOT NULL, until INTEGER NOT NULL, granted INTEGER NOT NULL, borrowed INTEGER NOT NULL, priority INTEGER NOT NULL, recalled INTEGER,
      recallable INTEGER NOT NULL, renewed INTEGER NOT NULL)`);

    // An earlier Worker's line, which kept no ask's job or memory, goes: its holders take places again as they next ask.
    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(waiting)').toArray().some((column) => column.name === 'job')) this.sql.exec('DROP TABLE IF EXISTS waiting');
    // Each holder the fleet had no room for: its job, what it asks, its job's priority, its place in line from its first
    // refusal, and when it last asked, which it does every CAPACITY_RETRY_MS or more while it waits.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS waiting (holder TEXT PRIMARY KEY, job TEXT NOT NULL, vcpus REAL NOT NULL, memory REAL NOT NULL, reserve REAL NOT NULL,
      reserve_memory REAL NOT NULL, place INTEGER NOT NULL, asked INTEGER NOT NULL, priority INTEGER NOT NULL)`);
  }

  /** Whether `holder` holds `vcpus` now; it keeps them until `release`, or its lease ends past its job's `deadlineAt`.
   *  Its job keeps `reserve` from the other jobs while it holds any: a holder is granted only once its job's whole
   *  reserve fits beside theirs, so the ranks of two jobs' gangs never split the fleet between them and wait on each
   *  other forever. A holder that `borrows`, which asks before each new task, may be lent what the account leaves idle
   *  past the cap; one that does not, waiting while loans fill the cap, has them recalled.
   *
   *  Holders it has no room for wait in line, by their job's `priority`, then in the order it first refused them (#49).
   *  A holder is not granted what one ahead of it still waits for: it is granted only if it fits beside what they asked,
   *  or its job already keeps what it asks, as a gang's next rank does. Otherwise each vCPU freed would go to whichever
   *  single container asked next, and a gang's reserve would never come free at once. A holder that stops asking leaves
   *  the line after WANT_MS. One refused has the newest holds of jobs below its priority recalled until it fits: their
   *  containers end at their next task's start, rather than hold the fleet between tasks while it waits (#60). */
  async acquire(holder: string, vcpus: number, { reserve = vcpus, deadlineAt, borrows = false, renewed = false, priority = 0, recallable = true, now = Date.now() }: {
    readonly reserve?: number; readonly deadlineAt: number; readonly borrows?: boolean; readonly renewed?: boolean; readonly priority?: number; readonly recallable?: boolean; readonly now?: number;
  }): Promise<Grant | null> {
    const job = jobOf(holder);
    const cap = this.cap();
    const limit = borrows ? await this.limit(now) : await this.held(cap, now);
    const { memory, reserveMemory } = memoryOf(vcpus, reserve);

    this.sql.exec('DELETE FROM holds WHERE until <= ?', now);
    this.sql.exec('DELETE FROM waiting WHERE asked <= ?', now - WANT_MS);
    const replaced = this.sql.exec<{ granted: number }>('SELECT granted FROM holds WHERE holder = ?', holder).toArray()[0];

    // It asks in line, at its place from its first refusal, or behind every holder of its own priority; and leaves the
    // line once granted.
    this.sql.exec(`INSERT INTO waiting (holder, job, vcpus, memory, reserve, reserve_memory, place, asked, priority) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(place), 0) + 1 FROM waiting), ?, ?)
      ON CONFLICT (holder) DO UPDATE SET vcpus = excluded.vcpus, memory = excluded.memory, reserve = excluded.reserve, reserve_memory = excluded.reserve_memory, asked = excluded.asked,
      priority = excluded.priority`, holder, job, vcpus, memory, reserve, reserveMemory, now, priority);
    const { place } = this.sql.exec<{ place: number }>('SELECT place FROM waiting WHERE holder = ?', holder).one();
    const others: Where = { where: 'holder != ?', bindings: [holder] };
    const charge = this.charge(now, others, own(holder));
    // Those ahead in line, as if they held what they ask.
    const ahead = this.charge(now, others, aheadOf(holder, priority, place));
    const passes = replaced === undefined && !within(this.charge(now, others, throughOf(holder, priority, place)), larger(limit, ahead));

    if (!within(charge, limit) || passes) {
      await this.want(borrows, holder, now);
      // Holds below its priority, lowest and newest first, until it and those ahead of it fit; as `want` left them.
      this.recall({ limit, ...belowOf(priority, job), asks: throughOf(holder, priority, place), now });

      return null;
    }

    const granted = replaced?.granted ?? Number(this.sql.exec('SELECT COALESCE(MAX(granted), 0) + 1 AS n FROM holds').one()['n']);
    const borrowed = !within(charge, cap);

    this.sql.exec('DELETE FROM waiting WHERE holder = ?', holder);
    this.sql.exec('INSERT OR REPLACE INTO holds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)', holder, job, vcpus, memory, reserve, reserveMemory, Math.max(now, deadlineAt) + LEASE_MS,
      granted, Number(borrowed), priority, Number(recallable), Number(renewed));

    return borrowed ? 'borrowed' : 'held';
  }

  /** How many more containers of `vcpus` vCPUs each job `job` of `priority` could be granted now: the most the fleet
   *  holds, less what the job holds, and what the other jobs keep that no recall for it would free, their holds not
   *  below its priority or not recallable and their asks in line not below it. A job keeps no more of its containers
   *  waiting for the fleet than this, and one at least (`ArmadaJob.wanted`), so a full fleet's line holds about one
   *  container a job, not each one every job could use (2026-10-30: 690 waited for 12 jobs, each asking twice a minute). */
  async room(job: string, vcpus: number, priority = 0, now = Date.now()): Promise<number> {
    const limit = await this.limit(now);

    const kept = this.charge(now, { where: 'job != ? AND recalled IS NULL AND (priority >= ? OR recallable = 0)', bindings: [job, priority] },
      { where: 'job != ? AND priority >= ?', bindings: [job, priority] });

    const held = this.sql.exec<{ vcpus: number; memory: number }>('SELECT COALESCE(SUM(vcpus), 0) AS vcpus, COALESCE(SUM(memory), 0) AS memory FROM holds WHERE job = ? AND until > ?', job, now).one();
    const each = roomOf(vcpus);
    const fits = (free: number, one: number): number => one > 0 ? free / one : Infinity;

    return Math.max(0, Math.floor(Math.min(fits(limit.vcpus - kept.vcpus - held.vcpus, each.vcpus), fits(limit.memory - kept.memory - held.memory, each.memory))));
  }

  /** Whether `holder` takes another task. Not once it is recalled, which is for good: for a holder of a higher priority
   *  (`acquire`), or as the fleet recalls its newest loans first whenever it holds more than it may now. */
  async renews(holder: string): Promise<boolean> {
    const now = Date.now();

    this.recall({ limit: await this.limit(now), ...LOANS, now });

    return this.sql.exec('SELECT 1 AS n FROM holds WHERE holder = ? AND until > ? AND recalled IS NULL', holder, now).toArray().length > 0;
  }

  /** Reads the account while it lends, or a holder wants a loan: the most it holds until the next read is what it held,
   *  and half the account's idle vCPUs past that, so two fleets that lend see each other grow and settle rather than
   *  trade the same vCPUs back and forth. A read that fails leaves the last one to go stale. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const lent = this.sql.exec('SELECT 1 AS n FROM holds WHERE until > ? AND borrowed = 1 AND recalled IS NULL LIMIT 1', now).toArray().length > 0;

    if (!lent && ((await this.ctx.storage.get<number>('wanted')) ?? 0) <= now - WANT_MS) return;

    const reader = this.reader();

    if (reader === null) return;

    try {
      const account = await readAccount(reader);
      // Read after the account, and live as of then, as other calls and time may have changed them while it answered.
      const answered = Date.now();
      const charge = this.charge(answered, ALL, NONE);

      const lends = (held: number, total: number, others: number): number => Math.floor(held + (total * (1 - HEADROOM) - others - held) / 2);

      await this.ctx.storage.put('lending', {
        limit: { vcpus: lends(charge.vcpus, account.vcpus, account.others), memory: lends(charge.memory, account.memory, account.othersMemory) }, at: now,
      } satisfies Lending);
      this.recall({ limit: await this.limit(answered), ...LOANS, now: answered });
    } catch (cause) {
      console.error(JSON.stringify({ fleet: 'reading the account', error: said({ cause }) }));
    }

    await this.ctx.storage.setAlarm(now + SAMPLE_MS);
  }

  /** The fleet's own cap: FLEET_VCPUS, and FLEET_MEMORY_MIB, which an earlier deploy did not give (none). */
  private cap(): Room {
    return { vcpus: Number(this.env.FLEET_VCPUS), memory: this.env.FLEET_MEMORY_MIB === undefined ? Infinity : Number(this.env.FLEET_MEMORY_MIB) };
  }

  /** `limit`, or less while the platform refuses containers for the account's room (`crowded`): what the fleet held
   *  as it last refused one, for WANT_MS. */
  private async held(limit: Room, now: number): Promise<Room> {
    const crowded = await this.ctx.storage.get<Crowded>('crowded');

    return crowded === undefined || crowded.until <= now ? limit
      : { vcpus: Math.min(limit.vcpus, crowded.room.vcpus), memory: Math.min(limit.memory, crowded.room.memory) };
  }

  /** The most the fleet holds now: its cap, or what its last read of the account lends up to, while that read is fresh
   *  and no holder that may not borrow waits; less while the account is crowded (`held`). */
  private async limit(now: number): Promise<Room> {
    const cap = this.cap();
    const lending = await this.ctx.storage.get<Lending>('lending');
    const pressed = ((await this.ctx.storage.get<number>('pressed')) ?? 0) > now - WANT_MS;

    const lends = this.reader() !== null && lending !== undefined && v.is(v.object({ vcpus: v.number(), memory: v.number() }), lending.limit) && !pressed
      && now - lending.at <= SAMPLE_LIFE_MS;

    return await this.held(lends ? larger(cap, lending.limit) : cap, now);
  }

  /** The platform refused `holder`'s container for want of the account's room, past what the fleet counts: its hold
   *  goes, it waits in the fleet's line at its place, and until WANT_MS from now the fleet holds no more than the rest
   *  hold now (`held`), so a holder below it is refused rather than refused by the platform in turn, and the newest
   *  holds below its priority are recalled until it fits (`acquire`'s recall). */
  async crowded(holder: string, now = Date.now()): Promise<void> {
    const refused = this.sql.exec<{ job: string; vcpus: number; memory: number; reserve: number; reserve_memory: number; priority: number }>(
      'SELECT job, vcpus, memory, reserve, reserve_memory, priority FROM holds WHERE holder = ? AND until > ?', holder, now).toArray()[0];

    if (refused === undefined) return;
    this.sql.exec('DELETE FROM holds WHERE holder = ?', holder);
    const room = this.charge(now, ALL, NONE);

    await this.ctx.storage.put('crowded', { room, until: now + WANT_MS } satisfies Crowded);
    this.sql.exec(`INSERT INTO waiting (holder, job, vcpus, memory, reserve, reserve_memory, place, asked, priority) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MIN(place), 1) - 1 FROM waiting), ?, ?)
      ON CONFLICT (holder) DO UPDATE SET asked = excluded.asked`, holder, refused.job, refused.vcpus, refused.memory, refused.reserve, refused.reserve_memory, now, refused.priority);
    this.recall({ limit: room, ...belowOf(refused.priority, refused.job), asks: own(holder), now });
  }

  /** `holder`, refused, asks: one that borrows has the account read, where the fleet may lend; one that may not, which
   *  would fit the cap once the loans end, has them recalled. Loans that are not what keeps it out stay: recalling them
   *  would free nothing it could take. */
  private async want(borrows: boolean, holder: string, now: number): Promise<void> {
    if (borrows) {
      if (this.reader() === null) return;
      await this.ctx.storage.put('wanted', now);

      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now);

      return;
    }

    const cap = this.cap();
    const lent = this.sql.exec('SELECT 1 AS n FROM holds WHERE until > ? AND borrowed = 1 LIMIT 1', now).toArray().length > 0;

    if (!lent || !within(this.charge(now, { where: 'borrowed = 0', bindings: [] }, own(holder)), cap)) return;
    await this.ctx.storage.put('pressed', now);
    this.recall({ limit: cap, ...LOANS, asks: own(holder), now });
  }

  /** Who reads the account for this deployment: none without the token `armada deploy` gives, which it gives empty
   *  once there is none. */
  private reader(): Reader | null {
    const { ACCOUNT_TOKEN: token = '', ARMADA_ACCOUNT: account, ARMADA_NAME: name } = this.env;

    return token === '' || account === undefined || name === undefined ? null : { token, account, name };
  }

  /** What the live holds `kept` picks keep, with the asks `asks` picks in their holders' place, as `acquire` grants
   *  them: each job what it holds or what it reserves, whichever is more, in vCPUs and in memory. Summed where the rows
   *  are, so a call costs the same however many the fleet holds (2026-10-30: every hold kept in one value, read and
   *  written whole by each call, overloaded the object at 465 holds and 690 waiters). */
  private charge(now: number, kept: Where, asks: Where): Room {
    const { vcpus, memory } = this.sql.exec<{ vcpus: number; memory: number }>(`SELECT COALESCE(SUM(v), 0) AS vcpus, COALESCE(SUM(m), 0) AS memory FROM (
        SELECT MAX(SUM(vcpus), MAX(reserve)) AS v, MAX(SUM(memory), MAX(reserve_memory)) AS m FROM (
          SELECT job, vcpus, memory, reserve, reserve_memory FROM holds WHERE until > ? AND (${kept.where}) AND holder NOT IN (SELECT holder FROM waiting WHERE ${asks.where})
          UNION ALL SELECT job, vcpus, memory, reserve, reserve_memory FROM waiting WHERE ${asks.where}) GROUP BY job)`,
    now, ...kept.bindings, ...asks.bindings, ...asks.bindings).one();

    return { vcpus, memory };
  }

  /** Recalls, `now`, the live holds `picked` picks, in `order`, until what the rest keep fits `limit` with the asks
   *  `asks` picks in their holders' place: a recalled hold still runs its tasks for its grace, so it counts as gone
   *  already. A hold is recalled whole, so the fleet may end a little under `limit`. */
  private recall({ limit, picked, order, asks = NONE, now }: Recallable & { readonly limit: Room; readonly asks?: Where; readonly now: number }): void {
    while (!within(this.charge(now, UNRECALLED, asks), limit)) {
      const next = this.sql.exec<{ holder: string }>(`SELECT holder FROM holds WHERE until > ? AND recalled IS NULL AND (${picked.where}) ORDER BY ${order} LIMIT 1`,
        now, ...picked.bindings).toArray()[0];

      if (next === undefined) return;
      this.sql.exec('UPDATE holds SET recalled = ? WHERE holder = ?', now, next.holder);
    }
  }

  /** `holder` still runs, as its vessel says each slice of its work: the time its container ends the tasks it runs by,
   *  RECALL_GRACE_MS after the fleet recalled it, or null while it runs on (#63, #66). A hold of a job with no deadline
   *  lasts LEASE_MS past `now` at least, so a hold whose release was lost ends as a deadline's does. */
  async beat(holder: string, now = Date.now()): Promise<number | null> {
    const held = this.sql.exec<{ recalled: number | null; renewed: number }>('SELECT recalled, renewed FROM holds WHERE holder = ?', holder).toArray()[0];

    if (held === undefined) return null;

    if (held.renewed === 1) this.sql.exec('UPDATE holds SET until = MAX(until, ?) WHERE holder = ?', now + LEASE_MS, holder);

    return held.recalled === null ? null : held.recalled + RECALL_GRACE_MS;
  }

  /** `holder`'s vCPUs back, now, or after `afterMs` for a container whose stop failed and that runs until then. A
   *  holder kept that way has ended: it keeps only its own vCPUs, not its job's reserve, which is for holders still
   *  to be granted, and no recall frees them. */
  async release(holder: string, afterMs = 0): Promise<void> {
    const now = Date.now();

    // A holder that ends waits for nothing.
    this.sql.exec('DELETE FROM waiting WHERE holder = ?', holder);

    // A deadline's hold already ends once its container must have stopped; a renewed one ended only for want of renewal.
    if (afterMs > 0) {
      this.sql.exec(`UPDATE holds SET until = CASE WHEN renewed = 1 THEN ? ELSE MIN(until, ?) END, reserve = 0, reserve_memory = 0, borrowed = 0, priority = 0, recalled = NULL,
        recallable = 0, renewed = 0 WHERE holder = ?`, now + afterMs, now + afterMs, holder);
    } else {
      this.sql.exec('DELETE FROM holds WHERE holder = ?', holder);
    }
  }

  async used(): Promise<number> {
    return Number(this.sql.exec('SELECT COALESCE(SUM(vcpus), 0) AS n FROM holds WHERE until > ?', Date.now()).one()['n']);
  }

  /** The cap and each job's live holds: a holder is `<job>/<vessel>`. */
  async shares(): Promise<Fleet> {
    const now = Date.now();

    const jobs = this.sql.exec<{ id: string; vcpus: number; containers: number }>('SELECT job AS id, SUM(vcpus) AS vcpus, COUNT(*) AS containers FROM holds WHERE until > ? GROUP BY job ORDER BY vcpus DESC',
      now).toArray();

    return { cap: Number(this.env.FLEET_VCPUS), limit: (await this.limit(now)).vcpus, jobs };
  }

  /** Admits `job` unless `version` is drained, or this fleet or another deployment-wide object runs an interface other
   *  than `contract`, the asking Worker's; and counts it open in the same step, so a drain sees every job it did not
   *  refuse. After a deploy that changed the interface, the first job waits for the objects that kept the earlier code
   *  (`ArmadaSingle`). They are asked first: a drain may come while they answer, and none can between the fleet's own
   *  read and write. */
  async admitJob(version: string, contract: string | undefined, job: string): Promise<boolean> {
    if (!(await this.runs(contract)) || !(await this.admits(version))) return false;
    await this.ctx.storage.put(`job:${job}`, Date.now());

    return true;
  }

  /** Whether this fleet and each other deployment-wide object run `contract`. One whose code is too old to say runs an
   *  earlier one. */
  private async runs(contract: string | undefined): Promise<boolean> {
    if (contract !== this.contract()) return false;
    const singles = [this.env.ENVIRONMENTS, this.env.SECRETS, this.env.TASKS, this.env.WEBHOOKS];
    const answers = await Promise.allSettled(singles.map(async (single) => await single.getByName(SINGLE).contract()));

    return answers.every((answer) => answer.status === 'fulfilled' && answer.value === contract);
  }

  /** A job made: open until `closed`, and among the recent ones until RECENT newer ones push it out. */
  async opened(job: string): Promise<void> {
    await this.ctx.storage.put({ [`job:${job}`]: Date.now(), [`seen:${job}`]: Date.now() });
    const seen = [...(await this.ctx.storage.list({ prefix: 'seen:' })).keys()];

    if (seen.length > RECENT) await this.ctx.storage.delete(seen.slice(0, seen.length - RECENT));
  }

  /** The ids of up to `limit` recent jobs made before job `before` (or the newest), newest first. A job's id starts
   *  with the time it was made, so the keys' order is the jobs'. */
  async recent(limit: number, before?: string): Promise<string[]> {
    const listed = await this.ctx.storage.list({ prefix: 'seen:', reverse: true, limit, end: before === undefined ? undefined : `seen:${before}` });

    return [...listed.keys()].map((key) => key.slice('seen:'.length));
  }

  async closed(job: string): Promise<void> {
    await this.ctx.storage.delete(`job:${job}`);
  }

  /** The jobs not yet done, by id. */
  async open(): Promise<string[]> {
    return [...(await this.ctx.storage.list({ prefix: 'job:' })).keys()].map((name) => name.slice('job:'.length));
  }

  /** The jobs not yet done, each with when it was admitted or made. */
  async openSince(): Promise<{ id: string; at: number }[]> {
    return [...(await this.ctx.storage.list<number>({ prefix: 'job:' }))].map(([name, at]) => ({ id: name.slice('job:'.length), at }));
  }

  async jobs(): Promise<number> {
    return (await this.ctx.storage.list({ prefix: 'job:' })).size;
  }

  /** Admits no new job while `version` runs, for `DRAIN_MS` from now: a deploy asks again while it waits, so a deploy
   *  that dies, even by a kill no handler sees, leaves the version admitting jobs again. Answers how many jobs are still
   *  open. */
  async drain(version: string): Promise<number> {
    await this.ctx.storage.put('drained', { version, until: Date.now() + DRAIN_MS } satisfies Drained);

    return await this.jobs();
  }

  /** Admits new jobs again. */
  async admit(): Promise<void> {
    await this.ctx.storage.delete('drained');
  }

  async admits(version: string): Promise<boolean> {
    const drained = await this.ctx.storage.get<Drained | string>('drained');

    // A drain an earlier Worker stored names its version alone, and lasted until the deploy admitted again.
    if (v.is(v.string(), drained)) return drained !== version;

    return drained === undefined || drained.version !== version || drained.until <= Date.now();
  }
}
