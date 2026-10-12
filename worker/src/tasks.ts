/**
 * ArmadaTasks: the deployment's task ids, each with the project that owns it and the bundle it runs from, and every
 * other hold on a bundle: each open job's. One object per deployment, so a push is atomic: it takes ids no other
 * project owns, points them all at its bundle, and drops the ids its project no longer exports. A bundle nothing holds
 * any more is deleted (`sweep`).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Push } from '../../src/protocol';
import { bundleKey, SINGLE, type Env } from './env';

interface Entry {
  readonly project: string;
  readonly bundle: string;
  /** What runs the bundle; absent on an entry an earlier Worker wrote, which is always node. */
  readonly runtime?: 'node' | 'python';
}

/** A bundle the sweep took: `deleting` until the alarm has deleted it, `deleted` once it is gone, until it is uploaded
 *  again. No push or job takes it meanwhile, and its HEAD says it is not there, so a client uploads it again. */
type Swept = 'deleting' | 'deleted';

/** The R2 keys one delete takes at most. */
const DELETE_KEYS = 1000;

/** How soon deletes R2 did not take are made again. */
const DELETE_RETRY_MS = 60_000;

export class ArmadaTasks extends DurableObject<Env> {
  /** Records a push, or says why it is refused. The bundles its project's ids ran from before are retired, and deleted
   *  once nothing holds them. */
  async publish(push: Push): Promise<string | null> {
    if ((await this.swept(push.bundle)) !== undefined) return `upload the bundle ${push.bundle} first`;
    const all = await this.ctx.storage.list<Entry>({ prefix: 'id:' });

    for (const id of push.ids) {
      const owner = all.get(`id:${id}`)?.project;

      if (owner !== undefined && owner !== push.project) return `the task id ${id} belongs to the project ${owner}`;
    }

    const gone = [...all].filter(([key, entry]) => entry.project === push.project && !push.ids.includes(key.slice('id:'.length))).map(([key]) => key);
    const before = [...all.values()].filter((entry) => entry.project === push.project).map((entry) => entry.bundle);

    await this.ctx.storage.delete(gone);
    await this.ctx.storage.put(Object.fromEntries(push.ids.map((id) => [`id:${id}`, { project: push.project, bundle: push.bundle, runtime: push.runtime } satisfies Entry])));
    await this.retire(before);

    return null;
  }

  /** What `id` runs from and under, or undefined when no push named it. */
  async entryOf(id: string): Promise<{ readonly bundle: string; readonly runtime: 'node' | 'python' } | undefined> {
    const entry = await this.ctx.storage.get<Entry>(`id:${id}`);

    return entry === undefined ? undefined : { bundle: entry.bundle, runtime: entry.runtime ?? 'node' };
  }

  /** Holds `bundle` for job `job` until it ends (`unpin`), or says why it cannot: the sweep took it. */
  async pin(job: string, bundle: string): Promise<string | null> {
    if ((await this.swept(bundle)) !== undefined) return `upload the bundle ${bundle} first`;
    await this.ctx.storage.put(`pin:${job}`, bundle);

    return null;
  }

  /** Job `job` ended: its bundle is retired, and deleted once nothing else holds it. */
  async unpin(job: string): Promise<void> {
    const bundle = await this.ctx.storage.get<string>(`pin:${job}`);

    if (bundle === undefined) return;
    await this.ctx.storage.delete(`pin:${job}`);
    await this.retire([bundle]);
  }

  /** `bundle` was put in R2: a bundle the sweep deleted is there again. One still being deleted stays taken, since its
   *  delete may land after this put; its client uploads it again. */
  async uploaded(bundle: string): Promise<void> {
    if ((await this.swept(bundle)) === 'deleted') await this.ctx.storage.delete(`swept:${bundle}`);
  }

  /** Whether the sweep took `bundle`, so that whatever R2 says, it is not to be taken. */
  async taken(bundle: string): Promise<boolean> {
    return (await this.swept(bundle)) !== undefined;
  }

  private async swept(bundle: string): Promise<Swept | undefined> {
    return await this.ctx.storage.get<Swept>(`swept:${bundle}`);
  }

  /** Marks `bundles`, which something held until now, as retired, then deletes every retired bundle nothing holds. Which
   *  those are is decided, and they are marked taken, in one step no push or pin comes between, since only storage is
   *  awaited until then; whatever comes after is refused until the bundle is uploaded again. */
  private async retire(bundles: readonly string[]): Promise<void> {
    await this.adopt();

    for (const bundle of new Set(bundles)) await this.ctx.storage.put(`retired:${bundle}`, true);

    const held = new Set([
      ...[...(await this.ctx.storage.list<Entry>({ prefix: 'id:' })).values()].map((entry) => entry.bundle),
      ...(await this.ctx.storage.list<string>({ prefix: 'pin:' })).values(),
    ]);

    const retired = [...(await this.ctx.storage.list({ prefix: 'retired:' })).keys()].map((key) => key.slice('retired:'.length));
    const doomed = retired.filter((bundle) => !held.has(bundle));

    for (const bundle of doomed) {
      await this.ctx.storage.delete(`retired:${bundle}`);
      await this.ctx.storage.put(`swept:${bundle}`, 'deleting' satisfies Swept);
    }

    if (doomed.length > 0) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Deletes every bundle marked `deleting`. The alarm alone deletes, and the platform runs one alarm at a time and
   *  runs it again when the object restarted in it, so one delete of a bundle is out at a time, and none is left
   *  undone. One whose delete R2 did not take stays marked, deleted again at a later alarm: no push or job takes it
   *  meanwhile. */
  override async alarm(): Promise<void> {
    const deleting = [...await this.ctx.storage.list<Swept>({ prefix: 'swept:' })].flatMap(([key, swept]) => swept === 'deleting' ? [key.slice('swept:'.length)] : []);

    try {
      for (let at = 0; at < deleting.length; at += DELETE_KEYS) {
        const batch = deleting.slice(at, at + DELETE_KEYS);

        await this.env.ARTIFACTS.delete(batch.map(bundleKey));

        for (const bundle of batch) await this.ctx.storage.put(`swept:${bundle}`, 'deleted' satisfies Swept);
      }
    } catch (cause) {
      console.error(JSON.stringify({ bundles: deleting.length, deleting: String(cause) }));
      await this.ctx.storage.setAlarm(Date.now() + DELETE_RETRY_MS);
    }
  }

  /** The bundles of the jobs open when this registry began to keep their holds, which an earlier Worker made and pinned
   *  nothing, pinned once, before it first decides a bundle is free. Nothing else comes in meanwhile. */
  private async adopt(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>('adopted')) === true) return;

    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>('adopted')) === true) return;

      for (const job of await this.env.FLEET.getByName(SINGLE).open()) {
        const bundle = await this.env.JOB.getByName(job).bundle();

        if (bundle !== null && (await this.ctx.storage.get(`pin:${job}`)) === undefined) await this.ctx.storage.put(`pin:${job}`, bundle);
      }

      await this.ctx.storage.put('adopted', true);
    });
  }
}
