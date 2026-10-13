/**
 * ArmadaFleet: the vCPUs running at once across every job of this deployment, held under its own FLEET_VCPUS. A
 * container over the cap waits for capacity rather than being refused by the platform mid-job. A hold names its
 * holder and lapses at its lease, so a holder that died returns it.
 *
 * It also keeps the jobs not yet done, and whether new ones are admitted: `armada deploy` drains the deployed version
 * (it admits no new job, and the open ones finish) before it replaces it. The drain names the version it drains, so
 * the version deployed after it admits jobs from its first request, once the deployment-wide objects run its
 * interface. And it keeps the ids of the last RECENT jobs made, which the dashboard lists.
 */
import * as v from 'valibot';
import type { Fleet } from '../../src/protocol';
import { INACTIVITY_MS } from './container';
import { ArmadaSingle, SINGLE, type Env } from './env';

/** The jobs made last that the fleet keeps the ids of. */
export const RECENT = 500;

/** How long a hold lasts past its job's deadline: a container that would not stop runs this long more. */
const LEASE_MS = INACTIVITY_MS;

/** How soon a container the fleet had no room for asks again. */
export const CAPACITY_RETRY_MS = 5_000;

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
}

/** What each job of `holds` keeps from the others: what it holds, or what it reserves, whichever is more. */
function needs(holds: Record<string, Hold>): Map<string, number> {
  const held = new Map<string, { vcpus: number; reserve: number }>();

  for (const [holder, hold] of Object.entries(holds)) {
    const job = holder.slice(0, holder.lastIndexOf('/'));
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
  /** Whether `holder` holds `vcpus` now; it keeps them until `release`, or its lease ends past its job's `deadlineAt`.
   *  Its job keeps `reserve` from the other jobs while it holds any: a holder is granted only once its job's whole
   *  reserve fits beside theirs, so the ranks of two jobs' gangs never split the fleet between them and wait on each
   *  other forever. */
  async acquire(holder: string, vcpus: number, { reserve = vcpus, deadlineAt, now = Date.now() }: { readonly reserve?: number; readonly deadlineAt: number; readonly now?: number }): Promise<boolean> {
    const holds = this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), now);
    const { [holder]: _replaced, ...others } = holds;
    const wanted = { ...others, [holder]: { vcpus, until: Math.max(now, deadlineAt) + LEASE_MS, reserve } };
    const granted = [...needs(wanted).values()].reduce((sum, need) => sum + need, 0) <= Number(this.env.FLEET_VCPUS);

    await this.ctx.storage.put('holds', granted ? wanted : holds);

    return granted;
  }

  /** `holder`'s vCPUs back, now, or after `afterMs` for a container whose stop failed and that runs until then. A
   *  holder kept that way has ended: it keeps only its own vCPUs, not its job's reserve, which is for holders still
   *  to be granted. */
  async release(holder: string, afterMs = 0): Promise<void> {
    const holds = { ...await this.ctx.storage.get<Record<string, Hold>>('holds') };
    const held = holds[holder];

    if (held !== undefined && afterMs > 0) holds[holder] = { vcpus: held.vcpus, until: Math.min(held.until, Date.now() + afterMs) };
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
      const id = holder.slice(0, holder.lastIndexOf('/'));
      const share = jobs.get(id) ?? { vcpus: 0, containers: 0 };

      jobs.set(id, { vcpus: share.vcpus + hold.vcpus, containers: share.containers + 1 });
    }

    return { cap: Number(this.env.FLEET_VCPUS), jobs: [...jobs].map(([id, share]) => ({ id, ...share })).sort((left, right) => right.vcpus - left.vcpus) };
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
