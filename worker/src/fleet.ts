/**
 * ArmadaFleet: the vCPUs running at once across every job of this deployment, held under its own FLEET_VCPUS. A
 * container over the cap waits for capacity rather than being refused by the platform mid-job. A hold names its
 * holder and lapses at its lease, so a holder that died returns it.
 *
 * It also keeps the jobs not yet done, and whether new ones are admitted: `armada deploy` drains the deployed version
 * (it admits no new job, and the open ones finish) before it replaces it. The drain names the version it drains, so
 * the version deployed after it admits jobs from its first request.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/** Longer than a container may live, so only a dead holder's vCPUs lapse. */
const LEASE_MS = 3 * 60 * 60_000;

interface Hold {
  readonly vcpus: number;
  readonly until: number;
}

/** How long a drain holds unless it is asked again: longer than a deploy's install, the Worker upload and its
 *  secrets, takes between two asks. */
export const DRAIN_MS = 10 * 60_000;

interface Drained {
  readonly version: string;
  readonly until: number;
}

export class ArmadaFleet extends DurableObject<Env> {
  /** Whether `holder` holds `vcpus` now; it keeps them until `release` or its lease. */
  async acquire(holder: string, vcpus: number, now = Date.now()): Promise<boolean> {
    const holds = this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), now);
    const used = Object.entries(holds).filter(([name]) => name !== holder).reduce((sum, [, hold]) => sum + hold.vcpus, 0);
    const granted = used + vcpus <= Number(this.env.FLEET_VCPUS);

    await this.ctx.storage.put('holds', granted ? { ...holds, [holder]: { vcpus, until: now + LEASE_MS } } : holds);

    return granted;
  }

  async release(holder: string): Promise<void> {
    const holds = { ...(await this.ctx.storage.get<Record<string, Hold>>('holds')) ?? {} };

    delete holds[holder];
    await this.ctx.storage.put('holds', holds);
  }

  async used(): Promise<number> {
    return Object.values(this.live(await this.ctx.storage.get<Record<string, Hold>>('holds'), Date.now())).reduce((sum, hold) => sum + hold.vcpus, 0);
  }

  private live(holds: Record<string, Hold> | undefined, now: number): Record<string, Hold> {
    return Object.fromEntries(Object.entries(holds ?? {}).filter(([, hold]) => hold.until > now));
  }

  /** A job not yet done. */
  /** Admits `job` unless `version` is drained, and counts it open in the same step: a drain then sees every job it
   *  did not refuse. */
  async reserve(version: string, job: string): Promise<boolean> {
    if (!(await this.admits(version))) return false;
    await this.ctx.storage.put(`job:${job}`, Date.now());

    return true;
  }

  async opened(job: string): Promise<void> {
    await this.ctx.storage.put(`job:${job}`, Date.now());
  }

  async closed(job: string): Promise<void> {
    await this.ctx.storage.delete(`job:${job}`);
  }

  /** The jobs not yet done, by id. */
  async open(): Promise<string[]> {
    return [...(await this.ctx.storage.list({ prefix: 'job:' })).keys()].map((name) => name.slice('job:'.length));
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
    if (typeof drained === 'string') return drained !== version;

    return drained === undefined || drained.version !== version || drained.until <= Date.now();
  }
}
