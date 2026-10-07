import { describe, expect, test } from 'bun:test';
import type { Outcome } from '../../src/protocol';
import { USAGE } from '../src/container';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { container, namespace, state, world } from './harness';

const spec: VesselSpec = {
  jobId: 'job', name: 'v1', snapshot: 'snapshot', instance: 'standard-4', vcpus: 4, workdir: '/home/ci/work', commit: null,
  tmpfs: [], files: {}, handler: null, output: false, timeout: 600,
};

/** One task through a vessel whose waits the platform loses `lost` times before the task's exit is read, and whose
 *  cgroup reads `usage`. */
async function run(lost: number, usage: { readonly exitCode: number; readonly stdout: string } | Error = { exitCode: 0, stdout: '' }) {
  const completed: Outcome[] = [];
  const failed: string[] = [];
  let claimed = false;
  let waits = 0;
  const stored = state(container((argv) => {
    if (argv[2] === USAGE) return usage;

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

  await vessel.begin(spec);

  for (let alarm = 0; alarm < 4; alarm += 1) await vessel.alarm();

  return { exits: completed.map((outcome) => outcome.exitCode), failed, completed };
}

describe('a vessel waiting on its task', () => {
  test('waits again where the platform lost a wait, and counts the container lost after three in a row', async () => {
    expect(await run(2)).toMatchObject({ exits: [0], failed: [] });
    expect(await run(3)).toMatchObject({ exits: [], failed: ['the wait failed to run: Network connection lost.'] });
  });
});

describe('a finished task', () => {
  test('reports its cgroup\'s peak memory and CPU seconds, and lands without them when they cannot be read', async () => {
    const [measured] = (await run(0, { exitCode: 0, stdout: '734003200\n2500000\n' })).completed;
    const [lost] = (await run(0, new Error('Network connection lost.'))).completed;

    expect([measured, lost].map((outcome) => outcome === undefined ? null : [outcome.exitCode, outcome.peakMemory, outcome.cpuSeconds])).toEqual([[0, 734003200, 2.5], [0, undefined, undefined]]);
  });
});
