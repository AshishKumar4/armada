import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema } from '../../src/protocol';
import { ArmadaFleet } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { namespace, readyRegistry, state, world } from './harness';

const deadlineAt = Date.now() + 60 * 60_000;
const spec: VesselSpec = {
  jobId: 'low', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4,
  workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null,
  output: false, timeout: 60, deadlineAt: null, priority: -10,
};

describe('terminal cleanup across RPC failures', () => {
  test.each([false, true])('retries a release lost after the vessel has persisted its terminal state (RPC failure: %s)', async (injected) => {
    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '4' }));
    let failRelease = injected;
    // A transport failure before delivery, not a replacement of the fleet's implementation.
    const rpc = new Proxy(fleet, {
      get(target, key) {
        if (key === 'release') return async (holder: string, afterMs: number) => {
          if (failRelease) {
            failRelease = false;
            throw new Error('Durable Object is overloaded');
          }
          return await target.release(holder, afterMs);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const vessel = new ArmadaVessel(state().ctx, world({ FLEET: namespace(() => rpc) }));

    await vessel.begin(spec);
    await fleet.acquire('low/v1', 4, { deadlineAt, priority: -10, renewed: true });
    if (injected) await expect(vessel.stop()).rejects.toThrow('Durable Object is overloaded');
    else await vessel.stop();
    // A scheduled retry must complete the release even though the vessel is already stopped.
    await vessel.alarm();
    const granted = await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 });
    const used = await fleet.used();
    // Removing the cause (explicitly redelivering the cleanup) restores capacity.
    await vessel.stop();
    const redelivered = await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 });

    expect({ granted, used, redelivered }).toEqual({ granted: 'held', used: 4, redelivered: 'held' });
  });

  test.each([false, true])('retries a stop lost after a cancelled job has concluded and closed in the fleet (RPC failure: %s)', async (injected) => {
    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '4' }));
    const vessel = new ArmadaVessel(state().ctx, world({ FLEET: namespace(() => fleet) }));
    let failStop = injected;
    const stored = state();
    const job = new ArmadaJob(stored.ctx, world({
      FLEET: namespace(() => fleet),
      ENVIRONMENTS: readyRegistry(),
      VESSEL: namespace(() => ({
        begin: async (began: VesselSpec) => await vessel.begin(began),
        stop: async () => {
          if (failStop) {
            failStop = false;
            throw new Error('Durable Object is overloaded');
          }
          return await vessel.stop();
        },
      })),
    }));

    await job.create('low', v.parse(JobSpecSchema, {
      recipe: { size: 'medium' }, items: [{ item: 'a', argv: ['sleep', '2400'] }],
      run: { kind: 'command' }, pool: 1, mode: 'fast', priority: -10,
    }));
    await job.alarm();
    await fleet.acquire('low/v1', 4, { deadlineAt, priority: -10, renewed: true });
    await job.cancel('cancelled by its client', 'cancelled');
    // Neither re-delivering cancel nor the job's next alarm currently retries the lost stop.
    await job.cancel('cancelled by its client', 'cancelled');
    await job.alarm();
    const share = await fleet.shares();
    const granted = await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 });
    await vessel.stop();
    const redelivered = await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 });

    expect({ leaked: share.jobs, granted, redelivered }).toEqual({
      leaked: [], granted: 'held', redelivered: 'held',
    });
  });
});
