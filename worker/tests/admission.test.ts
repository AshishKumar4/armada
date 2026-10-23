import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { Armada } from '../../src/sdk';
import { JOB_LEASE_SECONDS, PROTOCOL } from '../../src/protocol';
import type { Env } from '../src/env';
import { ArmadaFleet, DRAIN_MS } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { fakeFetch, settled } from '../../tests/fakes';
import { idleVessels, namespace, readyRegistry, state, world } from './harness';

const TOKEN = 't'.repeat(32);

const original = globalThis.fetch;

afterEach(() => { globalThis.fetch = original; });

/** A deployment of `version` whose fleet and jobs live in memory, with `bindings`, and a client whose requests reach
 *  it; its jobs, by id; and `reset`, which gives a job a new object over its storage, as a reset does. */
function deployment(fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '100' })), version = 'a', bindings: Parameters<typeof world>[0] = {}) {
  const jobs = new Map<string, ArmadaJob>();
  // Each job's storage, which outlives its object.
  const stores = new Map<string, DurableObjectState>();

  const made = (name: string) => {
    const { ctx } = state();

    stores.set(name, ctx);

    return new ArmadaJob(ctx, env);
  };

  const env: Env = world({
    ARMADA_TOKEN: TOKEN, VERSION: { id: version, tag: '', timestamp: '' }, FLEET: namespace(() => fleet),
    JOB: namespace((name: string) => jobs.get(name) ?? jobs.set(name, made(name)).get(name)),
    ...bindings,
  });

  const reset = (id: string) => {
    const ctx = stores.get(id);

    if (ctx === undefined) throw new Error(`job ${id} has no object to reset`);
    jobs.set(id, new ArmadaJob(ctx, env));
  };

  globalThis.fetch = fakeFetch(async (request) => await worker.fetch(request, env));

  return { armada: new Armada({ url: 'https://armada.test', token: TOKEN, account: 'a' }), fleet, env, jobs, reset };
}

const spec = { recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' as const } };

/** Job `id`'s outcomes so far, each its reason and tail. */
async function reasons(armada: Armada, id: string) {
  return (await armada.events(id, 0)).events.map(({ outcome }) => [outcome.reason, outcome.tail]);
}

describe('a client and a Worker', () => {
  test('refuses an explicit task timeout beyond its job deadline before making or retaining the job', async () => {
    const { armada, env, fleet } = deployment();
    const short = { ...spec, timeout: 1800, deadline: 1799 };

    expect(await settled(armada.create(short))).toBe('Error: JobDeadlineTooShort: job deadline 1799 s is shorter than the task timeout 1800 s');
    const request = new Request('https://armada.test/jobs', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'armada-protocol': String(PROTOCOL) }, body: JSON.stringify(short) });
    const answer = await worker.fetch(request, env);

    expect(answer.status).toBe(400);
    expect(v.parse(v.object({ error: v.string() }), await answer.json()).error).toBe('JobDeadlineTooShort: job deadline 1799 s is shorter than the task timeout 1800 s');
    expect(await fleet.jobs()).toBe(0);
    // A shorter job bound is still valid when no task timeout was explicitly requested.
    expect(await settled(armada.create({ ...spec, deadline: 1799 }))).toBe('fulfilled');
  });

  test('makes a job with no deadline only for a client that follows it, with or without a task limit', async () => {
    const { armada, env, fleet } = deployment();
    const unfollowed = { ...spec, deadline: null };
    const refusal = 'JobDeadlineNone: a job with no deadline ends only through its client, so its client must follow it (lease)';
    const request = new Request('https://armada.test/jobs', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'armada-protocol': String(PROTOCOL) }, body: JSON.stringify(unfollowed) });
    const answer = await worker.fetch(request, env);
    const refused = { client: await settled(armada.create(unfollowed)), status: answer.status, error: v.parse(v.object({ error: v.string() }), await answer.json()).error, jobs: await fleet.jobs() };

    expect({ refused, followed: await settled(armada.create({ ...spec, deadline: null, timeout: null, lease: true })) })
      .toEqual({ refused: { client: `Error: ${refusal}`, status: 400, error: refusal, jobs: 0 }, followed: 'fulfilled' });
  });

  test('that speak versions of the wire too far apart say which one to update, and an older client the wire still fits is served', async () => {
    const { env, armada } = deployment();

    const asked = async (version?: string) => {
      const headers = new Headers({ authorization: `Bearer ${TOKEN}` });

      if (version !== undefined) headers.set('armada-protocol', version);
      const answer = await worker.fetch(new Request('https://armada.test/jobs/none', { headers }), env);

      return [answer.status, v.parse(v.object({ error: v.optional(v.string()) }), await answer.json()).error];
    };

    expect({ older: await asked('2'), served: await asked('3'), newer: await asked(String(PROTOCOL + 1)), same: (await armada.health()).protocol }).toEqual({
      older: [426, 'this armada client is older than the deployed Worker. Update it to the deployed version: an install from install.sh with `curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh`, a checkout with `git pull`, and a project that pins armada by moving its pin'],
      served: [404, 'no such job'],
      newer: [426, 'the deployed Worker is older than this armada client: run `armada deploy` to update it'],
      same: PROTOCOL,
    });
  });
});

