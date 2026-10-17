/**
 * ArmadaFleet: the vCPUs running at once across every job of this deployment, held under its own FLEET_VCPUS. A
 * container over the cap waits for capacity rather than being refused by the platform mid-job. A hold names its
 * holder and lapses at its lease, so a holder that died returns it.
 *
 * Past the cap, it lends a job's containers what the rest of the account leaves idle, read from Cloudflare's API
 * (`readAccount`) under the token `armada deploy` gives it, while it lends. A borrowed hold asks before each new task (`renews`), and one recalled finishes what it
 * runs and ends: the fleet recalls its newest loans once the account fills, its read goes stale, or a holder that may
 * not borrow (a preparation, a gang's rank) waits for room under the cap.
 *
 * It also keeps the jobs not yet done, and whether new ones are admitted: `armada deploy` drains the deployed version
 * (it admits no new job, and the open ones finish) before it replaces it. The drain names the version it drains, so
 * the version deployed after it admits jobs from its first request, once the deployment-wide objects run its
 * interface. And it keeps the ids of the last RECENT jobs made, which the dashboard lists.
 */
import * as v from 'valibot';
import type { Fleet } from '../../src/protocol';
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

/** The account's share left idle for other apps to start containers in, which then show in the next read. */
const HEADROOM = 0.1;

