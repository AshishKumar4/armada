import { describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, refusal, type Outcome } from '../../src/protocol';
import type { Generation } from '../src/environments';
import { ArmadaJob, type Claim } from '../src/job';
import { listSchedule } from '../../src/dispatch';
import { namespace, state, world } from './harness';

const generation: Generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

/** A job on a ready environment whose vessels only record that they began. */
async function job(spec: v.InferInput<typeof JobSpecSchema>) {
  const begun: string[] = [];

  const created = new ArmadaJob(state().ctx, world({
    VESSEL: namespace((name: string) => ({ begin: async () => { begun.push(name); }, stop: async () => undefined })),
    ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }) })),
  }));

  await created.create('j1', v.parse(JobSpecSchema, spec));
  await created.alarm();

  return { job: created, begun };
}

const exited = (index: number, vessel: string, exitCode = 0, error?: string): Outcome => ({
  index, kind: 'exited', exitCode, seconds: 1, vessel, attempt: 1, tail: '', output: false, error,
});

/** `vessel` claims, runs and lands its next task, which exits `exitCode`, having thrown `error`. */
async function finish(open: ArmadaJob, vessel: string, exitCode = 0, error?: string): Promise<void> {
  const claim = await open.claim(vessel);

  if (claim === null || 'waitMs' in claim || !(await open.accept(vessel, claim.index, exitCode))) throw new Error(`${vessel} got no task`);
  await open.complete(vessel, exited(claim.index, vessel, exitCode, error), 1000);
}

describe('an open job', () => {
  test('starts vessels for items as they come beside those still alive, takes none once closed, and settles once closed and drained', async () => {
    const task = { item: 'a', argv: ['true'] };
    const { job: open, begun } = await job({ recipe: {}, items: [], open: true, run: { kind: 'command' } });
    const before = [...begun];

    expect(await open.add([task])).toBeNull();
    await finish(open, 'v1');
    const drained = (await open.status())?.phase;

    await open.add([task, task]);
    await open.close();
    const late = await open.add([task]);

    await finish(open, 'v1');
    await finish(open, 'v2');

    expect({ before, begun, drained, late, done: (await open.status())?.phase }).toEqual({
      before: [], begun: ['j1/v1', 'j1/v2'], drained: 'running', late: 'the job takes no more items', done: 'done',
    });
  });

  test('refuses an item that does not fit its kind', async () => {
    const { job: open } = await job({ recipe: {}, items: [], open: true, run: { kind: 'command' } });

    expect(await open.add([{ item: 'a' }])).toBe('item 0 has no argv for its command');
  });
});

describe('the claim order', () => {
  test('vessels claim as they free, landing the lanes `listSchedule` computes, ties included', async () => {
    // weights order the queue (heaviest first, index on a tie); durations are each task's busyMs.
    const weights = [9, 4, 8, 4, 8, 1, 6, 9, 2];
    const durations = [5, 3, 5, 3, 5, 3, 5, 3, 5];
    const machines = 3;

    const { job: open } = await job({
      recipe: {},
      items: weights.map((weight, index) => ({ item: { name: `t${String(index)}`, weight }, argv: ['true'] })),
      run: { kind: 'command' },
      pool: machines,
    });

    const queue = weights.map((_, index) => index).sort((left, right) => (weights[right] ?? 0) - (weights[left] ?? 0) || left - right);
    const model = listSchedule(queue.map((index) => durations[index] ?? 0), Array.from({ length: machines }, () => 0));
    const loads = Array.from({ length: machines }, () => 0);
    const lanes: number[][] = Array.from({ length: machines }, () => []);

    for (const expected of queue) {
      let least = 0;

      for (let machine = 1; machine < machines; machine += 1) if ((loads[machine] ?? 0) < (loads[least] ?? 0)) least = machine;
      const vessel = `v${String(least + 1)}`;
      const claim = await open.claim(vessel);

      expect(claim === null || 'waitMs' in claim ? -1 : claim.index).toBe(expected);

      if (claim === null || 'waitMs' in claim) throw new Error('unreachable');
      await open.accept(vessel, claim.index, 0);
      await open.complete(vessel, exited(claim.index, vessel), durations[claim.index] ?? 0);
      lanes[least]?.push(claim.index);
      loads[least] = (loads[least] ?? 0) + (durations[claim.index] ?? 0);
    }

    expect(lanes).toEqual(model.lanes.map((lane) => lane.map((position) => queue[position] ?? -1)));
    expect(await open.claim('v1')).toBeNull();
  });
});

