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
      const answer = await worker.fetch(new Request('https://armada.test/health', { headers: { authorization: `Bearer ${TOKEN}`, ...version === undefined ? {} : { 'armada-protocol': version } } }), env);

      return [answer.status, (await answer.json() as { error?: string }).error];
    };

    expect({ older: await asked(), newer: await asked('3'), same: (await armada.health()).protocol }).toEqual({
      older: [426, 'this armada client is older than the deployed Worker. Update it to the deployed version: an install from install.sh with `curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh`, a checkout with `git pull`, and a project that pins armada by moving its pin'],
      newer: [426, 'the deployed Worker is older than this armada client: run `armada deploy` to update it'],
      same: 2,
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
      open: 1, refused: 'Error: POST /jobs: 503 armada is being redeployed and takes no new job until that is done; run again in a few minutes', after: 0, admitted: 'admitted',
    });
  });

  test('takes jobs again once admitted', async () => {
    const { armada } = deployment();

    await armada.drain();
    await armada.admit();

    expect(await armada.create(spec).then(() => 'admitted', (error: unknown) => String(error))).toBe('admitted');
  });
});
