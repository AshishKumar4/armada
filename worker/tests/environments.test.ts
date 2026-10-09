import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { RecipeSchema } from '../../src/protocol';
import { fakeFetch } from '../../tests/fakes';
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

/**
 * The registry as measured on 2026-10-09: a snapshot is a manifest a snapshot tag and a set tag name; the catalog pages
 * its names, tags and digests alike, `pageSize` at a time with a `last` cursor in a link without angle brackets; a DELETE
 * of a manifest a tag still names answers 204 and keeps it. `refuseDigest` fails the next digest delete.
 */
async function registry(keys: readonly string[], options: { readonly pageSize?: number } = {}) {
  const tags = new Map<string, string>();
  const manifests = new Map<string, string>();
  let refuseDigest = false;

  for (const key of keys) {
    const digest = `sha256:${await hex(`manifest-${key}`)}`;

    manifests.set(digest, key);
    tags.set(`rootfs-snapshot-${await hex(`snapshot-${key}`)}`, digest);
    tags.set(`rootfs-set-${await hex(`set-${key}`)}`, digest);
  }

  const answer = (request: Request): Response => {
    const url = new URL(request.url);

    if (request.headers.get('authorization') !== `Basic ${btoa('user:secret')}`) return new Response(null, { status: 401 });

    if (url.pathname === '/v2/_catalog') {
      const names = [...tags.keys(), ...manifests.keys()].sort();
      const last = url.searchParams.get('last');
      const from = last === null ? 0 : names.indexOf(last) + 1;
      const page = names.slice(from, from + (options.pageSize ?? 1000));
      const headers = from + page.length < names.length ? { link: `https://registry.cloudflare.com/v2/_catalog?n=1000&last=${page.at(-1) ?? ''}&tags=true; rel=next` } : undefined;

      return Response.json({ repositories: { 'a/other': null, 'a/cloudchamber-snapshots/x': page } }, { headers });
    }

    const ref = url.pathname.split('/manifests/')[1] ?? '';
    const digest = ref.startsWith('sha256:') ? ref : tags.get(ref);
    const key = digest === undefined ? undefined : manifests.get(digest);

    if (digest === undefined || key === undefined) return new Response(null, { status: 404 });

    if (request.method === 'GET') return Response.json({ annotations: { 'io.cloudflare.cloudchamber.snapshot_set_id': `set-${key}` } }, { headers: { 'docker-content-digest': digest } });

    if (!ref.startsWith('sha256:')) tags.delete(ref);
    else if (refuseDigest) {
      refuseDigest = false;

      return new Response('busy', { status: 503 });
    } else if (![...tags.values()].includes(ref)) manifests.delete(ref);

    return new Response(null, { status: 204 });
  };

  return { tags, manifests, answer, left: () => [...manifests.values()].sort(), refuseNextDigest: () => { refuseDigest = true; } };
}

describe('a deployment that keeps one environment', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const pruning = async (startsOnB: boolean) => {
    const stored = state();
    // Each snapshot whose last tag went, and whether its environment's record was already gone.
    const deleted: [string, boolean][] = [];
    const fake = await registry(['old', 'b', 'c', 'new'], { pageSize: 3 });

    globalThis.fetch = fakeFetch(async (request) => {
      const ref = request.url.split('/manifests/')[1] ?? '';
      const key = request.method === 'DELETE' && ref.startsWith('rootfs-snapshot-') ? fake.manifests.get(fake.tags.get(ref) ?? '') : undefined;

      if (key !== undefined) {
        deleted.push([key, (await stored.ctx.storage.get(`env:${key}`)) === undefined]);

        // While c's snapshot is being deleted, a job starts on b, an environment the prune listed to go next.
        if (key === 'c' && startsOnB) await environments.ensure('b', v.parse(RecipeSchema, {}), null);
      }

      return fake.answer(request);
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

    return { deleted, kept: (await environments.list()).map((each) => each.key).sort(), manifests: fake.left() };
  };

  test('prunes the older ones once a new one is prepared, forgetting each before its snapshot goes, and spares the one an older job still runs on', async () => {
    expect(await pruning(false)).toEqual({ deleted: [['c', true], ['b', true]], kept: ['new', 'old'], manifests: ['new', 'old'] });
  });

  test('keeps one a job asked for while the prune was under way', async () => {
    expect(await pruning(true)).toEqual({ deleted: [['c', true]], kept: ['b', 'new', 'old'], manifests: ['b', 'new', 'old'] });
  });
});

describe('a snapshot no environment records any more', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const deployment = async (open: readonly string[]) => {
    const stored = state();
    const fake = await registry(['k-first', 'k-second', 'made']);

    globalThis.fetch = fakeFetch(fake.answer);

    const environments = new ArmadaEnvironments(stored.ctx, world({
      KEEP_ENVIRONMENTS: '5', REGISTRY_CREDENTIALS: 'user:secret',
      FLEET: namespace(() => ({ open: async () => [...open] })),
      JOB: namespace(() => ({ environment: async () => 'k' })),
    }));

    return { stored, fake, environments };
  };

  const under = (key: string, id: string): Generation => ({ ...generation(key), snapshot: { id: `snapshot-${id}`, size: 1 } });

  test('a generation its key replaced is deleted at the next prune, once no open job of that key could start from it', async () => {
    const running = await deployment(['job-1']);
    await running.environments.prepared(under('k', 'k-first'));
    await running.environments.prepared(under('k', 'k-second'));
    const whileOpen = running.fake.left();

    const idle = await deployment([]);
    await idle.environments.prepared(under('k', 'k-first'));
    await idle.environments.prepared(under('k', 'k-second'));

    expect({ whileOpen, after: idle.fake.left(), owed: [...(await idle.stored.ctx.storage.list({ prefix: 'debt:' })).keys()] })
      .toEqual({ whileOpen: ['k-first', 'k-second', 'made'], after: ['k-second', 'made'], owed: [] });
  });

  test('a preparation\'s snapshot it could not publish is owed and deleted', async () => {
    const { environments, fake } = await deployment([]);
    await environments.orphaned('snapshot-made', 'other');
    await environments.prune(5, 'user:secret');

    expect(fake.left()).toEqual(['k-first', 'k-second']);
  });

  test('a digest delete that fails once the tags are gone owes the digest, and the next prune deletes that', async () => {
    const { environments, fake, stored } = await deployment([]);
    await environments.orphaned('snapshot-made', 'other');
    fake.refuseNextDigest();
    await environments.prune(5, 'user:secret');
    const owed = [...(await stored.ctx.storage.list({ prefix: 'debt:' })).keys()];
    const tags = fake.tags.size;
    await environments.prune(5, 'user:secret');

    expect({ owed: owed.map((name) => name.startsWith('debt:sha256:')), tags, left: fake.left() }).toEqual({ owed: [true], tags: 4, left: ['k-first', 'k-second'] });
  });
});