describe('a task\'s claim', () => {
  test('runs a pushed task\'s bundle under node with its id and the item as JSON, and a command\'s own argv', async () => {
    const bundle = 'b'.repeat(64);
    const { job: taskJob } = await job({ recipe: {}, items: [{ item: { n: 1 } }], run: { kind: 'task', id: 'square', bundle } });
    const { job: cmdJob } = await job({ recipe: {}, items: [{ item: 'x', argv: ['echo', 'x'] }], run: { kind: 'command' } });
    const [taskClaim, cmdClaim] = [await taskJob.claim('v1'), await cmdJob.claim('v1')].map((claim) => claim === null || 'waitMs' in claim ? undefined : claim);

    expect([taskClaim?.argv, taskClaim?.env['ARMADA_TASK'], taskClaim?.env['ARMADA_ITEM'], taskClaim?.env['ARMADA_ATTEMPT'], cmdClaim?.argv, cmdClaim?.env['ARMADA_TASK'], cmdClaim?.env['ARMADA_ITEM']])
      .toEqual([['node', '/armada/bundle.mjs'], 'square', '{"n":1}', '1', ['echo', 'x'], undefined, '"x"']);
  });

  test('runs a python task\'s bundle with python3 at its own path', async () => {
    const { job: pyJob } = await job({ recipe: {}, items: [{ item: { n: 1 } }], run: { kind: 'task', id: 'square', bundle: 'b'.repeat(64), runtime: 'python' } });
    const claim = await pyJob.claim('v1');

    expect(claim === null || 'waitMs' in claim ? [] : claim.argv).toEqual(['python3', '/armada/bundle.pyz']);
  });
});

describe('a hedged job', () => {
  test('runs its heaviest tasks twice from the start, each copy once the queue reaches its weight, and keeps the first answer', async () => {
    const items = [5, 9, 1, 7].map((weight) => ({ item: { weight }, argv: ['true'] }));
    const { job: hedged } = await job({ recipe: {}, items, run: { kind: 'command' }, hedge: 2 });
    const claims = [];

    for (const vessel of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']) {
      const claim = await hedged.claim(vessel);

      claims.push(claim === null || 'waitMs' in claim ? null : [claim.index, claim.duplicate]);
    }

    // The copy on v2 lands first: its answer is the one kept, and the first copy stops.
    const landed = [await hedged.accept('v2', 1, 0), await hedged.accept('v1', 1, 0)];

    await hedged.complete('v2', exited(1, 'v2'), 1000);
    const { events } = await hedged.events(0);

    expect({ claims, landed, still: await hedged.still('v1', 1), events: events.map((event) => [event.outcome.index, event.outcome.vessel]) })
      .toEqual({ claims: [[1, false], [1, true], [3, false], [3, true], [0, false], [2, false], null], landed: [true, false], still: false, events: [[1, 'v2']] });
  });

  test('keeps the first copy\'s verdict, and a red from either copy that ran to its end, never hiding it behind a green', async () => {
    /** v1's copy answers `first` and, where `stored`, lands it; then v2's copy answers `then`, stops when told to, or
     *  loses its container. */
    const verdict = async (first: number, stored: boolean, then: number | 'stopped' | 'lost') => {
      const { job: hedged } = await job({ recipe: {}, items: [{ item: { weight: 9 }, argv: ['true'] }], run: { kind: 'command' }, hedge: 1 });

      await hedged.claim('v1');
      await hedged.claim('v2');
      await hedged.accept('v1', 0, first);

      if (stored) await hedged.complete('v1', exited(0, 'v1', first), 1000);
      const told = await hedged.still('v2', 0);

      if (then === 'stopped') await hedged.stopped('v2', 0);
      else if (then === 'lost') await hedged.vesselFailed('v2', 'the container stopped');
      else if (await hedged.accept('v2', 0, then)) await hedged.complete('v2', exited(0, 'v2', then), 1000);

      if (!stored) await hedged.complete('v1', exited(0, 'v1', first), 1000);
      const { events } = await hedged.events(0);

      return { told, events: events.map((event) => [event.outcome.vessel, event.outcome.exitCode]) };
    };

    expect({
      redFirst: await verdict(1, true, 'stopped'),
      redOverALandingGreen: await verdict(0, false, 1),
      redOverAStoredGreen: await verdict(0, true, 1),
      greenOnceTheOtherStopped: await verdict(0, true, 'stopped'),
      greenBesideAGreen: await verdict(0, true, 0),
      greenOnceTheOtherWasLost: await verdict(0, true, 'lost'),
      firstRedBesideAGreen: await verdict(1, true, 0),
    }).toEqual({
      redFirst: { told: false, events: [['v1', 1]] },
      redOverALandingGreen: { told: false, events: [['v2', 1]] },
      redOverAStoredGreen: { told: false, events: [['v2', 1]] },
      greenOnceTheOtherStopped: { told: false, events: [['v1', 0]] },
      greenBesideAGreen: { told: false, events: [['v1', 0]] },
      greenOnceTheOtherWasLost: { told: false, events: [['v1', 0]] },
      firstRedBesideAGreen: { told: false, events: [['v1', 1]] },
    });
  });
});

