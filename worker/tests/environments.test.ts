import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { PACKER, RecipeSchema, sha256 } from '../../src/protocol';
import { fakeFetch } from '../../tests/fakes';
import { ArmadaEnvironments, ArmadaPreparer, expired, retentionOf, type Generation } from '../src/environments';
import worker from '../src/worker';
import { container, namespace, state, world } from './harness';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

/** `environments`' alarm, run as the platform runs one: cleared, then handled. */
async function fire(stored: ReturnType<typeof state>, environments: ArmadaEnvironments): Promise<void> {
  await stored.ctx.storage.deleteAlarm();
  await environments.alarm();
}

const generation = (key: string): Generation => ({ key, snapshot: { id: `snapshot-${key}`, size: 1 }, sha: null, shallow: false, created: 0, seconds: {} });

const ready = (key: string, lastUsed: number) => ({ key, entry: { state: 'ready' as const, generation: generation(key), lastUsed } });

describe('the environments a prune deletes', () => {
  const now = Date.now();

  const entries = [
    ready('newest', now - 5 * MINUTE), ready('busy', now - 20 * MINUTE), ready('second', now - 2 * HOUR), ready('third', now - 3 * HOUR),
    ready('running', now - 9 * HOUR), { key: 'building', entry: { state: 'preparing' as const, sha: null, shallow: false, since: now } },
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
   *  `deleted` is the snapshots whose manifests are gone from the account's registry. */
  const deployment = async (credentials?: string) => {
    const stored = state();
    const open = ['job-1'];
    const fake = await registry(['a', 'fresh']);
    const deleted = () => ['a', 'fresh'].filter((key) => !fake.left().includes(key));

    globalThis.fetch = fakeFetch(fake.answer);

    const environments = new ArmadaEnvironments(stored.ctx, world({
      KEEP_ENVIRONMENTS: '0', REGISTRY_CREDENTIALS: credentials,
      FLEET: namespace(() => ({ open: async () => open })),
      JOB: namespace(() => ({ environment: async () => 'a' })),
    }));

    await stored.ctx.storage.put('env:a', { state: 'ready', generation: generation('a'), lastUsed: Date.now() - 5 * HOUR });

    return { stored, open, deleted, environments };
  };

  test('the read-only destroy inventory includes ready snapshots and exact deletion debts without changing either', async () => {
    const { stored, environments } = await deployment();
    const now = Date.now();

    await stored.ctx.storage.put('env:ready', { state: 'ready', generation: generation('ready'), lastUsed: now });
    await stored.ctx.storage.put('debt:snapshot-old', { key: 'ready', since: now });
    await stored.ctx.storage.put('debt:sha256:left', { key: 'gone', since: now });
    expect((await environments.inventory()).sort((a, b) => a.localeCompare(b))).toEqual(['sha256:left', 'snapshot-a', 'snapshot-old', 'snapshot-ready']);
    expect(await stored.ctx.storage.get<{ key: string; since: number }>('debt:snapshot-old')).toEqual({ key: 'ready', since: now });
  });

  test('GET /environments/inventory lists owned refs and credential expiry on the deployed wire', async () => {
    const { environments } = await deployment();
    const token = 't'.repeat(32);
    const env = world({ ARMADA_TOKEN: token, REGISTRY_CREDENTIALS_EXPIRE: '2027-10-01T00:00:00Z', VERSION: { id: 'v', tag: '', timestamp: '' }, ENVIRONMENTS: namespace(() => environments) });

    const answer = await worker.fetch(new Request('https://armada.test/environments/inventory', {
      headers: { authorization: `Bearer ${token}`, 'armada-protocol': '7' },
    }), env);

    expect(v.parse(v.object({ snapshots: v.array(v.string()), credentialsExpire: v.string() }), await answer.json())).toEqual({ snapshots: ['snapshot-a'], credentialsExpire: '2027-10-01T00:00:00Z' });
  });

  test('keeps an environment while a job uses it and for the hour after the job ends, then deletes it and stops looking', async () => {
    const start = Date.now();

    setSystemTime(new Date(start));
    const { stored, open, deleted, environments } = await deployment('user:secret');

    await fire(stored, environments);
    const whileUsed = [(await environments.list()).length, (await stored.ctx.storage.getAlarm()) === start + HOUR];

    // The job ends 50 minutes in, just before the next look.
    setSystemTime(new Date(start + 50 * MINUTE));
    open.length = 0;
    await environments.used('a');
    setSystemTime(new Date(start + HOUR + 1));
    await fire(stored, environments);
    const justAfter = (await environments.list()).length;

    setSystemTime(new Date(start + 2 * HOUR + 1));
    await fire(stored, environments);

    expect({ whileUsed, justAfter, after: (await environments.list()).length, deleted: deleted(), alarm: await stored.ctx.storage.getAlarm() })
      .toEqual({ whileUsed: [1, true], justAfter: 1, after: 0, deleted: ['a'], alarm: null });
  });

  test('deletes nothing and sets no look in a deployment without registry credentials', async () => {
    const { stored, open, deleted, environments } = await deployment();

    open.length = 0;
    await environments.prepared(generation('b'));

    expect({ kept: (await environments.list()).length, deleted: deleted(), alarm: await stored.ctx.storage.getAlarm() }).toEqual({ kept: 2, deleted: [], alarm: null });
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

  test('answers a route that threw with its error, as JSON, rather than the platform\'s bare exception page', async () => {
    const token = 't'.repeat(32);
    const env = world({ ARMADA_TOKEN: token, REGISTRY_CREDENTIALS: 'user:secret', VERSION: { id: 'v', tag: '', timestamp: '' }, ENVIRONMENTS: namespace(() => ({ prune: async () => { throw new Error('the registry object was reset'); } })) });

    const answer = await worker.fetch(new Request('https://armada.test/environments/prune', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'armada-protocol': '7', 'content-type': 'application/json' }, body: '{}',
    }), env);

    expect({ status: answer.status, said: v.parse(v.object({ error: v.string() }), await answer.json()).error.includes('the registry object was reset') }).toEqual({ status: 500, said: true });
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

/**
 * The registry as measured on 2026-10-09: a snapshot is a manifest a snapshot tag and a set tag name; the catalog pages
 * its names, tags and digests alike, `pageSize` at a time with a `last` cursor in a link without angle brackets; a DELETE
 * of a manifest a tag still names answers 204 and keeps it. `refuseDigest` fails the next digest delete.
 */
async function registry(keys: readonly string[], options: { readonly pageSize?: number } = {}) {
  const tags = new Map<string, string>();
  const manifests = new Map<string, string>();
  let refuseDigest = false;
  let loseDigest = false;

  for (const key of keys) {
    const digest = `sha256:${await sha256(`manifest-${key}`)}`;

    manifests.set(digest, key);
    tags.set(`rootfs-snapshot-${await sha256(`snapshot-${key}`)}`, digest);
    tags.set(`rootfs-set-${await sha256(`set-${key}`)}`, digest);
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
    else if (loseDigest) {
      loseDigest = false;

      throw new TypeError('Network connection lost.');
    } else if (refuseDigest) {
      refuseDigest = false;

      return new Response('busy', { status: 503 });
    } else if (![...tags.values()].includes(ref)) manifests.delete(ref);

    return new Response(null, { status: 204 });
  };

  return {
    tags, manifests, answer, left: () => [...manifests.values()].sort(),
    refuseNextDigest: () => { refuseDigest = true; },
    loseNextDigest: () => { loseDigest = true; },
  };
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

  test('keeps one a job asked for while the prune was asking which jobs are open', async () => {
    const stored = state();
    const fake = await registry(['b', 'new']);

    globalThis.fetch = fakeFetch(fake.answer);

    const environments = new ArmadaEnvironments(stored.ctx, world({
      KEEP_ENVIRONMENTS: '0', REGISTRY_CREDENTIALS: 'user:secret',
      // A job is admitted, and asks for b, while the fleet answers which jobs are open, without it.
      FLEET: namespace(() => ({
        open: async () => {
          await environments.ensure('b', v.parse(RecipeSchema, {}), null);

          return [];
        },
      })),
      JOB: namespace(() => ({ environment: async () => '' })),
    }));

    await stored.ctx.storage.put('env:b', { state: 'ready', generation: generation('b'), lastUsed: Date.now() - 4 * HOUR });
    await environments.prune({ keep: 0, recentMs: 0 });

    expect({ kept: (await environments.list()).map((each) => each.key), manifests: fake.left() }).toEqual({ kept: ['b'], manifests: ['b', 'new'] });
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
    await environments.prune({ keep: 5, recentMs: 0 });

    expect(fake.left()).toEqual(['k-first', 'k-second']);
  });

  test('a preparation\'s snapshot owed while no environment is ready is looked at again until its delete is done', async () => {
    const { environments, fake, stored } = await deployment([]);

    fake.refuseNextDigest();
    await environments.orphaned('snapshot-made', 'other');
    const first = await stored.ctx.storage.getAlarm();
    await fire(stored, environments);
    const owed = (await stored.ctx.storage.list({ prefix: 'debt:' })).size;
    const again = await stored.ctx.storage.getAlarm();

    await fire(stored, environments);

    expect({ first: first !== null, owed, again: again !== null, left: fake.left(), after: (await stored.ctx.storage.list({ prefix: 'debt:' })).size, last: await stored.ctx.storage.getAlarm() })
      .toEqual({ first: true, owed: 1, again: true, left: ['k-first', 'k-second'], after: 0, last: null });
  });

  test('a digest delete that fails once the tags are gone owes the digest, and the next prune deletes that', async () => {
    const { environments, fake, stored } = await deployment([]);
    await environments.orphaned('snapshot-made', 'other');
    fake.refuseNextDigest();
    await environments.prune({ keep: 5, recentMs: 0 });
    const owed = [...(await stored.ctx.storage.list({ prefix: 'debt:' })).keys()];
    const tags = fake.tags.size;
    await environments.prune({ keep: 5, recentMs: 0 });

    expect({ owed: owed.map((name) => name.startsWith('debt:sha256:')), tags, left: fake.left() }).toEqual({ owed: [true], tags: 4, left: ['k-first', 'k-second'] });
  });

  test('a digest delete lost once the tags are gone owes the digest all the same, and the next prune deletes that', async () => {
    const { environments, fake } = await deployment([]);
    await environments.orphaned('snapshot-made', 'other');
    fake.loseNextDigest();
    await environments.prune({ keep: 5, recentMs: 0 });
    const tags = fake.tags.size;
    await environments.prune({ keep: 5, recentMs: 0 });

    expect({ tags, left: fake.left() }).toEqual({ tags: 4, left: ['k-first', 'k-second'] });
  });
});

describe('a preparation under way', () => {
  test('is not taken for lost while its preparer beats, however long its phases run; one that stops beating is, after the lease', async () => {
    const stored = state();
    let begun = 0;
    const environments = new ArmadaEnvironments(stored.ctx, world({ PREPARER: namespace(() => ({ begin: async () => { begun += 1; } })) }));
    const recipe = v.parse(RecipeSchema, {});
    const start = Date.now();

    await environments.ensure('k', recipe, null, start);
    const { since } = v.parse(v.object({ since: v.number() }), await stored.ctx.storage.get('env:k'));

    // Its phases run on, past an hour, its preparer beating at each alarm.
    for (let minutes = 50; minutes <= 150; minutes += 50) {
      setSystemTime(start + minutes * MINUTE);
      await environments.beat('k', since);
    }

    const beating = await environments.ensure('k', recipe, null, start + 150 * MINUTE);
    const silent = await environments.ensure('k', recipe, null, start + 211 * MINUTE);

    setSystemTime();
    expect({ beating: beating.kind, silent: silent.kind, begun }).toEqual({ beating: 'preparing', silent: 'preparing', begun: 2 });
  });
});

describe('a preparation phase whose every exec times out', () => {
  test('loses its container after three in a row, though each takes a slice, and never outlives its bound', async () => {
    const start = Date.now();
    const failures: string[] = [];
    let now = start;

    try {
      setSystemTime(start);

      // Each exec runs out its own bound, longer than a slice, and the platform gives no answer.
      const stored = state(container(() => {
        now += 90_000;
        setSystemTime(now);

        return new Error('the exec timed out');
      }));

      const preparer = new ArmadaPreparer(stored.ctx, world({
        ENVIRONMENTS: namespace(() => ({ beat: async () => undefined, preparationFailed: async (_key: string, _since: number, reason: string) => { failures.push(reason); } })),
      }));

      await stored.ctx.storage.put('preparation', { key: 'k'.repeat(64), since: start, recipe: v.parse(RecipeSchema, { setup: 'true' }), sha: null, phase: 'setup', started: start, seconds: {}, snapshot: null });
      let alarms = 0;

      for (; alarms < 20 && failures.length === 0; alarms += 1) await preparer.alarm();

      expect({ alarms, failed: failures.map((reason) => reason.includes('failed to run')) }).toEqual({ alarms: 3, failed: [true] });
    } finally {
      setSystemTime();
    }
  });
});

describe('a snapshot the account refuses for its storage (#30)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemTime();
  });

  const FULL = 'The snapshot could not be completed because snapshot resource limits were exceeded.';

  /** An account that holds three snapshots, full with a, b and c, a used 5 hours ago, b 4 and c 3; `pinned` are the
   *  keys open jobs run on. A preparation of `new` has reached its snapshot, which the platform takes only while the
   *  account has room, or refuses with `refusal`. */
  const full = async (pinned: readonly string[], { refusal = FULL, credentials = 'user:secret', open = async () => pinned.map((key) => `job-${key}`) }: { readonly refusal?: string; readonly credentials?: string; readonly open?: () => Promise<string[]> } = {}) => {
    const stored = state();
    const fake = await registry(['a', 'b', 'c']);

    globalThis.fetch = fakeFetch(fake.answer);

    const environments = new ArmadaEnvironments(stored.ctx, world({
      KEEP_ENVIRONMENTS: '3', REGISTRY_CREDENTIALS: credentials === '' ? undefined : credentials,
      FLEET: namespace(() => ({ open })),
      JOB: namespace((id: string) => ({ environment: async () => id.slice('job-'.length) })),
      PREPARER: namespace(() => ({ begin: async () => undefined })),
    }));

    for (const [key, hoursAgo] of [['a', 5], ['b', 4], ['c', 3]] as const) {
      await stored.ctx.storage.put(`env:${key}`, { state: 'ready', generation: generation(key), lastUsed: Date.now() - hoursAgo * HOUR });
    }

    const recipe = v.parse(RecipeSchema, {});

    await environments.ensure('new', recipe, null);
    const { since } = v.parse(v.object({ since: v.number() }), await stored.ctx.storage.get('env:new'));
    let taken = 0;

    const machine = Object.assign(container(() => ({ exitCode: 0, stdout: '' })), {
      snapshotContainer: async () => {
        taken += 1;

        if (fake.manifests.size >= 3) throw new Error(refusal);

        return { id: 'snapshot-new', size: 1 };
      },
    });

    const preparing = state(machine);
    const preparer = new ArmadaPreparer(preparing.ctx, world({ ENVIRONMENTS: namespace(() => environments) }));

    await preparing.ctx.storage.put('preparation', { key: 'new', since, recipe, sha: null, phase: 'snapshot', seconds: {}, snapshot: null });

    return { stored, environments, preparer, fake, readiness: async () => await environments.ensure('new', recipe, null), taken: () => taken };
  };

  test('frees the least recently used environment no open job uses, and the jobs waiting on it wait for the snapshot taken again', async () => {
    const { environments, preparer, fake, readiness, taken } = await full(['a']);

    await preparer.alarm();
    const waiting = (await readiness()).kind;

    await preparer.alarm();

    expect({ waiting, after: (await readiness()).kind, taken: taken(), kept: (await environments.list()).map((each) => each.key).sort(), left: fake.left() })
      .toEqual({ waiting: 'preparing', after: 'ready', taken: 2, kept: ['a', 'c', 'new'], left: ['a', 'c'] });
  });

  test('waits while open jobs hold every snapshot, then fails saying what holds the storage; another failure fails at once', async () => {
    const pinned = await full(['a', 'b', 'c']);

    await pinned.preparer.alarm();
    const waiting = (await pinned.readiness()).kind;

    setSystemTime(Date.now() + 31 * MINUTE);
    await pinned.preparer.alarm();
    const ended = await pinned.readiness();
    const other = await full([], { refusal: 'internal error; reference = abc' });

    await other.preparer.alarm();

    expect({ waiting, ended: ended.kind === 'failed' && /held by open jobs/u.test(ended.reason), left: pinned.fake.left(), other: (await other.readiness()).kind, otherLeft: other.fake.left() })
      .toEqual({ waiting: 'preparing', ended: true, left: ['a', 'b', 'c'], other: 'failed', otherLeft: ['a', 'b', 'c'] });
  });

  test('asks again where asking for room failed, owes a delete that failed with a look due for it, and says when it has no credentials to delete with', async () => {
    let asked = 0;

    // The fleet does not answer the first ask for its open jobs; then none is open.
    const flaky = await full([], { open: async () => {
      asked += 1;

      if (asked === 1) throw new Error('the fleet object was reset');

      return [];
    } });

    await flaky.preparer.alarm();
    const afterFailedAsk = (await flaky.readiness()).kind;

    // The eviction's digest delete fails: its tags are gone, its manifest is owed, and a look is due.
    flaky.fake.refuseNextDigest();
    await flaky.preparer.alarm();
    const owed = [...(await flaky.stored.ctx.storage.list({ prefix: 'debt:' })).keys()].length;
    const look = await flaky.stored.ctx.storage.getAlarm();

    const bare = await full([], { credentials: '' });

    await bare.preparer.alarm();
    setSystemTime(Date.now() + 31 * MINUTE);
    await bare.preparer.alarm();
    const ended = await bare.readiness();

    expect({ afterFailedAsk, owed, look: look !== null, ended: ended.kind === 'failed' && /no registry credentials/u.test(ended.reason) })
      .toEqual({ afterFailedAsk: 'preparing', owed: 1, look: true, ended: true });
  });
});

describe('a pack base (#34)', () => {
  test('is a shallow environment\'s commit only for a pack of its commit\'s tree; a pack of full history goes from the root', async () => {
    const stored = state();
    const environments = new ArmadaEnvironments(stored.ctx, world({ PREPARER: namespace(() => ({ begin: async () => undefined })) }));
    const at = (key: string, sha: string, shallow: boolean) => ({ state: 'ready', generation: { ...generation(key), sha, shallow }, lastUsed: 0 });

    await stored.ctx.storage.put('env:shallow', at('shallow', 'a'.repeat(40), true));
    await stored.ctx.storage.put('env:full', at('full', 'b'.repeat(40), false));
    // As an earlier Worker recorded it, with no word of its history. Only an earlier client's recipe keys it, which has
    // no packer (`RecipeSchema`), and that client's packs are whole, as they always were taken to be.
    const { shallow: _unrecorded, ...earlier } = { ...generation('earlier'), sha: 'c'.repeat(40) };

    await stored.ctx.storage.put('env:earlier', { state: 'ready', generation: earlier, lastUsed: 0 });
    // One being prepared from a depth-1 clone's pack.
    const recipe = v.parse(RecipeSchema, { repo: { project: 'p', checkout: '/home/ci/work', history: 'full', manifest: [] } });

    await environments.ensure('preparing', recipe, { sha: 'd'.repeat(40), base: 'root', packer: PACKER, shallow: ['e'.repeat(40)] });
    const bases = await Promise.all((['shallow', 'full', 'earlier', 'preparing'] as const).flatMap((key) => (['full', 'commit'] as const).map(async (history) => await environments.base(key, history))));

    expect(bases).toEqual(['root', 'a'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'c'.repeat(40), 'root', 'd'.repeat(40)]);
  });
});

