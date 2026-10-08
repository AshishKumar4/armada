import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Armada } from '../../src/sdk';
import type { Env } from '../src/env';
import { ArmadaFleet, DRAIN_MS } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

const original = globalThis.fetch;

afterEach(() => { globalThis.fetch = original; });

/** A deployment of `version` whose fleet and jobs live in memory, and a client whose requests reach it. */
function deployment(fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '100' })), version = 'a') {
  const jobs = new Map<string, ArmadaJob>();

  const env: Env = world({
    ARMADA_TOKEN: TOKEN, VERSION: { id: version, tag: '', timestamp: '' }, FLEET: namespace(() => fleet),
    JOB: namespace((name: string) => jobs.get(name) ?? jobs.set(name, new ArmadaJob(state().ctx, env)).get(name)),
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => await worker.fetch(new Request(input, init), env)) as typeof fetch;

  return { armada: new Armada({ url: 'https://armada.test', token: TOKEN, account: 'a' }), fleet, env };
}

const spec = { recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' as const } };

describe('a client and a Worker', () => {
  test('that speak versions of the wire too far apart say which one to update, and an older client the wire still fits is served', async () => {
    const { env, armada } = deployment();

    const asked = async (version?: string) => {
      const answer = await worker.fetch(new Request('https://armada.test/jobs/none', { headers: { authorization: `Bearer ${TOKEN}`, ...version === undefined ? {} : { 'armada-protocol': version } } }), env);

      return [answer.status, (await answer.json()).error];
    };

    expect({ older: await asked('2'), served: await asked('3'), newer: await asked('8'), same: (await armada.health()).protocol }).toEqual({
      older: [426, 'this armada client is older than the deployed Worker. Update it to the deployed version: an install from install.sh with `curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh`, a checkout with `git pull`, and a project that pins armada by moving its pin'],
      served: [200, 'no such job'],
      newer: [426, 'the deployed Worker is older than this armada client: run `armada deploy` to update it'],
      same: 7,
    });
  });
});

describe('a drained version', () => {
  test('takes no new job while its open ones finish, and the version deployed after it takes jobs at once', async () => {
    const { armada, fleet } = deployment();
    const first = await armada.create(spec);
    const open = await armada.drain();
    const refused = await armada.create(spec).then(() => 'admitted', (error: unknown) => String(error));

    await armada.cancel(first);
    const after = (await armada.health()).jobs;
    const next = deployment(fleet, 'b');
    const admitted = await next.armada.create(spec).then(() => 'admitted', (error: unknown) => String(error));

    expect({ open, refused, after, admitted }).toEqual({
      open: 1, refused: 'RequestError: POST /jobs: 503 armada is being redeployed and takes no new job until that is done; run again in a few minutes', after: 0, admitted: 'admitted',
    });
  });

  test('counts a job admitted before it but still being made, so a deploy waits for it', async () => {
    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '100' }));
    const jobs = new Map<string, ArmadaJob>();
    let release = () => undefined as void;
    let reached = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const making = new Promise<void>((resolve) => { reached = resolve; });

    const env: Env = world({
      ARMADA_TOKEN: TOKEN, VERSION: { id: 'a', tag: '', timestamp: '' }, FLEET: namespace(() => fleet),
      // The job's own making waits for `release`, as a slow storage write or RPC would.
      JOB: namespace((name: string) => {
        const job = jobs.get(name) ?? jobs.set(name, new ArmadaJob(state().ctx, env)).get(name);

        return { create: async (id: string, spec: never) => { reached(); await held; await job?.create(id, spec); } };
      }),
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => await worker.fetch(new Request(input, init), env)) as typeof fetch;
    const armada = new Armada({ url: 'https://armada.test', token: TOKEN, account: 'a' });
    const creating = armada.create(spec).then(() => 'admitted', (error: unknown) => String(error));

    await making;
    const open = await armada.drain();

    release();

    expect({ open, created: await creating, after: await fleet.jobs() }).toEqual({ open: 1, created: 'admitted', after: 1 });
  });

  test('gives back the place of a job refused while it is made', async () => {
    const { armada, fleet } = deployment();
    const refused = await armada.create({ ...spec, items: [] }).then(() => 'admitted', (error: unknown) => String(error));

    expect({ refused, open: await fleet.jobs() }).toEqual({ refused: 'RequestError: POST /jobs: 400 a job that is not open needs an item', open: 0 });
  });

  test('lapses by itself when the deploy that drained it stops asking, as one killed mid-deploy does', async () => {
    const { armada } = deployment();

    await armada.drain();
    const refused = await armada.create(spec).then(() => 'admitted', (error: unknown) => String(error));

    setSystemTime(new Date(Date.now() + DRAIN_MS + 1000));

    try {
      const admitted = await armada.create(spec).then(() => 'admitted', (error: unknown) => String(error));

      expect({ refused, admitted }).toEqual({ refused: 'RequestError: POST /jobs: 503 armada is being redeployed and takes no new job until that is done; run again in a few minutes', admitted: 'admitted' });
    } finally {
      setSystemTime();
    }
  });

  test('is drained, and read, by a client of any version, which a deploy across a version bump needs', async () => {
    const { env } = deployment();
    const asked = async (path: string, method: string) => (await worker.fetch(new Request(`https://armada.test${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': '9' } }), env)).status;

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
        .toEqual({ jobs: 1, after: 0, admitted: undefined, asked: ['POST /drain 7', 'POST /drain 6', 'POST /drain 5', 'POST /drain 4', 'POST /drain 3', 'POST /drain 2', 'GET /health 2', 'DELETE /drain 2'] });
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

    expect(await armada.create(spec).then(() => 'admitted', (error: unknown) => String(error))).toBe('admitted');
  });
});