describe('a speculative job\'s idle vessel', () => {
  test('stays for a task about to become a straggler, one vessel a task, and repeats it once it is one', async () => {
    const start = new Date('2026-10-08T12:00:00Z').getTime();

    setSystemTime(new Date(start));

    try {
      const items = [{ item: { weight: 40 }, argv: ['true'] }, { item: { weight: 1 }, argv: ['true'] }];
      const { job: speculative } = await job({ recipe: {}, items, run: { kind: 'command' }, speculative: true });

      await speculative.claim('v1');
      await finish(speculative, 'v2');
      // Task 0 becomes a straggler at 1.5 times its 40 s weight, 60 s in: v2 stays for it, and v3 has none to stay for.
      setSystemTime(new Date(start + 20_000));
      const early = [await speculative.claim('v2'), await speculative.claim('v3')];

      setSystemTime(new Date(start + 61_000));
      const repeated = await speculative.claim('v2');

      expect({ early, repeated: repeated === null || 'waitMs' in repeated ? repeated : [repeated.index, repeated.duplicate] })
        .toEqual({ early: [{ waitMs: 40_000 }, null], repeated: [0, true] });
    } finally {
      setSystemTime();
    }
  });
});

describe('a task\'s outcome', () => {
  test('is one per task: an answer that lands after the job cancelled it adds none', async () => {
    const { job: cancelled } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } });
    const claim = await cancelled.claim('v1');

    await cancelled.accept('v1', claim === null || 'waitMs' in claim ? -1 : claim.index, 0);
    await cancelled.cancel('cancelled by its client', 'cancelled');
    await cancelled.complete('v1', exited(0, 'v1'), 1000);
    const { events } = await cancelled.events(0);

    expect(events.map((event) => [event.outcome.index, event.outcome.kind, event.outcome.reason])).toEqual([[0, 'failed', 'cancelled']]);
  });
});

describe('a task whose container stopped under it', () => {
  test('is queued again for a live vessel twice, and reported lost the third time', async () => {
    const { job: lossy } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } });
    const lost: (number | null)[] = [];

    for (const vessel of ['v1', 'r1', 'r2']) {
      const claim = await lossy.claim(vessel);

      lost.push(claim === null || 'waitMs' in claim ? null : claim.index);
      await lossy.vesselFailed(vessel, 'the wait failed to run: exec() cannot be called on a container that is not running.');
    }

    const { events } = await lossy.events(0);

    expect({ lost, events: events.map((event) => [event.outcome.index, event.outcome.kind, event.outcome.reason, event.outcome.attempt]) })
      .toEqual({ lost: [0, 0, 0], events: [[0, 'failed', 'lost', 3]] });
  });
});

