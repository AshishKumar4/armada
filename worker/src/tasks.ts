/**
 * ArmadaTasks: the deployment's task ids, each with the project that owns it and the bundle it runs from. One object
 * per deployment, so a push is atomic: it takes ids no other project owns, points them all at its bundle, and drops the
 * ids its project no longer exports.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Push } from '../../src/protocol';
import type { Env } from './env';

interface Entry {
  readonly project: string;
  readonly bundle: string;
  /** What runs the bundle; absent on an entry an earlier Worker wrote, which is always node. */
  readonly runtime?: 'node' | 'python';
}

export class ArmadaTasks extends DurableObject<Env> {
  /** Records a push, or says why it is refused. */
  async publish(push: Push): Promise<string | null> {
    const all = await this.ctx.storage.list<Entry>({ prefix: 'id:' });

    for (const id of push.ids) {
      const owner = all.get(`id:${id}`)?.project;

      if (owner !== undefined && owner !== push.project) return `the task id ${id} belongs to the project ${owner}`;
    }

    const gone = [...all].filter(([key, entry]) => entry.project === push.project && !push.ids.includes(key.slice('id:'.length))).map(([key]) => key);

    await this.ctx.storage.delete(gone);
    await this.ctx.storage.put(Object.fromEntries(push.ids.map((id) => [`id:${id}`, { project: push.project, bundle: push.bundle, runtime: push.runtime } satisfies Entry])));

    return null;
  }

  /** What `id` runs from and under, or undefined when no push named it. */
  async entryOf(id: string): Promise<{ readonly bundle: string; readonly runtime: 'node' | 'python' } | undefined> {
    const entry = await this.ctx.storage.get<Entry>(`id:${id}`);

    return entry === undefined ? undefined : { bundle: entry.bundle, runtime: entry.runtime ?? 'node' };
  }

  /** Every bundle some id runs from. */
  async current(): Promise<string[]> {
    return [...new Set([...(await this.ctx.storage.list<Entry>({ prefix: 'id:' })).values()].map((entry) => entry.bundle))];
  }
}
