import { afterEach, expect, test } from 'bun:test';
import { Armada } from '../../src/sdk';
import type { Env } from '../src/env';
import { ArmadaFleet } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { fakeFetch } from '../../tests/fakes';
import { namespace, readyRegistry, state, world } from './harness';

const TOKEN = 't'.repeat(32);

const original = globalThis.fetch;

afterEach(() => { globalThis.fetch = original; });

const deadlineAt = Date.now() + 60 * 60_000;

test('a done job gives back every hold its vessels still have in the fleet, and an open one is refused', async () => {
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '8' }));
  const jobs = new Map<string, ArmadaJob>();

  const env: Env = world({
    ARMADA_TOKEN: TOKEN, FLEET: namespace(() => fleet), ENVIRONMENTS: readyRegistry(),
    JOB: namespace((name: string) => jobs.get(name) ?? jobs.set(name, new ArmadaJob(state().ctx, env)).get(name)),
    VESSEL: namespace(() => ({ begin: async () => {}, stop: async () => true })),
  });

  globalThis.fetch = fakeFetch(async (request) => await worker.fetch(request, env));

  const armada = new Armada({ url: 'https://armada.test', token: TOKEN, account: 'a' });
  const id = await armada.create({ recipe: { size: 'medium' }, items: [{ item: 'a', argv: ['sleep', '2400'] }], run: { kind: 'command' }, pool: 1, priority: -10 });
  const job = jobs.get(id);

  if (job === undefined) throw new Error('no job');

  await job.alarm();

  await expect(armada.call(`/jobs/${id}/release`, { method: 'POST' })).rejects.toThrow('the job is not done');

  // Its vessel's hold, which a release its cleanup lost left in the fleet, as a cancel that ended it.
  await fleet.acquire(`${id}/v1`, 4, { deadlineAt, priority: -10, renewed: true });
  await job.cancel('cancelled by its client', 'cancelled');

  const released = await armada.call(`/jobs/${id}/release`, { method: 'POST' });

  expect({ released: await released.json(), used: await fleet.used() }).toEqual({ released: { released: 1 }, used: 0 });
});