describe('a vessel that found no task', () => {
  test('no longer counts toward the pool, so an item an open job takes before the vessel retires gets a vessel', async () => {
    const task = { item: 'a', argv: ['true'] };
    const { job: open, begun } = await job({ recipe: {}, items: [], open: true, run: { kind: 'command' }, pool: 1 });

    await open.add([task]);
    await finish(open, 'v1');
    const idle = await open.claim('v1');

    await open.add([task]);

    expect({ idle, begun }).toEqual({ idle: null, begun: ['j1/v1', 'j1/v2'] });
  });
});

describe('a slotted job', () => {
  test('starts a container for each full share of lanes its tasks fill, not one per task', async () => {
    const items = Array.from({ length: 8 }, () => ({ item: 'a', argv: ['true'] }));
    const { begun } = await job({ recipe: {}, items, run: { kind: 'command' }, pool: 8, slots: 4 });

    expect(begun).toEqual(['j1/v1', 'j1/v2']);
  });

  test('gives one vessel a claim for each of its slots, and says the slot a running task is in', async () => {
    const items = Array.from({ length: 3 }, () => ({ item: 'a', argv: ['true'] }));
    const { job: slotted } = await job({ recipe: {}, items, run: { kind: 'command' }, pool: 8, slots: 4 });
    const claims = await Promise.all([slotted.claim('v1', 0), slotted.claim('v1', 1), slotted.claim('v1', 2)]);
    const status = await slotted.status();

    expect({ indexes: claims.map((claim) => claim === null || 'waitMs' in claim ? -1 : claim.index), running: status?.running }).toEqual({
      indexes: [0, 1, 2],
      running: [{ index: 0, vessel: 'v1', started: status?.running?.[0]?.started ?? 0, slot: 0 }, { index: 1, vessel: 'v1', started: status?.running?.[1]?.started ?? 0, slot: 1 }, { index: 2, vessel: 'v1', started: status?.running?.[2]?.started ?? 0, slot: 2 }],
    });
  });

  test('keeps a vessel whose slots are busy counted alive while the queue is empty, so it grows no more', async () => {
    const task = { item: 'a', argv: ['true'] };
    const { job: open, begun } = await job({ recipe: {}, items: [], open: true, run: { kind: 'command' }, pool: 1, slots: 2 });

    await open.add([task, task]);
    await open.claim('v1', 0);
    await open.claim('v1', 1);
    const idle = await open.claim('v1', 0);
    await open.add([task]);

    expect({ idle, begun }).toEqual({ idle: null, begun: ['j1/v1'] });
  });

  test('requeues every one of a lost vessel\'s tasks, not just one', async () => {
    const items = Array.from({ length: 3 }, () => ({ item: 'a', argv: ['true'] }));
    const { job: slotted } = await job({ recipe: {}, items, run: { kind: 'command' }, pool: 8, slots: 3 });
    const claims = await Promise.all([slotted.claim('v1', 0), slotted.claim('v1', 1), slotted.claim('v1', 2)]);

    await slotted.vesselFailed('v1', 'the container ended');
    const again = await Promise.all([slotted.claim('v2', 0), slotted.claim('v2', 1), slotted.claim('v2', 2)]);

    expect([claims, again].map((each) => each.map((claim) => claim === null || 'waitMs' in claim ? -1 : claim.index))).toEqual([[0, 1, 2], [0, 1, 2]]);
  });

  test('a failed vessel\'s late claim takes nothing and stays failed', async () => {
    const { job: slotted } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }], run: { kind: 'command' }, pool: 8, slots: 3 });

    await slotted.claim('v1', 0);
    await slotted.vesselFailed('v1', 'the container ended');

    expect(await slotted.claim('v1', 1)).toBeNull();
    const status = await slotted.status();

    expect({ vessel: status?.vessels?.find((each) => each.name === 'v1')?.state, queued: status?.tasks.queued }).toEqual({ vessel: 'failed', queued: 2 });
    const again = await slotted.claim('v2', 0);

    expect(again === null || 'waitMs' in again ? null : again.index).toBe(0);
  });

  test('refuses a gang: a gang takes a whole container, which a slotted job\'s containers cannot give it', async () => {
    const { job: open } = await job({ recipe: {}, items: [], open: true, run: { kind: 'command' }, slots: 2 });

    expect(await open.add([{ item: { gang: 4 }, argv: ['true'] }])).toBe('item 0\'s gang takes a whole container to itself: a slotted job\'s containers share each slot\'s view, so a gang runs only with 1 slot');
  });
});

