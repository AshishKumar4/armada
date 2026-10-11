import { describe, expect, test } from 'bun:test';
import { INACTIVITY_MS } from '../src/container';
import { ArmadaFleet } from '../src/fleet';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { container, namespace, state, world } from './harness';

const fleetOf = (vcpus: number) => new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: String(vcpus) }));

/** A job's deadline, an hour from now. */
const deadlineAt = Date.now() + 60 * 60_000;

describe('the fleet', () => {
  test('grants a gang\'s ranks only once all of them fit, so two jobs\' gangs never each hold half of a full fleet', async () => {
    const fleet = fleetOf(2);
    // Two jobs, each a gang of two 1-vCPU ranks, ask in turn.
    const granted = [];

    for (const holder of ['a/v1', 'b/v1', 'a/v2', 'b/v2']) granted.push(await fleet.acquire(holder, 1, { reserve: 2, deadlineAt }));

    await fleet.release('a/v1');
    await fleet.release('a/v2');

    expect({ granted, after: [await fleet.acquire('b/v1', 1, { reserve: 2, deadlineAt }), await fleet.acquire('b/v2', 1, { reserve: 2, deadlineAt })] }).toEqual({ granted: [true, false, true, false], after: [true, true] });
  });

  test('keeps a container\'s vCPUs held until it is gone: until a stop that failed has had its container end', async () => {
    const fleet = fleetOf(4);

    await fleet.acquire('a/v1', 4, { deadlineAt });
    await fleet.release('a/v1', 60_000);
    const whileRunning = await fleet.acquire('b/v1', 4, { deadlineAt });
    const later = await fleet.acquire('b/v1', 4, { deadlineAt, now: Date.now() + 61_000 });

    expect({ whileRunning, later }).toEqual({ whileRunning: false, later: true });
  });

  test('frees an ended gang\'s reserve while one container that would not stop still holds its own vCPUs', async () => {
    const fleet = fleetOf(2);

    for (const rank of ['v1', 'v2', 'v3', 'v4']) await fleet.acquire(`a/${rank}`, 0.5, { reserve: 2, deadlineAt });
    await fleet.release('a/v1', INACTIVITY_MS);

    for (const rank of ['v2', 'v3', 'v4']) await fleet.release(`a/${rank}`);
    await fleet.closed('a');

    expect({ used: await fleet.used(), granted: await fleet.acquire('b/v1', 1.5, { deadlineAt }), more: await fleet.acquire('b/v2', 0.5, { deadlineAt }) })
      .toEqual({ used: 0.5, granted: true, more: false });
  });

  test('lets a holder\'s vCPUs lapse only after its job\'s deadline and a container\'s idle timeout', async () => {
    const fleet = fleetOf(4);
    const ends = Date.now() + 10 * 60 * 60_000;

    await fleet.acquire('long/v1', 4, { deadlineAt: ends });
    const beforeEnd = await fleet.acquire('b/v1', 4, { deadlineAt, now: ends - 1 });
    const afterLease = await fleet.acquire('b/v1', 4, { deadlineAt, now: ends + INACTIVITY_MS + 1 });

    expect({ beforeEnd, afterLease }).toEqual({ beforeEnd: false, afterLease: true });
  });
});

describe('a vessel stopped while the fleet answers', () => {
  test('gives back what it was granted and starts nothing', async () => {
    const fleet = fleetOf(4);
    const answered = Promise.withResolvers<boolean>();
    let started = false;
    const box = Object.assign(container(() => ({ exitCode: 0, stdout: 'ready\n' })), { start: () => { started = true; } });
    const stored = state(box);

    const env = world({
      FLEET: namespace(() => ({
        acquire: async () => {
          await answered.promise;

          return await fleet.acquire('j/v1', 4, { deadlineAt });
        },
        release: fleet.release.bind(fleet),
      })),
      JOB: namespace(() => ({ waiting: async () => undefined })),
    });

    const vessel = new ArmadaVessel(stored.ctx, env);
    const spec: VesselSpec = { jobId: 'j', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4, workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null, output: false, timeout: 60 };

    await vessel.begin(spec);
    const alarm = vessel.alarm();

    await vessel.stop();
    answered.resolve(true);
    await alarm;

    expect({ started, free: await fleet.acquire('other/v1', 4, { deadlineAt }) }).toEqual({ started: false, free: true });
  });
});
