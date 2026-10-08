import { afterEach, describe, expect, test } from 'bun:test';
import type { Recipe } from '../../src/protocol';
import { ArmadaEnvironments, superseded, type Generation } from '../src/environments';
import { namespace, state, world } from './harness';

const HOUR = 60 * 60_000;

const generation = (key: string): Generation => ({ key, snapshot: { id: `snapshot-${key}`, size: 1 }, sha: null, created: 0, seconds: {} });

const ready = (key: string, lastUsed: number) => ({ key, entry: { state: 'ready' as const, generation: generation(key), lastUsed } });

const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('the environments past those an armada keeps', () => {
  test('are the ready ones no open job uses, past the most recently used of those', () => {
    const now = Date.now();

    const entries = [
      ready('newest', now - HOUR), ready('second', now - 2 * HOUR), ready('third', now - 3 * HOUR), ready('fourth', now - 4 * HOUR),
      ready('running', now - 9 * HOUR), { key: 'building', entry: { state: 'preparing' as const, sha: null, since: now } },
      { key: 'broken', entry: { state: 'failed' as const, at: now, reason: 'no' } },
    ];

    // 'running' is the oldest, but an open job's containers start from it.
    expect(superseded(entries, 2, new Set(['running'])).map(({ key, snapshot }) => [key, snapshot])).toEqual([['third', 'snapshot-third'], ['fourth', 'snapshot-fourth']]);
  });
});

describe('a deployment that keeps one environment', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const pruning = async (startsOnB: boolean) => {
    const stored = state();
    // Each snapshot deleted, and whether its environment's record was already gone.
    const deleted: [string, boolean][] = [];
    const tags = new Map<string, string>();

    for (const key of ['old', 'b', 'c']) tags.set(`rootfs-snapshot-${await hex(`snapshot-${key}`)}`, key);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (new Headers(init?.headers).get('authorization') !== `Basic ${btoa('user:secret')}`) return new Response(null, { status: 401 });

      if (url.endsWith('/_catalog?tags=true')) return Response.json({ repositories: { 'cloudchamber-snapshots/x': [...tags.keys()] } });

      if (init?.method !== 'DELETE') return Response.json({ annotations: {} });
      const key = tags.get(url.split('/').at(-1) ?? '') ?? '';

      deleted.push([key, (await stored.ctx.storage.get(`env:${key}`)) === undefined]);

      // While c's snapshot is being deleted, a job starts on b, an environment the prune listed to go next.
      if (key === 'c' && startsOnB) await environments.ensure('b', {} as Recipe, null);

      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const environments = new ArmadaEnvironments(stored.ctx, world({
      KEEP_ENVIRONMENTS: '1', REGISTRY_CREDENTIALS: 'user:secret',
      FLEET: namespace(() => ({ open: async () => ['job-1'] })),
      JOB: namespace((id: string) => ({ environment: async () => (id === 'job-1' ? 'old' : '') })),
    }));

    for (const [key, hoursAgo] of [['old', 5], ['b', 4], ['c', 3]] as const) {
      await stored.ctx.storage.put(`env:${key}`, { state: 'ready', generation: generation(key), lastUsed: Date.now() - hoursAgo * HOUR });
    }

    await environments.prepared(generation('new'));

    return { deleted, kept: (await environments.list()).map((each) => each.key).sort() };
  };

  test('prunes the older ones once a new one is prepared, forgetting each before its snapshot goes, and spares the one an older job still runs on', async () => {
    expect(await pruning(false)).toEqual({ deleted: [['c', true], ['b', true]], kept: ['new', 'old'] });
  });

  test('keeps one a job asked for while the prune was under way', async () => {
    expect(await pruning(true)).toEqual({ deleted: [['c', true]], kept: ['b', 'new', 'old'] });
  });
});
