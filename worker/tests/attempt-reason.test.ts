import { expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema } from '../../src/protocol';
import { ArmadaFleet, RECALL_GRACE_MS } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { container, namespace, readyRegistry, state, statusOf, world } from './harness';

// 20261109193345-8dc29c9c: attempt 2 succeeded, but v1 was done / 0 tasks / error null,
// with no attempt-1 event. Exercise the real fleet recall, vessel alarm and job requeue.
test('records why the fleet ended a running attempt, without reporting the retried task as failed', async () => {
  const now = Date.now();
  const deadlineAt = now + 6 * 60 * 60_000;
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '8' }));
  const begun: VesselSpec[] = [];
  const env = world({
    FLEET: namespace(() => fleet),
    ENVIRONMENTS: readyRegistry(),
    VESSEL: namespace(() => ({ begin: async (spec: VesselSpec) => { begun.push(spec); }, stop: async () => true })),
  });
  const job = new ArmadaJob(state().ctx, env);

  try {
    setSystemTime(now);
    await job.create('low', v.parse(JobSpecSchema, {
      recipe: { size: 'large' }, items: [{ item: 'long', argv: ['sleep', '21600'] }],
      run: { kind: 'command' }, pool: 1, timeout: 21600,
    }));
    await job.alarm();
    const spec = begun[0];

    if (spec === undefined) throw new Error('the job began no vessel');
    expect(await fleet.acquire('low/v1', 8, { deadlineAt })).toBe('held');
    await job.booted('v1', 1190);
    const claim = await job.claim('v1');

    if (claim === null || 'waitMs' in claim) throw new Error('v1 got no task');
    expect(claim.attempt).toBe(1);
    // As in fleet.test.ts: the process is running; only the exec boundary is simulated.
    const stored = state(container(() => ({ exitCode: 0, stdout: '' })));
    const vessel = new ArmadaVessel(stored.ctx, world({ ...env, JOB: namespace(() => job) }));
    const { env: _env, ...kept } = claim;

    await stored.ctx.storage.put({ spec, state: 'working', 'slot:0': { claim: kept, startedAt: now } });
    setSystemTime(now + 51 * 60_000);
    expect(await fleet.acquire('urgent/v1', 8, { deadlineAt, priority: 5 })).toBeNull();
    setSystemTime(now + 51 * 60_000 + RECALL_GRACE_MS + 1);
    await vessel.alarm();
    const interrupted = await job.status();

    expect(await stored.ctx.storage.get('state')).toBe('done');
    expect(await stored.ctx.storage.get('slot:0')).toBeUndefined();
    expect(interrupted?.tasks).toMatchObject({ queued: 1, running: 0, failed: 0 });
    expect(await job.events(0)).toEqual({ events: [], done: false });
    expect(await statusOf(job, 0)).toMatchObject({ status: { state: 'queued', attempt: 1, running: [] } });
    expect(begun.map(({ name }) => name)).toEqual(['v1', 'v2']);
    expect(await fleet.acquire('urgent/v1', 8, { deadlineAt, priority: 5 })).toBe('held');
    await fleet.release('urgent/v1');
    expect(await fleet.acquire('low/v2', 8, { deadlineAt })).toBe('held');

    const retry = await job.claim('v2');

    if (retry === null || 'waitMs' in retry) throw new Error('v2 got no retry');
    expect(retry.attempt).toBe(2);
    expect(await job.accept('v2', 0, 0, { attempt: retry.attempt, slot: 0 })).toBe(true);
    await job.complete('v2', {
      index: 0, kind: 'exited', exitCode: 0, seconds: 10, vessel: 'v2', attempt: retry.attempt,
      slot: 0, tail: 'success', output: false,
    }, 10_000);
    const finished = await job.events(0);

    expect(finished.done).toBe(true);
    expect(finished.events.map(({ outcome }) => [outcome.kind, outcome.attempt, outcome.exitCode])).toEqual([['exited', 2, 0]]);
    // A successful replacement must not erase the interrupted container's reason.
    expect((await job.status())?.vessels.find(({ name }) => name === 'v1'))
      .toMatchObject({ state: 'done', tasks: 0, error: 'preempted by the fleet' });
  } finally {
    setSystemTime();
  }
});
