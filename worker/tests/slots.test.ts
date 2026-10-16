import { describe, expect, test } from 'bun:test';
import type { Json, Outcome } from '../../src/protocol';
import { clearTask, slotRoot, slotTask, taskGroup, waitOn } from '../src/container';
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

/** Slot or task numbers in ascending order, any a slot never claimed last. */
const ascending = (numbers: readonly (number | undefined)[]) => numbers.toSorted((left, right) => (left ?? Infinity) - (right ?? Infinity));

/** A vessel of `spec.slots` slots, every slot loop running at once: its job hands it `claims`, then generated ones
 *  until `tasks` are given out, then none; each slot's waits answer `ends[slot]` in turn (then exits 0); storage gets
 *  `put` after `begin`. */
async function run({ claims = [], tasks = 0, ends = {}, put, spec: over, still = () => true, execs = {} }: { claims?: readonly (Claim | null)[]; tasks?: number; ends?: Readonly<Record<number, string[]>>; put?: Readonly<Record<string, Json>>; spec?: Partial<VesselSpec>; still?: (index: number) => boolean; execs?: Readonly<Record<string, number>> } = {}) {
  const claimed: (number | undefined)[] = [];
  const completed: Outcome[] = [];
  const launched: { readonly script: string; readonly group: string }[] = [];
  const killed: string[] = [];
  // Each slot cleared and each answer completed, in order, by slot.
  const effects: (readonly ['cleared' | 'completed', number | undefined])[] = [];
  const queue = [...claims];
  // The files piped in, by path: a launch sources its task's argv and environment from one.
  const files = new Map<string, string>();
  let given = 0;

  const stored = state(container(async (argv) => {
    if (argv[3] === 'launch') {
      const file = files.get(/^\. (\S+)/u.exec(argv[2] ?? '')?.[1] ?? '') ?? '';
      // The cgroup the task's own shell sees, read by sourcing its launch file as the launch does.
      const group = Bun.spawnSync(['/bin/sh', '-c', `${file}\nprintf %s "$ARMADA_CGROUP"`]).stdout.toString();

      launched.push({ script: argv[2] ?? '', group });
    }

    if ((argv[2] ?? '').startsWith('set -eu\npid=')) killed.push(argv[2] ?? '');

    if (argv[3] === 'clear') effects.push(['cleared', Array.from({ length: 16 }, (_, slot) => slot).find((slot) => clearTask(taskGroup(slot), slotRoot(slot)) === argv[2])]);

    if (argv[3] !== 'wait') return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    const endsOf = ends[slotOf(argv[2] ?? '')] ?? [];
    const slow = execs[argv[2] ?? ''];

    if (slow !== undefined) await new Promise((resolve) => setTimeout(resolve, slow));

    return { exitCode: 0, stdout: endsOf.shift() ?? '0\n' };
  }, (argv, body) => { if (argv[3] === 'pipe-in') files.set(argv[4] ?? '', body); }));

  const job = {
    booted: async () => undefined,
    moved: async () => true,
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
    stopped: async () => undefined,
    accept: async () => true,
    complete: async (_name: string, outcome: Outcome) => {
      completed.push(outcome);
      effects.push(['completed', outcome.slot]);
    },
    retired: async () => undefined,
    vesselFailed: async () => undefined,
  };

  const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: bucket() }));

  await vessel.begin({ ...spec, ...over });

  if (put !== undefined) await stored.ctx.storage.put({ state: 'working', ...put });

  for (let alarm = 0; alarm < 6; alarm += 1) await vessel.alarm();

  return { claimed, completed, launched, killed, effects };
}

describe('a slotted vessel', () => {
  test('fills every free slot, launches each isolated, and reports the slot each task ran in', async () => {
    const { claimed, completed, launched } = await run({ tasks: 3 });

    expect({
      slots: ascending(claimed),
      own: completed.map((outcome) => outcome.slot === claimed[outcome.index]),
      isolated: launched.every((each) => each.script.includes('unshare --mount')),
      overlay: launched.every((each) => each.script.includes('lowerdir=/home/ci/work')),
      groups: launched.map((each) => each.group).toSorted(),
    }).toEqual({ slots: [0, 1, 2], own: [true, true, true], isolated: true, overlay: true, groups: [taskGroup(0), taskGroup(1), taskGroup(2)].toSorted() });
  });

  test('clears each slot, all its task left running and all it wrote, before its job counts the slot free', async () => {
    const { effects } = await run({ tasks: 6 });

    expect([0, 1, 2].map((slot) => effects.filter(([, at]) => at === slot).map(([what]) => what))).toEqual([0, 1, 2].map(() => ['cleared', 'completed', 'cleared', 'completed']));
  });

  test('a slot the job drops is killed alone: the others run on to their answers', async () => {
    const { claimed, completed, killed } = await run({ tasks: 3, ends: { 0: [''], 1: [''], 2: [''] }, still: (index) => index !== 1 });
    const of = claimed[1];

    expect({ done: ascending(completed.map((outcome) => outcome.index)), kills: killed.length, at: killed.every((argv) => argv.includes(slotTask(of ?? -1))) }).toEqual({ done: [0, 2], kills: 1, at: true });
  });

  test('a task past its bound is killed alone: it ends 124 timeout, the others their answers', async () => {
    const { completed } = await run({
      tasks: 2, ends: { 1: [''] },
      put: { 'slot:1': { claim: { index: 7, attempt: 1, argv: ['true'], secrets: [], duplicate: false }, startedAt: 0 } },
    });

    expect(completed.map((outcome) => [outcome.index, outcome.exitCode, outcome.reason] as const).sort((a, b) => a[0] - b[0])).toEqual([[0, 0, undefined], [1, 0, undefined], [7, 124, 'timeout']]);
  });

  test('one slot\'s slow answer does not idle the others: they launch and finish beside it', async () => {
    const { claimed, completed } = await run({ tasks: 6, execs: { [waitOn(slotTask(0))]: 150 } });
    const first = completed.findIndex((outcome) => outcome.slot === 0);

    expect({ completed: completed.length, before: completed.slice(0, first).length, slots: ascending([...new Set(claimed)]) }).toEqual({ completed: 6, before: 5, slots: [0, 1, 2] });
  });

  test('a slot that dies fails the vessel once; the others stop', async () => {
    const failing = container(async (argv) => {
      if (argv[3] === 'wait' && slotOf(argv[2] ?? '') === 1) throw new Error('the container is gone');

      return { exitCode: 0, stdout: '' };
    });

    const stored = state(failing);
    let failed = 0;

    const job = {
      booted: async () => undefined, moved: async () => true,
      claim: async () => ({ index: 0, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false }),
      still: async () => true, stopped: async () => undefined, accept: async () => true, complete: async () => undefined, retired: async () => undefined,
      vesselFailed: async () => { failed += 1; },
    };

    const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: bucket() }));

    await vessel.begin(spec);
    await stored.ctx.storage.put({ state: 'working' });
    await vessel.alarm();

    expect({ state: await stored.ctx.storage.get('state'), failed }).toEqual({ state: 'failed', failed: 1 });
  });
});