describe('a job none of whose containers starts', () => {
  test('says so once, naming its environment and why, however many vessels failed', async () => {
    const { job: broken, begun } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }], run: { kind: 'command' }, pool: 2 });

    const failing = async () => {
      for (let round = 0; round < 20; round += 1) {
        const alive = begun.filter((name) => !failed.includes(name));

        if (alive.length === 0) return;

        for (const name of alive) {
          failed.push(name);
          await broken.vesselFailed(name.split('/')[1] ?? '', 'the container did not start: snapshot snapshot is not runnable');
        }
      }
    };

    const failed: string[] = [];

    await failing();
    const status = await broken.status();
    const { events } = await broken.events(0);

    expect({ phase: status?.phase, problems: status?.problems, tails: events.map((event) => event.outcome.tail), vessels: failed.length }).toEqual({
      phase: 'done',
      problems: [`no container started from environment ${(status?.key ?? '').slice(0, 12)}: the container did not start: snapshot snapshot is not runnable`],
      tails: [
        'no vessel was left to run it\nthe container did not start: snapshot snapshot is not runnable',
        'no vessel was left to run it\nthe container did not start: snapshot snapshot is not runnable',
      ],
      vessels: 10,
    });
  });

  test('a lost task\'s tail keeps the last three distinct reasons its vessels failed with', async () => {
    const { job: broken, begun } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, pool: 1 });
    const reasons = ['the first way it failed', 'the second way', 'the third way', 'the fourth way', 'the fourth way'];

    for (let round = 0; round < 20; round += 1) {
      const alive = begun.filter((name) => !name.endsWith('-failed'));

      if (alive.length === 0) break;

      for (const name of alive) {
        begun.splice(begun.indexOf(name), 1, `${name}-failed`);
        await broken.vesselFailed(name.split('/')[1] ?? '', reasons.shift() ?? 'the last way');
      }
    }

    const { events } = await broken.events(0);

    expect(events.map((event) => event.outcome.tail)).toEqual(['no vessel was left to run it\nthe last way\nthe fourth way\nthe third way']);
  });
});

describe('a task that failed by itself', () => {
  test('runs again on an exit code or a thrown error its job names, after a doubling backoff, up to its attempts', async () => {
    const task = { item: 'a', argv: ['true'] };
    const retries = { attempts: 3, backoffSeconds: 0, exitCodes: [75], errors: ['FetchError'] };
    const { job: retried } = await job({ recipe: {}, items: [task, task, task], run: { kind: 'command' }, retries });

    // Item 0 fails three named ways and is out of attempts; item 1 fails unnamed; item 2 throws a named error, then passes.
    for (const [exitCode, error] of [[75], [1, 'FetchError'], [75], [2], [1, 'FetchError'], [0]] as const) await finish(retried, 'v1', exitCode, error);
    const { events } = await retried.events(0);

    expect(events.map((event) => [event.outcome.index, event.outcome.exitCode])).toEqual([[0, 75], [1, 2], [2, 0]]);
  });

  test('that waits out its backoff tells a vessel how long to wait, a minute at most', async () => {
    const { job: waiting } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, retries: { attempts: 2, backoffSeconds: 300, exitCodes: [1] } });

    await finish(waiting, 'v1', 1);

    expect(await waiting.claim('v1')).toEqual({ waitMs: 60_000 });
  });
});

const gang = (size: number) => ({ recipe: {}, items: [{ item: { gang: size }, argv: ['true'] }], run: { kind: 'command' as const }, pool: 4 });