describe('a drained version', () => {
  test('takes no new job while its open ones finish, and the version deployed after it takes jobs at once', async () => {
    const { armada, fleet } = deployment();
    const first = await armada.create(spec);
    const open = await armada.drain();
    const refused = await settled(armada.create(spec), 'admitted');

    await armada.cancel(first);
    const after = (await armada.health()).jobs;
    const next = deployment(fleet, 'b');
    const admitted = await settled(next.armada.create(spec), 'admitted');

    expect({ open, refused, after, admitted }).toEqual({
      open: 1, refused: 'RequestError: POST /jobs: 503 armada is being redeployed and takes no new job until that is done; run again in a few minutes', after: 0, admitted: 'admitted',
    });
  });

  test('admits the next version\'s first job once the fleet and each other deployment-wide object run its interface', async () => {
    const storage = state();
    // The interface each object runs: the earlier one until the platform replaces it, and none said by one too old to.
    const running = { fleet: 'earlier', environments: 'earlier', webhooks: 'none' };
    const single = (object: 'environments' | 'webhooks') => namespace(() => running[object] === 'none' ? {} : { contract: () => running[object] });
    const singles = { ENVIRONMENTS: single('environments'), SECRETS: single('environments'), TASKS: single('environments'), WEBHOOKS: single('webhooks') };
    const fleet = namespace(() => new ArmadaFleet(storage.ctx, world({ FLEET_VCPUS: '100', ARMADA_CONTRACT: running.fleet, ...singles })));
    const { armada } = deployment(undefined, 'b', { ARMADA_CONTRACT: 'later', FLEET: fleet });
    const answers: string[] = [];

    for (const replaced of ['fleet', 'environments', 'webhooks'] as const) {
      answers.push(await settled(armada.create(spec), 'admitted'));
      running[replaced] = 'later';
    }

    answers.push(await settled(armada.create(spec), 'admitted'));
    const refused = 'RequestError: POST /jobs: 503 armada is being redeployed and takes no new job until that is done; run again in a few minutes';

    expect(answers).toEqual([refused, refused, refused, 'admitted']);
  });

  test('refuses a job as being redeployed while its fleet still runs code that lacks the method the Worker calls', async () => {
    const { armada } = deployment(undefined, 'b', {
      FLEET: namespace(() => ({ admitJob: async () => { throw new TypeError('The RPC receiver does not implement the method "admitJob".'); } })),
    });

    expect(await settled(armada.create(spec), 'admitted')).toBe('RequestError: POST /jobs: 503 armada is being redeployed and its objects still run the earlier code; run again in a few minutes (The RPC receiver does not implement the method "admitJob".)');
  });

  test('admits no job whose objects answered their interface only after it drained', async () => {
    const asked = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();

    const slow = namespace(() => ({
      contract: async () => {
        asked.resolve();
        await answered.promise;
      },
    }));

    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '100', ENVIRONMENTS: slow }));
    const admitting = fleet.admitJob('a', undefined, 'j');

    await asked.promise;
    const open = await fleet.drain('a');

    answered.resolve();

    expect({ open, admitted: await admitting, after: await fleet.jobs() }).toEqual({ open: 0, admitted: false, after: 0 });
  });

  test('counts a job admitted before it but still being made, so a deploy waits for it', async () => {
    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '100' }));
    const jobs = new Map<string, ArmadaJob>();
    const held = Promise.withResolvers<void>();
    const making = Promise.withResolvers<void>();

    const env: Env = world({
      ARMADA_TOKEN: TOKEN, VERSION: { id: 'a', tag: '', timestamp: '' }, FLEET: namespace(() => fleet),
      // The job's own making waits for `held`, as a slow storage write or RPC would.
      JOB: namespace((name: string) => {
        const job = jobs.get(name) ?? jobs.set(name, new ArmadaJob(state().ctx, env)).get(name);

        return {
          create: async (id: string, given: Parameters<ArmadaJob['create']>[1]) => { making.resolve(); await held.promise; await job?.create(id, given); },
          // No record until it is made, as a job being made has none.
          status: async () => await job?.status() ?? null,
        };
      }),
    });

    globalThis.fetch = fakeFetch(async (request) => await worker.fetch(request, env));
    const armada = new Armada({ url: 'https://armada.test', token: TOKEN, account: 'a' });
    const creating = settled(armada.create(spec), 'admitted');

    await making.promise;
    const open = await armada.drain();

    held.resolve();

    expect({ open, created: await creating, after: await fleet.jobs() }).toEqual({ open: 1, created: 'admitted', after: 1 });
  });

  test('gives back the place of a job refused while it is made', async () => {
    const { armada, fleet } = deployment();
    const refused = await settled(armada.create({ ...spec, items: [] }), 'admitted');

    expect({ refused, open: await fleet.jobs() }).toEqual({ refused: 'RequestError: POST /jobs: 400 a job that is not open needs an item', open: 0 });
  });

  test('counts closed a job its own record says is done, and one never made long after it was admitted, in its health as in a drain', async () => {
    const { armada, fleet } = deployment();
    const done = await armada.create(spec);

    await armada.cancel(done);
    // Each leaked: counted open with no job behind it to close it, as a race or an older version left them.
    await fleet.opened(done);
    await fleet.admitJob('a', undefined, 'never-made');
    const making = await armada.create({ ...spec, open: true });
    // Its health counts first: a deploy's watcher or the dashboard reads it with no drain before.
    const before = [(await armada.health()).jobs, await armada.drain()];

    setSystemTime(new Date(Date.now() + 11 * 60_000));

    try {
      const after = [(await armada.health()).jobs, await armada.drain()];

      expect({ before, after, open: await fleet.open() }).toEqual({ before: [2, 2], after: [1, 1], open: [making] });
    } finally {
      setSystemTime();
    }
  });

  test('lapses by itself when the deploy that drained it stops asking, as one killed mid-deploy does', async () => {
    const { armada } = deployment();

    await armada.drain();
    const refused = await settled(armada.create(spec), 'admitted');

    setSystemTime(new Date(Date.now() + DRAIN_MS + 1000));

    try {
      const admitted = await settled(armada.create(spec), 'admitted');

      expect({ refused, admitted }).toEqual({ refused: 'RequestError: POST /jobs: 503 armada is being redeployed and takes no new job until that is done; run again in a few minutes', admitted: 'admitted' });
    } finally {
      setSystemTime();
    }
  });

  test('is drained, and read, by a client of any version, which a deploy across a version bump needs', async () => {
    const { env } = deployment();
    const asked = async (path: string, method: string) => (await worker.fetch(new Request(`https://armada.test${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': String(PROTOCOL + 1) } }), env)).status;

    expect([await asked('/drain', 'POST'), await asked('/health', 'GET'), await asked('/drain', 'DELETE'), await asked('/jobs', 'POST')]).toEqual([200, 200, 200, 426]);
  });

  test('that drains only in its own older version is drained in that version, and polled and admitted in it', async () => {
    const asked: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const spoken = request.headers.get('armada-protocol') ?? '';

        asked.push(`${request.method} ${new URL(request.url).pathname} ${spoken}`);

        if (spoken !== '2') return Response.json({ error: 'the deployed Worker is older than this armada client' }, { status: 426 });

        return new URL(request.url).pathname === '/health' ? Response.json({ ok: true, driver: 1, protocol: 2, vcpus: 0, jobs: 0 }) : Response.json({ jobs: 1 });
      },
    });

    try {
      const old = new Armada({ url: server.url.href, token: TOKEN, account: 'a' });

      expect({ jobs: await old.drain(), after: (await old.health()).jobs, admitted: await old.admit(), asked })
        .toEqual({ jobs: 1, after: 0, admitted: undefined, asked: [...Array.from({ length: PROTOCOL - 1 }, (_, at) => `POST /drain ${String(PROTOCOL - at)}`), 'GET /health 2', 'DELETE /drain 2'] });
    } finally {
      await server.stop(true);
    }
  });

  test('from before the drain tells a deploy it cannot be drained', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: 'this armada client is older than the deployed Worker' }, { status: 426 }) });

    try {
      expect(await new Armada({ url: server.url.href, token: TOKEN, account: 'a' }).drain()).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test('takes jobs again once admitted', async () => {
    const { armada } = deployment();

    await armada.drain();
    await armada.admit();

    expect(await settled(armada.create(spec), 'admitted')).toBe('admitted');
  });
});

// #50: a CI run cancelled in GitHub left its suite on 85 containers to its deadline, beside the next run's.
describe('a job its client follows', () => {
  test('ends once its client stops renewing its lease, runs on while it renews, and a job no client follows runs on', async () => {
    const { armada, jobs } = deployment(undefined, 'a', { ENVIRONMENTS: readyRegistry(), VESSEL: idleVessels() });
    const began = Date.now();
    const [lease, watchdog] = [JOB_LEASE_SECONDS * 1000, 15_000];

    try {
      setSystemTime(began);
      const [gone, kept, unfollowed] = [await armada.create({ ...spec, lease: true }), await armada.create({ ...spec, lease: true }), await armada.create(spec)];
      let renewed = false;

      // Each watchdog on time, the kept job's client renewing halfway through a lease.
      for (let at = began; at <= began + lease + watchdog; at += watchdog) {
        setSystemTime(at);
        if (!renewed && at >= began + lease / 2) renewed = await armada.renew(kept);

        for (const id of [gone, kept, unfollowed]) await jobs.get(id)?.alarm();
      }

      const ended = await Promise.all([gone, kept, unfollowed].map(async (id) => await reasons(armada, id)));

      expect({ renewed, ended, after: await armada.renew(gone) }).toEqual({
        renewed: true, ended: [[['cancelled', `its client went away: it renewed no lease in ${String(JOB_LEASE_SECONDS)} s`]], [], []], after: false,
      });
    } finally {
      setSystemTime();
    }
  });

  // A storage failure reset a CI run's job and hung its next instance 165 s; the client's renewals, sent every 30 s
  // throughout, failed with it, and the instance after cancelled the job for a client that had not gone.
  test('counts its client silent only while its object runs: renewals lost while it did not are not its silence', async () => {
    const { armada, jobs, reset } = deployment(undefined, 'a', { ENVIRONMENTS: readyRegistry(), VESSEL: idleVessels() });
    const began = Date.now();
    const [lease, watchdog] = [JOB_LEASE_SECONDS * 1000, 15_000];

    try {
      setSystemTime(began);
      const id = await armada.create({ ...spec, lease: true });

      await jobs.get(id)?.alarm();
      setSystemTime(began + watchdog);
      await armada.renew(id);
      await jobs.get(id)?.alarm();

      // Its object reset and not running for longer than the lease, its client's renewals lost meanwhile.
      const back = began + watchdog + lease + 60_000;

      setSystemTime(back);
      reset(id);
      await jobs.get(id)?.alarm();
      const kept = await reasons(armada, id);

      // A client gone for good still ends it, a lease after, its watchdog on time throughout.
      for (let at = back + watchdog; at <= back + lease + watchdog; at += watchdog) {
        setSystemTime(at);
        await jobs.get(id)?.alarm();
      }

      expect({ kept, ended: await reasons(armada, id) }).toEqual({ kept: [], ended: [['cancelled', `its client went away: it renewed no lease in ${String(JOB_LEASE_SECONDS)} s`]] });
    } finally {
      setSystemTime();
    }
  });

  test('counts its client silent only once its object runs, though storage fails before its first watchdog', async () => {
    const { armada, jobs } = deployment(undefined, 'a', { ENVIRONMENTS: readyRegistry(), VESSEL: idleVessels() });
    const began = Date.now();
    const [lease, watchdog] = [JOB_LEASE_SECONDS * 1000, 15_000];

    try {
      setSystemTime(began);
      const id = await armada.create({ ...spec, lease: true });
      // Its first watchdog comes after more than a lease, its client's renewals lost meanwhile.
      const back = began + lease + 60_000;

      setSystemTime(back);
      await jobs.get(id)?.alarm();
      const kept = await reasons(armada, id);

      for (let at = back + watchdog; at <= back + lease + watchdog; at += watchdog) {
        setSystemTime(at);
        await jobs.get(id)?.alarm();
      }

      expect({ kept, ended: await reasons(armada, id) }).toEqual({ kept: [], ended: [['cancelled', `its client went away: it renewed no lease in ${String(JOB_LEASE_SECONDS)} s`]] });
    } finally {
      setSystemTime();
    }
  });

  test('ends a job with no deadline whose client is gone, though its object hibernates between watchdogs', async () => {
    const { armada, jobs, reset } = deployment(undefined, 'a', { ENVIRONMENTS: readyRegistry(), VESSEL: idleVessels() });
    const began = Date.now();
    const watchdog = 15_000;

    try {
      setSystemTime(began);
      const id = await armada.create({ ...spec, lease: true, deadline: null, timeout: null });

      // Each watchdog on time, each to an object made again over its storage, as one after hibernation is.
      for (let at = began; at <= began + JOB_LEASE_SECONDS * 1000 + watchdog; at += watchdog) {
        setSystemTime(at);
        reset(id);
        await jobs.get(id)?.alarm();
      }

      expect(await reasons(armada, id)).toEqual([['cancelled', `its client went away: it renewed no lease in ${String(JOB_LEASE_SECONDS)} s`]]);
    } finally {
      setSystemTime();
    }
  });
});
