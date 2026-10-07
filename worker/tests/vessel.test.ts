import { describe, expect, test } from 'bun:test';
import type { Outcome } from '../../src/protocol';
import { STOPPED, USAGE } from '../src/container';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { container, namespace, state, world } from './harness';

const spec: VesselSpec = {
  jobId: 'job', name: 'v1', snapshot: 'snapshot', instance: 'standard-4', vcpus: 4, workdir: '/home/ci/work', commit: null,
  tmpfs: [], files: {}, bundle: null, output: false, timeout: 600,
};

/** One task through a vessel whose waits the platform loses `lost` times before the task's exit is read, whose cgroup
 *  reads `usage`, and whose output file holds `out` when the job keeps outputs. */
async function run(lost: number, usage: { readonly exitCode: number; readonly stdout: string } | Error = { exitCode: 0, stdout: '' }, out?: string, stopping = '') {
  const completed: Outcome[] = [];
  const failed: string[] = [];
  let claimed = false;
  let waits = 0;
  const stored = state(container((argv) => {
    if (argv[2] === USAGE) return usage;

    if (argv[2] === STOPPED) return { exitCode: 0, stdout: stopping };

    if (argv[0] === 'cat') return { exitCode: 0, stdout: out ?? '' };

    if (argv[3] !== 'wait') return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    waits += 1;

    return waits <= lost ? new Error('Network connection lost.') : { exitCode: 0, stdout: '0\n' };
  }));
  const job = {
    booted: async () => undefined,
    waiting: async () => undefined,
    claim: async () => {
      if (claimed) return null;
      claimed = true;

      return { index: 0, attempt: 1, argv: ['true'], env: {}, duplicate: false };
    },
    still: async () => true,
    accept: async () => true,
    complete: async (_name: string, outcome: Outcome) => { completed.push(outcome); },
    retired: async () => undefined,
    vesselFailed: async (_name: string, error: string) => { failed.push(error); },
  };
  const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job) }));

  await vessel.begin({ ...spec, output: out !== undefined });

  for (let alarm = 0; alarm < 4; alarm += 1) await vessel.alarm();

  return { exits: completed.map((outcome) => outcome.exitCode), failed, completed, claimed };
}

describe('a vessel waiting on its task', () => {
  test('waits again where the platform lost a wait, and counts the container lost after three in a row', async () => {
    expect(await run(2)).toMatchObject({ exits: [0], failed: [] });
    expect(await run(3)).toMatchObject({ exits: [], failed: ['the wait failed to run: Network connection lost.'] });
  });
});

describe('a container the platform is stopping', () => {
  test('takes no task: its vessel fails before claiming one, so the job replaces it', async () => {
    expect(await run(0, undefined, undefined, '2026-10-07T18:21:00Z\n'))
      .toMatchObject({ exits: [], claimed: false, failed: ['the platform asked the container to stop at 2026-10-07T18:21:00Z'] });
  });
});

describe('a finished task', () => {
  test('reports its cgroup\'s peak memory and CPU seconds, and lands without them when they cannot be read', async () => {
    const [measured] = (await run(0, { exitCode: 0, stdout: '734003200\n2500000\n' })).completed;
    const [lost] = (await run(0, new Error('Network connection lost.'))).completed;

    expect([measured, lost].map((outcome) => outcome === undefined ? null : [outcome.exitCode, outcome.peakMemory, outcome.cpuSeconds])).toEqual([[0, 734003200, 2.5], [0, undefined, undefined]]);
  });
});

describe('a task\'s output', () => {
  test('rides in its outcome as text up to 32 KiB, and is only stored beyond that', async () => {
    const small = (await run(0, undefined, '{"n": 1}')).completed[0];
    const large = (await run(0, undefined, 'x'.repeat(32 * 1024 + 1))).completed[0];

    expect([small?.output, small?.value, large?.output, large?.value]).toEqual([true, '{"n": 1}', true, undefined]);
  });
});