/** `vessels` ask in turn until each holds its rank of the gang: their claims, by vessel. */
async function formed(open: ArmadaJob, vessels: readonly string[]): Promise<Record<string, Claim>> {
  const held: Record<string, Claim> = {};

  for (let round = 0; round < 3; round += 1) {
    for (const vessel of vessels) {
      const claim = held[vessel] === undefined ? await open.claim(vessel) : null;

      if (claim !== null && !('waitMs' in claim)) held[vessel] = claim;
    }
  }

  return held;
}

/** `vessel` lands its rank's answer, with `landed`'s exit code and the rest on its outcome. */
async function land(open: ArmadaJob, vessel: string, index: number, landed: Partial<Outcome> & { readonly exitCode: number }): Promise<void> {
  if (!(await open.accept(vessel, index, landed.exitCode))) throw new Error(`${vessel}'s answer was refused`);
  await open.complete(vessel, { ...exited(index, vessel), tail: `${vessel} said this`, ...landed }, 1000);
}

describe('a gang task', () => {
  test('is refused unless it is a whole number of containers the pool holds', () => {
    const items = (size: number) => [{ item: { gang: size }, argv: ['true'] }];

    expect([refusal({ kind: 'command' }, items(2), 2), refusal({ kind: 'command' }, items(3), 2), refusal({ kind: 'command' }, items(1.5), 4)])
      .toEqual([null, 'item 0\'s gang is a whole number of containers from 1 to 2, the job\'s pool', 'item 0\'s gang is a whole number of containers from 1 to 4, the job\'s pool']);
  });

  test('starts a vessel per rank, keeps the first waiting until every rank joined, and gives each its rank, the gang and one token', async () => {
    const { job: open, begun } = await job(gang(2));
    const first = await open.claim('v1');
    const held = await formed(open, ['v1', 'v2']);
    const ranks = ['v1', 'v2'].map((vessel) => [held[vessel]?.env['ARMADA_RANK'], held[vessel]?.env['ARMADA_WORLD'], held[vessel]?.gang?.vessels, held[vessel]?.gang?.rank]);

    expect({ begun, first, ranks, tokens: new Set(Object.values(held).map((claim) => claim.gang?.token)).size, length: held['v1']?.gang?.token.length })
      .toEqual({ begun: ['j1/v1', 'j1/v2'], first: { waitMs: 1000 }, ranks: [['0', '2', ['v1', 'v2'], 0], ['1', '2', ['v1', 'v2'], 1]], tokens: 1, length: 48 });
  });

  test('lands rank 0\'s outcome once every rank exited 0, and the first failing rank\'s at once, stopping the others', async () => {
    const { job: green } = await job(gang(2));
    await formed(green, ['v1', 'v2']);

    await land(green, 'v2', 0, { exitCode: 0 });
    const early = (await green.events(0)).events.length;

    await land(green, 'v1', 0, { exitCode: 0, artifacts: true });
    const { job: red } = await job(gang(2));

    await formed(red, ['v1', 'v2']);
    await land(red, 'v2', 0, { exitCode: 3, artifacts: true });
    const outcomes = [...(await green.events(0)).events, ...(await red.events(0)).events].map((event) => [event.outcome.vessel, event.outcome.exitCode, event.outcome.tail, event.outcome.artifacts ?? false]);

    expect({ early, outcomes, stillRank0: await red.still('v1', 0) })
      .toEqual({ early: 0, outcomes: [['v1', 0, 'v1 said this', true], ['v2', 3, 'rank 1 of 2:\nv2 said this', false]], stillRank0: false });
  });

  test('is lost whole with any rank: the others stop, and it forms again from the vessels left and a replacement', async () => {
    const { job: lossy, begun } = await job(gang(2));

    await formed(lossy, ['v1', 'v2']);
    await lossy.vesselFailed('v2', 'the wait failed to run: Network connection lost.');
    const stopped = await lossy.still('v1', 0);
    const again = await formed(lossy, ['v1', 'r1']);

    expect({ stopped, begun, again: ['v1', 'r1'].map((vessel) => [again[vessel]?.gang?.rank, again[vessel]?.attempt]), events: (await lossy.events(0)).events })
      .toEqual({ stopped: false, begun: ['j1/v1', 'j1/v2', 'j1/r1'], again: [[0, 2], [1, 2]], events: [] });
  });
});
