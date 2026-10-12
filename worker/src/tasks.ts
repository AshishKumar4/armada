/**
 * ArmadaTasks: the deployment's task ids, each with the project that owns it and the bundle it runs from, and every
 * other hold on a bundle: each open job's. One object per deployment, so a push is atomic: it takes ids no other
 * project owns, points them all at its bundle, and drops the ids its project no longer exports. A bundle nothing holds
 * any more is deleted (`sweep`).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Push } from '../../src/protocol';
import { bundleKey, type Env } from './env';

interface Entry {
  readonly project: string;
  readonly bundle: string;
  /** What runs the bundle; absent on an entry an earlier Worker wrote, which is always node. */
  readonly runtime?: 'node' | 'python';
}

/** A bundle the sweep took: `deleting` while its delete is out, `deleted` once it is gone, until it is uploaded again.
 *  No push or job takes it meanwhile, and its HEAD says it is not there, so a client uploads it again. */
type Swept = 'deleting' | 'deleted';

/** The R2 keys one delete takes at most. */
const DELETE_KEYS = 1000;

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

    for (let at = 0; at < doomed.length; at += DELETE_KEYS) await this.env.ARTIFACTS.delete(doomed.slice(at, at + DELETE_KEYS).map(bundleKey));

    for (const bundle of doomed) await this.ctx.storage.put(`swept:${bundle}`, 'deleted' satisfies Swept);
  }
}
