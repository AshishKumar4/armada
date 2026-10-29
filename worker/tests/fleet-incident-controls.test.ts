import { expect, test } from 'bun:test';
import { ArmadaFleet } from '../src/fleet';
import { ArmadaVessel } from '../src/vessel';
import { namespace, state, world } from './harness';

const deadlineAt = Date.now() + 60 * 60_000;

test('a 2900-vCPU fleet grants 725 medium holds, not 445; refused waiters hold nothing', async () => {
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '2900' }));
  const granted = [];

  for (let at = 0; at < 726; at++) granted.push(await fleet.acquire(`low/v${String(at)}`, 4, { deadlineAt, priority: -10 }));
  expect({
    held: granted.filter((grant) => grant === 'held').length,
    refused: granted.filter((grant) => grant === null).length,
    used: await fleet.used(),
    share: (await fleet.shares()).jobs,
  }).toEqual({ held: 725, refused: 1, used: 2900, share: [{ id: 'low', vcpus: 2900, containers: 725 }] });
});

test('a stopped waiting vessel removes its demand and does not release another vessel hold', async () => {
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '4' }));
  await fleet.acquire('running/v1', 4, { deadlineAt, priority: -10 });
  const stored = state();
  const vessel = new ArmadaVessel(stored.ctx, world({
    FLEET: namespace(() => fleet),
    JOB: namespace(() => ({ moved: async () => true })),
  }));
  await vessel.begin({
    jobId: 'waiting', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4,
    workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null,
    output: false, timeout: 60, priority: -10,
  });
  await vessel.alarm();
  const usedWhileWaiting = await fleet.used();
  await vessel.stop();
  await fleet.release('running/v1');
  const next = await fleet.acquire('next/v1', 4, { deadlineAt, priority: -10 });

  expect({ usedWhileWaiting, next, alarm: await stored.ctx.storage.getAlarm() })
    .toEqual({ usedWhileWaiting: 4, next: 'held', alarm: null });
});

test('higher priority recalls actual lower holds, not lower-priority waiting demands', async () => {
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '4' }));
  await fleet.acquire('running/v1', 4, { deadlineAt, priority: -10 });
  await fleet.acquire('waiting/v1', 4, { deadlineAt, priority: -10 });
  const high = await fleet.acquire('train/v1', 4, { deadlineAt, priority: 10 });

  expect({
    high,
    runningRenews: await fleet.renews('running/v1'),
    runningEnds: (await fleet.beat('running/v1')) !== null,
    waitingEnds: await fleet.beat('waiting/v1'),
  }).toEqual({ high: null, runningRenews: false, runningEnds: true, waitingEnds: null });
});