/** A read of the account: the most the fleet holds until the next. */
export interface Lending {
  readonly limit: number;
  readonly at: number;
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

export interface Hold {
  readonly vcpus: number;
  readonly until: number;
  /** The vCPUs its job must hold at once (`VesselSpec.reserve`), which no other job is granted while the job holds any. */
  readonly reserve?: number;
  /** Its first grant's place among the fleet's grants: the newest loan is recalled first. */
  readonly granted?: number;
  /** Granted past the cap, and asked about before each new task. */
  readonly borrowed?: boolean;
  /** Its container takes no new task: it finishes what it runs, then ends. */
  readonly recalled?: boolean;
  /** Its job has no deadline: its vessel renews it each slice of its work (`extend`), and one that ends with a container
   *  that would not stop keeps it for that container's whole inactivity timeout from then (`release`). */
  readonly renewed?: boolean;
}

/** A grant as any fleet answers it: one still on earlier code for a while after a deploy answers true or false. */
export function grantOf(answer: Grant | boolean | null): Grant | null {
  if (answer === true) return 'held';

  return answer === false ? null : answer;
}

/** What `holds` keep together, as `acquire` grants them. */
const chargeOf = (holds: Record<string, Hold>): number => [...needs(holds).values()].reduce((sum, need) => sum + need, 0);

/** The job of `holder`, which is `<job>/<vessel>`. */
const jobOf = (holder: string): string => holder.slice(0, holder.lastIndexOf('/'));

/** What each job of `holds` keeps from the others: what it holds, or what it reserves, whichever is more. */
function needs(holds: Record<string, Hold>): Map<string, number> {
  const held = new Map<string, { vcpus: number; reserve: number }>();

  for (const [holder, hold] of Object.entries(holds)) {
    const job = jobOf(holder);
    const sum = held.get(job) ?? { vcpus: 0, reserve: 0 };

    held.set(job, { vcpus: sum.vcpus + hold.vcpus, reserve: Math.max(sum.reserve, hold.reserve ?? 0) });
  }

  return new Map([...held].map(([job, sum]) => [job, Math.max(sum.vcpus, sum.reserve)]));
}

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
    // Each holder the fleet had no room for: what it asks, its place in line from its first refusal, and when it last
    // asked, which it does every CAPACITY_RETRY_MS while it waits.
    this.sql.exec('CREATE TABLE IF NOT EXISTS waiting (holder TEXT PRIMARY KEY, vcpus REAL NOT NULL, reserve REAL NOT NULL, place INTEGER NOT NULL, asked INTEGER NOT NULL)');
  }

  /** Whether `holder` holds `vcpus` now; it keeps them until `release`, or its lease ends past its job's `deadlineAt`.
   *  Its job keeps `reserve` from the other jobs while it holds any: a holder is granted only once its job's whole
   *  reserve fits beside theirs, so the ranks of two jobs' gangs never split the fleet between them and wait on each
   *  other forever. A holder that `borrows`, which asks before each new task, may be lent what the account leaves idle
   *  past the cap; one that does not, waiting while loans fill the cap, has them recalled.
   *
   *  Holders it has no room for wait in line, in the order it first refused them (#49). A newer one is not granted what
   *  an older one still waits for: it is granted only if it fits beside what they asked, or its job already keeps what
   *  it asks, as a gang's next rank does. Otherwise each vCPU freed would go to whichever single container asked next,
   *  and a gang's reserve would never come free at once. A holder that stops asking leaves the line after WANT_MS. */
  async acquire(holder: string, vcpus: number, { reserve = vcpus, deadlineAt, borrows = false, renewed = false, now = Date.now() }: {
    readonly reserve?: number; readonly deadlineAt: number; readonly borrows?: boolean; readonly renewed?: boolean; readonly now?: number;
  }): Promise<Grant | null> {
    const holds = this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), now);
    const { [holder]: replaced, ...others } = holds;
    const cap = Number(this.env.FLEET_VCPUS);
    const asked = { [holder]: { vcpus, until: now, reserve } };
    const charge = chargeOf({ ...others, ...asked });
    const limit = borrows ? await this.limit(now) : cap;

    this.sql.exec('DELETE FROM waiting WHERE asked <= ?', now - WANT_MS);
    const place = this.sql.exec<{ place: number }>('SELECT place FROM waiting WHERE holder = ?', holder).toArray()[0]?.place ?? null;

    // Those ahead in line, as if they held what they ask: a new holder is behind every one.
    const before = Object.fromEntries(this.sql.exec<{ holder: string; vcpus: number; reserve: number }>('SELECT holder, vcpus, reserve FROM waiting WHERE holder != ? AND (? IS NULL OR place < ?)', holder, place, place)
      .toArray().map((wait) => [wait.holder, { vcpus: wait.vcpus, until: now, reserve: wait.reserve }]));

    const ahead = { ...others, ...before };
    const passes = replaced === undefined && chargeOf({ ...ahead, ...asked }) > Math.max(limit, chargeOf(ahead));

    if (charge > limit || passes) {
      this.sql.exec(`INSERT INTO waiting (holder, vcpus, reserve, place, asked) VALUES (?, ?, ?, (SELECT COALESCE(MAX(place), 0) + 1 FROM waiting), ?)
        ON CONFLICT (holder) DO UPDATE SET vcpus = excluded.vcpus, reserve = excluded.reserve, asked = excluded.asked`, holder, vcpus, reserve, now);
      await this.want(borrows, holds, asked, now);

      return null;
    }

    const grants = (await this.ctx.storage.get<number>('grants')) ?? 0;
    const granted = replaced?.granted ?? grants + 1;

    this.sql.exec('DELETE FROM waiting WHERE holder = ?', holder);
    await this.ctx.storage.put({ holds: { ...others, [holder]: { vcpus, until: Math.max(now, deadlineAt) + LEASE_MS, reserve, granted, borrowed: charge > cap, renewed } }, grants: Math.max(grants, granted) });

    return charge > cap ? 'borrowed' : 'held';
  }

  /** Whether `holder`, which holds borrowed vCPUs, takes another task. Not once it is recalled, which is for good;
   *  and the fleet recalls its newest loans first whenever it holds more than it may now. */
  async renews(holder: string): Promise<boolean> {
    const now = Date.now();
    const held = (await this.recall(this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), now), await this.limit(now)))[holder];

    return held !== undefined && held.recalled !== true;
  }

  /** Reads the account while it lends, or a holder wants a loan: the most it holds until the next read is what it held,
   *  and half the account's idle vCPUs past that, so two fleets that lend see each other grow and settle rather than
   *  trade the same vCPUs back and forth. A read that fails leaves the last one to go stale. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const lent = Object.values(this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), now)).some((hold) => hold.borrowed === true && hold.recalled !== true);

    if (!lent && ((await this.ctx.storage.get<number>('wanted')) ?? 0) <= now - WANT_MS) return;

    const reader = this.reader();

    if (reader === null) return;

    try {
      const account = await readAccount(reader);
      // Read after the account, and live as of then, as other calls and time may have changed them while it answered.
      const answered = Date.now();
      const holds = this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), answered);
      const charge = chargeOf(holds);

      await this.ctx.storage.put('lending', { limit: Math.floor(charge + (account.vcpus * (1 - HEADROOM) - account.others - charge) / 2), at: now } satisfies Lending);
      await this.recall(holds, await this.limit(answered));
    } catch (cause) {
      console.error(JSON.stringify({ fleet: 'reading the account', error: said({ cause }) }));
    }

    await this.ctx.storage.setAlarm(now + SAMPLE_MS);
  }

  /** The most the fleet holds now: its cap, or what its last read of the account lends up to, while that read is fresh
   *  and no holder that may not borrow waits. */
  private async limit(now: number): Promise<number> {
    const cap = Number(this.env.FLEET_VCPUS);
    const lending = await this.ctx.storage.get<Lending>('lending');
    const pressed = ((await this.ctx.storage.get<number>('pressed')) ?? 0) > now - WANT_MS;

    return this.reader() === null || lending === undefined || pressed || now - lending.at > SAMPLE_LIFE_MS ? cap : Math.max(cap, lending.limit);
  }

  /** The hold `asked` refused beside `holds`: one that borrows has the account read, where the fleet may lend; one that
   *  may not, which would fit the cap once the loans end, has them recalled. Loans that are not what keeps it out stay:
   *  recalling them would free nothing it could take. */
  private async want(borrows: boolean, holds: Record<string, Hold>, asked: Record<string, Hold>, now: number): Promise<void> {
    if (borrows) {
      if (this.reader() === null) return;
      await this.ctx.storage.put('wanted', now);

      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now);

      return;
    }

    const cap = Number(this.env.FLEET_VCPUS);
    const unlent = Object.fromEntries(Object.entries({ ...holds, ...asked }).filter(([, hold]) => hold.borrowed !== true));

    if (!Object.values(holds).some((hold) => hold.borrowed === true) || chargeOf(unlent) > cap) return;
    await this.ctx.storage.put('pressed', now);
    await this.recall(holds, cap, asked);
  }

  /** Who reads the account for this deployment: none without the token `armada deploy` gives, which it gives empty
   *  once there is none. */
  private reader(): Reader | null {
    const { ACCOUNT_TOKEN: token = '', ARMADA_ACCOUNT: account, ARMADA_NAME: name } = this.env;

    return token === '' || account === undefined || name === undefined ? null : { token, account, name };
  }

  /** `holds` with their newest loans recalled until what the rest will keep fits `limit`, with `asked` in its
   *  holder's place: a recalled loan still runs its tasks, so it counts as gone already. A loan is recalled whole, so
   *  the fleet may end a little under `limit`. */
  private async recall(holds: Record<string, Hold>, limit: number, asked: Record<string, Hold> = {}): Promise<Record<string, Hold>> {
    const loans = Object.entries(holds).filter(([, hold]) => hold.borrowed === true && hold.recalled !== true).sort(([, left], [, right]) => (right.granted ?? 0) - (left.granted ?? 0));
    const recalled = { ...holds };
    const kept = (): number => chargeOf(Object.fromEntries(Object.entries({ ...recalled, ...asked }).filter(([, hold]) => hold.recalled !== true)));
    let changed = false;

    for (const [holder, hold] of loans) {
      if (kept() <= limit) break;
      recalled[holder] = { ...hold, recalled: true };
      changed = true;
    }

    if (changed) await this.ctx.storage.put('holds', recalled);

    return recalled;
  }

  /** `holder`'s vCPUs back, now, or after `afterMs` for a container whose stop failed and that runs until then. A
   *  holder kept that way has ended: it keeps only its own vCPUs, not its job's reserve, which is for holders still
   *  to be granted. */
  /** `holder` still runs: its hold, if it has one, lasts LEASE_MS past `now` at least. A vessel whose job has no deadline
   *  says so each slice of its work (`VesselSpec.deadlineAt`), so a hold whose release was lost ends as a deadline's
   *  does. */
  async extend(holder: string, now = Date.now()): Promise<void> {
    const holds = await this.ctx.storage.get<Record<string, Hold>>('holds');
    const held = holds?.[holder];

    if (held === undefined) return;
    await this.ctx.storage.put('holds', { ...holds, [holder]: { ...held, until: Math.max(held.until, now + LEASE_MS) } });
  }

  async release(holder: string, afterMs = 0): Promise<void> {
    const holds = { ...await this.ctx.storage.get<Record<string, Hold>>('holds') };
    const held = holds[holder];

    // A holder that ends waits for nothing.
    this.sql.exec('DELETE FROM waiting WHERE holder = ?', holder);

    // A deadline's hold already ends once its container must have stopped; a renewed one ended only for want of renewal.
    if (held !== undefined && afterMs > 0) holds[holder] = { vcpus: held.vcpus, until: held.renewed === true ? Date.now() + afterMs : Math.min(held.until, Date.now() + afterMs) };
    else delete holds[holder];
    await this.ctx.storage.put('holds', holds);
  }

  async used(): Promise<number> {
    return Object.values(this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), Date.now())).reduce((sum, hold) => sum + hold.vcpus, 0);
  }

  /** The cap and each job's live holds: a holder is `<job>/<vessel>`. */
  async shares(): Promise<Fleet> {
    const jobs = new Map<string, { vcpus: number; containers: number }>();

    for (const [holder, hold] of Object.entries(this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), Date.now()))) {
      const id = jobOf(holder);
      const share = jobs.get(id) ?? { vcpus: 0, containers: 0 };

      jobs.set(id, { vcpus: share.vcpus + hold.vcpus, containers: share.containers + 1 });
    }

    return { cap: Number(this.env.FLEET_VCPUS), limit: await this.limit(Date.now()), jobs: [...jobs].map(([id, share]) => ({ id, ...share })).sort((left, right) => right.vcpus - left.vcpus) };
  }

  private live(holds: Record<string, Hold> | undefined, now: number): Record<string, Hold> {
    return Object.fromEntries(Object.entries(holds ?? {}).filter(([, hold]) => hold.until > now));
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
