import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { RecipeSchema } from '../../src/protocol';
import { fakeFetch } from '../../tests/fakes';
import { ArmadaEnvironments, expired, retentionOf, type Generation } from '../src/environments';
import worker from '../src/worker';
import { namespace, state, world } from './harness';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const generation = (key: string): Generation => ({ key, snapshot: { id: `snapshot-${key}`, size: 1 }, sha: null, created: 0, seconds: {} });

const ready = (key: string, lastUsed: number) => ({ key, entry: { state: 'ready' as const, generation: generation(key), lastUsed } });

const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('the environments a prune deletes', () => {
  const now = Date.now();

  const entries = [
    ready('newest', now - 5 * MINUTE), ready('busy', now - 20 * MINUTE), ready('second', now - 2 * HOUR), ready('third', now - 3 * HOUR),
    ready('running', now - 9 * HOUR), { key: 'building', entry: { state: 'preparing' as const, sha: null, since: now } },
    { key: 'broken', entry: { state: 'failed' as const, at: now, reason: 'no' } },
  ];

  const keys = (keep: number, recentMs: number) => expired(entries, new Set(['running']), now, { keep, recentMs }).map(({ key, snapshot }) => [key, snapshot]);

  test('are the ready ones past the most recently used of those no open job uses, but for any used in the last hour', () => {
    // 'running' is the oldest, but an open job's containers start from it; 'busy' is past the one kept, but was used
    // 20 minutes ago.
    expect(keys(1, HOUR)).toEqual([['second', 'snapshot-second'], ['third', 'snapshot-third']]);
  });

  test('spare no recent hour when a prune is asked with a count: every one no open job uses goes at 0', () => {
    expect(keys(0, 0).map(([key]) => key)).toEqual(['newest', 'busy', 'second', 'third']);
  });

  test('keep three by default, or the count the deploy set', () => {
    expect([retentionOf({}).keep, retentionOf({ KEEP_ENVIRONMENTS: '5' }).keep]).toEqual([3, 5]);
  });
});

