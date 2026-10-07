/**
 * ArmadaSecrets: the deployment's secrets, by name. One object per deployment. A value is set and read only here: a
 * job keeps the names its tasks get, each task's claim reads the values, and nothing answers a value to a client.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export class ArmadaSecrets extends DurableObject<Env> {
  async set(name: string, value: string): Promise<void> {
    await this.ctx.storage.put(`secret:${name}`, value);
  }

  /** Whether there was one to delete. */
  async delete(name: string): Promise<boolean> {
    return await this.ctx.storage.delete(`secret:${name}`);
  }

  async names(): Promise<string[]> {
    return [...(await this.ctx.storage.list({ prefix: 'secret:' })).keys()].map((key) => key.slice('secret:'.length)).sort();
  }

  /** The values of those of `names` that are set. */
  async values(names: readonly string[]): Promise<Record<string, string>> {
    const held = await this.ctx.storage.get<string>(names.map((name) => `secret:${name}`));

    return Object.fromEntries(names.flatMap((name) => {
      const value = held.get(`secret:${name}`);

      return value === undefined ? [] : [[name, value]];
    }));
  }
}
