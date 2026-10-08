import { describe, expect, test } from 'bun:test';
import type { Outcome } from '../../src/protocol';
import { launchSlot, launchTask, slotTask, taskGroup, waitOn } from '../src/container';
import type { Claim } from '../src/job';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { bucket, container, namespace, state, world } from './harness';

const spec: VesselSpec = {
  jobId: 'job', name: 'v1', snapshot: 'snapshot', instance: 'standard-3', vcpus: 2, workdir: '/home/ci/work', commit: null,
  tmpfs: ['/tmp'], files: {}, bundle: null, output: false, timeout: 600, slots: 3, slotMemoryBytes: 512,
};

/** The slot a `waitOn` blocks on: its own dir's, or slot 0 of an unslotted vessel. */
function slotOf(script: string): number {
  const match = /slots\/(\d+)\/task/.exec(script);

  return match === null ? 0 : Number(match[1]);
}

/** A vessel of `spec.slots` slots, every slot loop running at once: its job hands it `claims`, then generated ones
 *  until `tasks` are given out, then none; each slot's waits answer `ends[slot]` in turn (then exits 0); storage gets
 *  `put` after `begin`. */
async function run({ claims = [], tasks = 0, ends = {}, put, spec: over, still = () => true, execs = {} }: { claims?: readonly (Claim | null)[]; tasks?: number; ends?: Readonly<Record<number, string[]>>; put?: Record<string, unknown>; spec?: Partial<VesselSpec>; still?: (index: number) => boolean; execs?: Readonly<Record<string, number>> } = {}) {
  const claimed: (number | undefined)[] = [];
  const completed: Outcome[] = [];
  const launched: { readonly script: string; readonly group: unknown }[] = [];
  const killed: string[] = [];
  const queue = [...claims];
  let given = 0;
  const stored = state(container(async (argv, options) => {
    if (argv[3] === 'launch') launched.push({ script: argv[2] ?? '', group: options?.env?.['ARMADA_CGROUP'] });
    if ((argv[2] ?? '').startsWith('set -eu\npid=')) killed.push(argv[2] ?? '');

    if (argv[3] !== 'wait') return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    const endsOf = ends[slotOf(argv[2] ?? '')] ?? [];
    const slow = execs[argv[2] ?? ''];

    if (slow !== undefined) await new Promise((resolve) => setTimeout(resolve, slow));

    return { exitCode: 0, stdout: endsOf.shift() ?? '0\n' };
  }));
  const job = {
    booted: async () => undefined,
    waiting: async () => undefined,
    claim: async (_name: string, slot?: number) => {
      const next = queue.shift();

      if (next !== undefined) {
        if (next !== null) claimed.push(slot);

        return next;
      }
      if (given >= tasks) return null;
      claimed.push(slot);

      return { index: given++, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false };
    },
    still: async (_name: string, index: number) => still(index),
    accept: async () => true,
    complete: async (_name: string, outcome: Outcome) => { completed.push(outcome); },
    retired: async () => undefined,
    vesselFailed: async () => undefined,
  };
  const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: bucket() }));

  await vessel.begin({ ...spec, ...over });
  if (put !== undefined) await stored.ctx.storage.put({ state: 'working', ...put });

  for (let alarm = 0; alarm < 6; alarm += 1) await vessel.alarm();

  return { claimed, completed, launched, killed };
}