describe('a deployment\'s hourly look at its environments', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemTime();
  });

  /** A registry keeping none beyond its open jobs', whose one environment `a` the job `job-1` uses while `open` holds it;
   *  each snapshot deletion lands in `deleted`. */
  const deployment = async (credentials?: string) => {
    const stored = state();
    const open = ['job-1'];
    const deleted: string[] = [];

    globalThis.fetch = fakeFetch(async (request) => {
      if (request.url.endsWith('/_catalog?tags=true')) return Response.json({ repositories: { 'cloudchamber-snapshots/x': [`rootfs-snapshot-${await hex('snapshot-a')}`] } });

      if (request.method === 'DELETE') deleted.push(request.url.split('/').at(-1) ?? '');

      return request.method === 'DELETE' ? new Response(null, { status: 202 }) : Response.json({ annotations: {} });
    });

    const environments = new ArmadaEnvironments(stored.ctx, world({
      KEEP_ENVIRONMENTS: '0', REGISTRY_CREDENTIALS: credentials,
      FLEET: namespace(() => ({ open: async () => open })),
      JOB: namespace(() => ({ environment: async () => 'a' })),
    }));

    await stored.ctx.storage.put('env:a', { state: 'ready', generation: generation('a'), lastUsed: Date.now() - 5 * HOUR });

    return { stored, open, deleted, environments };
  };

  test('keeps an environment while a job uses it and for the hour after the job ends, then deletes it and stops looking', async () => {
    const start = Date.now();

    setSystemTime(new Date(start));
    const { stored, open, deleted, environments } = await deployment('user:secret');

    // As the platform runs an alarm: cleared, then handled.
    const fire = async () => {
      await stored.ctx.storage.deleteAlarm();
      await environments.alarm();
    };

    await fire();
    const whileUsed = [(await environments.list()).length, (await stored.ctx.storage.getAlarm()) === start + HOUR];

    // The job ends 50 minutes in, just before the next look.
    setSystemTime(new Date(start + 50 * MINUTE));
    open.length = 0;
    await environments.used('a');
    setSystemTime(new Date(start + HOUR + 1));
    await fire();
    const justAfter = (await environments.list()).length;

    setSystemTime(new Date(start + 2 * HOUR + 1));
    await fire();

    expect({ whileUsed, justAfter, after: (await environments.list()).length, deleted: deleted.length, alarm: await stored.ctx.storage.getAlarm() })
      .toEqual({ whileUsed: [1, true], justAfter: 1, after: 0, deleted: 1, alarm: null });
  });

  test('deletes nothing and sets no look in a deployment without registry credentials', async () => {
    const { stored, open, deleted, environments } = await deployment();

    open.length = 0;
    await environments.prepared(generation('b'));

    expect({ kept: (await environments.list()).length, deleted, alarm: await stored.ctx.storage.getAlarm() }).toEqual({ kept: 2, deleted: [], alarm: null });
  });

  test('looks on request with no count, as a deploy does: prunes past its retention and starts the hourly looks', async () => {
    const { stored, open, environments } = await deployment('user:secret');
    const token = 't'.repeat(32);

    open.length = 0;
    await stored.ctx.storage.put('env:fresh', { state: 'ready', generation: generation('fresh'), lastUsed: Date.now() });
    const env = world({ ARMADA_TOKEN: token, KEEP_ENVIRONMENTS: '0', REGISTRY_CREDENTIALS: 'user:secret', VERSION: { id: 'v', tag: '', timestamp: '' }, ENVIRONMENTS: namespace(() => environments) });

    const answer = await worker.fetch(new Request('https://armada.test/environments/prune', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'armada-protocol': '7', 'content-type': 'application/json' }, body: '{}',
    }), env);

    // It keeps none past the open jobs': 'a', idle 5 hours, goes, and 'fresh', used this hour, stays.
    expect({ pruned: v.parse(v.object({ pruned: v.array(v.string()) }), await answer.json()).pruned, kept: (await environments.list()).map(({ key }) => key), looking: (await stored.ctx.storage.getAlarm()) !== null })
      .toEqual({ pruned: ['a'], kept: ['fresh'], looking: true });
  });

  test('refuses a prune in a deployment without registry credentials, saying how to get them', async () => {
    const { environments } = await deployment();
    const token = 't'.repeat(32);
    const env = world({ ARMADA_TOKEN: token, VERSION: { id: 'v', tag: '', timestamp: '' }, ENVIRONMENTS: namespace(() => environments) });

    const answer = await worker.fetch(new Request('https://armada.test/environments/prune', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'armada-protocol': '7', 'content-type': 'application/json' }, body: '{}',
    }), env);

    expect({ status: answer.status, said: (await answer.text()).includes('deploy it again') }).toEqual({ status: 409, said: true });
  });

  test('prunes on request through the route: a count of 0 spares only what open jobs use, recent or not', async () => {
    const { stored, environments } = await deployment('user:secret');
    const token = 't'.repeat(32);

    // Used this very millisecond: a count of 0 spares no recent time at all.
    setSystemTime(new Date(Date.now()));
    await stored.ctx.storage.put('env:fresh', { state: 'ready', generation: generation('fresh'), lastUsed: Date.now() });
    const env = world({ ARMADA_TOKEN: token, REGISTRY_CREDENTIALS: 'user:secret', VERSION: { id: 'v', tag: '', timestamp: '' }, ENVIRONMENTS: namespace(() => environments) });

    const answer = await worker.fetch(new Request('https://armada.test/environments/prune', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'armada-protocol': '7', 'content-type': 'application/json' }, body: JSON.stringify({ keep: 0 }),
    }), env);

    expect({ pruned: v.parse(v.object({ pruned: v.array(v.string()) }), await answer.json()).pruned, kept: (await environments.list()).map(({ key }) => key) })
      .toEqual({ pruned: ['fresh'], kept: ['a'] });
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
    globalThis.fetch = fakeFetch(async (request) => {
      const { url } = request;

      if (request.headers.get('authorization') !== `Basic ${btoa('user:secret')}`) return new Response(null, { status: 401 });

      if (url.endsWith('/_catalog?tags=true')) return Response.json({ repositories: { 'cloudchamber-snapshots/x': [...tags.keys()] } });

      if (request.method !== 'DELETE') return Response.json({ annotations: {} });
      const key = tags.get(url.split('/').at(-1) ?? '') ?? '';

      deleted.push([key, (await stored.ctx.storage.get(`env:${key}`)) === undefined]);

      // While c's snapshot is being deleted, a job starts on b, an environment the prune listed to go next.
      if (key === 'c' && startsOnB) await environments.ensure('b', v.parse(RecipeSchema, {}), null);

      return new Response(null, { status: 202 });
    });

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
