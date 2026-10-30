import { expect, test } from 'bun:test';
import { ArmadaFleet } from '../src/fleet';
import { ArmadaVessel } from '../src/vessel';
import { container, namespace, state, world } from './harness';

const deadlineAt = Date.now() + 3_600_000;

test('a fleet holds no more medium containers than the account memory fits, though its vCPUs fit more', async () => {
  // 3000 vCPU and 6 TiB, the account's: 512 medium containers by memory, 750 by vCPUs.
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '3000', FLEET_MEMORY_MIB: String(6 * 1024 * 1024) }));
  const granted = [];

  for (let at = 0; at < 513; at++) granted.push(await fleet.acquire(`low/v${String(at)}`, 4, { deadlineAt, priority: -10 }));

  expect({ held: granted.filter((grant) => grant === 'held').length, refused: granted.filter((grant) => grant === null).length })
    .toEqual({ held: 512, refused: 1 });
});

test('a vessel the platform refuses for the account room waits in the fleet line, a lower one is refused, and the lower holds are recalled', async () => {
  Object.assign(globalThis, { scheduler: { wait: async () => undefined } });

  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '12' }));

  await fleet.acquire('low/v1', 4, { deadlineAt, priority: -10 });

  const box = Object.assign(container((argv) => (argv[2] ?? '').includes('echo ready')
    ? new Error('Network connection lost.') : { exitCode: 0, stdout: '' }), {
    monitor: async () => { throw new Error('Account resource limit exceeded'); },
  });

  const stored = state(box);

  const vessel = new ArmadaVessel(stored.ctx, world({
    FLEET: namespace(() => fleet),
    JOB: namespace(() => ({ moved: async () => true })),
  }));

  await vessel.begin({
    jobId: 'high', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4,
    workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null,
    output: false, timeout: 60, priority: 10, deadlineAt,
  });
  await vessel.alarm();

  expect(await stored.ctx.storage.get<string>('state')).toBe('waiting');
  expect({
    lowerGrant: await fleet.acquire('low/v2', 4, { deadlineAt, priority: -10 }),
    lowerRunsOn: await fleet.renews('low/v1'),
  }).toEqual({ lowerGrant: null, lowerRunsOn: false });
});