describe('a slotted vessel', () => {
  test('fills every free slot, launches each isolated, and reports the slot each task ran in', async () => {
    const { claimed, completed, launched } = await run({ tasks: 3 });

    expect({
      slots: [...claimed].sort(),
      own: completed.map((outcome) => outcome.slot === claimed[outcome.index]),
      isolated: launched.every((each) => each.script.includes('unshare --mount')),
      overlay: launched.every((each) => each.script.includes('lowerdir=/home/ci/work')),
      groups: [...launched.map((each) => each.group)].sort(),
    }).toEqual({ slots: [0, 1, 2], own: [true, true, true], isolated: true, overlay: true, groups: [taskGroup(0), taskGroup(1), taskGroup(2)].sort() });
  });

  test('a slot the job drops is killed alone: the others run on to their answers', async () => {
    const { claimed, completed, killed } = await run({ tasks: 3, ends: { 0: [''], 1: [''], 2: [''] }, still: (index) => index !== 1 });
    const of = claimed[1];

    expect({ done: completed.map((outcome) => outcome.index).sort(), kills: killed.length, at: killed.every((argv) => argv.includes(slotTask(of ?? -1))) }).toEqual({ done: [0, 2], kills: 1, at: true });
  });

  test('a task past its bound is killed alone: it ends 124 timeout, the others their answers', async () => {
    const { completed } = await run({
      tasks: 2, ends: { 1: [''] },
      put: { 'slot:1': { claim: { index: 7, attempt: 1, argv: ['true'], secrets: [], duplicate: false }, startedAt: 0 } },
    });

    expect(completed.map((outcome) => [outcome.index, outcome.exitCode, outcome.reason] as const).sort((a, b) => a[0] - b[0])).toEqual([[0, 0, undefined], [1, 0, undefined], [7, 124, 'timeout']]);
  });

  test('a stored `current` an earlier Worker left is finished as slot 0', async () => {
    const { completed } = await run({ spec: { slots: 1 }, ends: { 0: ['0\n'] }, put: { current: { claim: { index: 7, attempt: 1, argv: ['true'], secrets: [], duplicate: false }, startedAt: Date.now() } } });

    expect(completed.map((outcome) => [outcome.index, outcome.exitCode, outcome.slot])).toEqual([[7, 0, undefined]]);
  });

  test('one slot\'s slow answer does not idle the others: they launch and finish beside it', async () => {
    const { claimed, completed } = await run({ tasks: 6, execs: { [waitOn(slotTask(0))]: 150 } });
    const first = completed.findIndex((outcome) => outcome.slot === 0);

    expect({ completed: completed.length, before: completed.slice(0, first).length, slots: [...new Set(claimed)].sort() }).toEqual({ completed: 6, before: 5, slots: [0, 1, 2] });
  });

  test('a slot that dies fails the vessel once; the others stop', async () => {
    const failing = container(async (argv) => {
      if (argv[3] === 'wait' && slotOf(argv[2] ?? '') === 1) throw new Error('the container is gone');

      return { exitCode: 0, stdout: '' };
    });
    const stored = state(failing);
    let failed = 0;
    const job = {
      booted: async () => undefined, waiting: async () => undefined,
      claim: async () => ({ index: 0, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false }),
      still: async () => true, accept: async () => true, complete: async () => undefined, retired: async () => undefined,
      vesselFailed: async () => { failed += 1; },
    };
    const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: bucket() }));

    await vessel.begin(spec);
    await stored.ctx.storage.put({ state: 'working' });
    await vessel.alarm();

    expect({ state: await stored.ctx.storage.get('state'), failed }).toEqual({ state: 'failed', failed: 1 });
  });
});

describe('a slotted launch', () => {
  test('isolates the slot: a private namespace, the slot task dir bound, fresh tmpfs, overlays, a capped cgroup', () => {
    const script = launchSlot('/home/ci/work', 2, 512, ['/tmp', '/dev/shm']);

    expect({
      namespace: script.includes('unshare --mount --propagation private'),
      point: script.includes('mkdir -p /armada/task\nmount --bind'),
      bind: script.includes(`mount --bind ${slotTask(2)} /armada/task`),
      siblings: script.indexOf('tmpfs /armada/slots') > script.indexOf('home-work'),
      tmpfs: ['/tmp', '/dev/shm'].every((dir) => script.includes(`mount -t tmpfs -o mode=1777,size=6g tmpfs ${dir}`)),
      workdir: script.includes('userxattr,lowerdir=/home/ci/work,upperdir=/armada/slots/2/upper,workdir=/armada/slots/2/work'),
      home: script.includes('userxattr,lowerdir=/home/ci,upperdir=/armada/slots/2/home-upper,workdir=/armada/slots/2/home-work'),
      memory: script.includes('echo 512 > /sys/fs/cgroup/armada/task-2/memory.max'),
      inside: script.indexOf('cd /home/ci/work') > script.indexOf('unshare'),
      user: script.includes('setpriv --reuid=ci'),
      fallback: script.includes('echo 70 > /armada/slots/2/task/exit'),
    }).toEqual({ namespace: true, point: true, bind: true, siblings: true, tmpfs: true, workdir: true, home: true, memory: true, inside: true, user: true, fallback: true });
  });

  test('leaves today\'s launch untouched: no namespace, no slot root, the shared task dir', () => {
    const script = launchTask('/home/ci/work');

    expect([script.includes('unshare'), script.includes('/armada/slots'), script.includes('memory.max'), script.includes('/armada/task')]).toEqual([false, false, false, true]);
  });
});
