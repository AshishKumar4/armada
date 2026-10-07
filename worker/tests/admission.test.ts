import { afterEach, describe, expect, test } from 'bun:test';
import { Armada } from '../../src/sdk';
import type { Env } from '../src/env';
import { ArmadaFleet } from '../src/fleet';
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
  test('that speak different versions of the wire say which one to update', async () => {
    const { env, armada } = deployment();
    const asked = async (version?: string) => {
      const answer = await worker.fetch(new Request('https://armada.test/environments', { headers: { authorization: `Bearer ${TOKEN}`, ...version === undefined ? {} : { 'armada-protocol': version } } }), env);

      return [answer.status, (await answer.json() as { error?: string }).error];
    };

    expect({ older: await asked(), newer: await asked('4'), same: (await armada.health()).protocol }).toEqual({
      older: [426, 'this armada client is older than the deployed Worker. Update it to the deployed version: an install from install.sh with `curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh`, a checkout with `git pull`, and a project that pins armada by moving its pin'],
      newer: [426, 'the deployed Worker is older than this armada client: run `armada deploy` to update it'],
      same: 3,
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
        .toEqual({ jobs: 1, after: 0, admitted: undefined, asked: ['POST /drain 3', 'POST /drain 2', 'GET /health 2', 'DELETE /drain 2'] });
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
