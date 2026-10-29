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

/** The fleet, its first `release` lost in transport before it arrives (a Durable Object overloaded). */
class LosesARelease extends ArmadaFleet {
  losing = true;

  override async release(holder: string, afterMs = 0): Promise<void> {
    if (this.losing) {
      this.losing = false;

      throw new Error('Durable Object is overloaded');
    }

    await super.release(holder, afterMs);
  }
}

describe('a terminal container gives its share of the fleet back though an RPC of its cleanup is lost', () => {
  test('a vessel whose release was lost retries it at its alarm', async () => {
    const fleet = new LosesARelease(state().ctx, world({ FLEET_VCPUS: '4' }));
    const vessel = new ArmadaVessel(state().ctx, world({ FLEET: namespace(() => fleet) }));

    await vessel.begin(spec);
    await fleet.acquire('low/v1', 4, { deadlineAt, priority: -10, renewed: true });
    await expect(vessel.stop()).rejects.toThrow('Durable Object is overloaded');
    await vessel.alarm();

    expect({ used: await fleet.used(), granted: await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 }) })
      .toEqual({ used: 0, granted: 'held' });
  });

  test('a cancelled job whose stop of a container was lost retries it as it settles up', async () => {
    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '4' }));
    const vessel = new ArmadaVessel(state().ctx, world({ FLEET: namespace(() => fleet) }));
    let losing = true;

    const job = new ArmadaJob(state().ctx, world({
      FLEET: namespace(() => fleet),
      ENVIRONMENTS: readyRegistry(),
      VESSEL: namespace(() => ({
        begin: async (began: VesselSpec) => await vessel.begin(began),
        stop: async () => {
          if (losing) {
            losing = false;

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
    await job.alarm();

    expect({ held: (await fleet.shares()).jobs, granted: await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 }) })
      .toEqual({ held: [], granted: 'held' });
  });
});
