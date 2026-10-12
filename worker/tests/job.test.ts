import { describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { environmentKey, JobSpecSchema, RecipeSchema, refusal, type Outcome } from '../../src/protocol';
import { ArmadaEnvironments, type Generation } from '../src/environments';
import { ArmadaJob, type Claim } from '../src/job';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { listSchedule } from '../../src/dispatch';
import { container, idleVessels, namespace, READY, state, world, type Stored } from './harness';

const generation = READY;

/** A job on a ready environment whose vessels only record that they began, and whose registry records each environment
 *  a job's end says it used. */
async function job(spec: v.InferInput<typeof JobSpecSchema>) {
  const begun: string[] = [];
  const used: string[] = [];
  const stopped: string[] = [];
  const stored = state();

  const created = new ArmadaJob(stored.ctx, world({
    VESSEL: namespace((name: string) => ({ begin: async () => { begun.push(name); }, stop: async () => {
      stopped.push(name);

      return true;
    } })),
    ENVIRONMENTS: namespace(() => ({ used: async (key: string) => { used.push(key); }, ensure: async () => ({ kind: 'ready', generation }) })),
  }));

  await created.create('j1', v.parse(JobSpecSchema, spec));
  await created.alarm();

  return { job: created, begun, used, stopped, stored };
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

describe('a job that ends', () => {
  test('tells the registry it used its environment until then, so the environment\'s recent hour starts at its end', async () => {
    const { job: ending, used } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } });
    const during = [...used];

    await finish(ending, 'v1');

    expect({ during, after: used, key: used[0] === await ending.environment() }).toEqual({ during: [], after: [await ending.environment()], key: true });
  });
});

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

    expect({ refused: await open.add([{ item: 'a' }]) !== null, tasks: (await open.status())?.tasks.total }).toEqual({ refused: true, tasks: 0 });
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

      // Each event says when it landed, a green held for its twin's end as well.
      return { told, events: events.map((event) => [event.outcome.vessel, event.outcome.exitCode, event.at !== undefined]) };
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
      redFirst: { told: false, events: [['v1', 1, true]] },
      redOverALandingGreen: { told: false, events: [['v2', 1, true]] },
      redOverAStoredGreen: { told: false, events: [['v2', 1, true]] },
      greenOnceTheOtherStopped: { told: false, events: [['v1', 0, true]] },
      greenBesideAGreen: { told: false, events: [['v1', 0, true]] },
      greenOnceTheOtherWasLost: { told: false, events: [['v1', 0, true]] },
      firstRedBesideAGreen: { told: false, events: [['v1', 1, true]] },
    });
  });
});

describe('a hedged task\'s copies', () => {
  test('are a vessel each from the start, even for a job of one item', async () => {
    const { begun } = await job({ recipe: {}, items: [{ item: { weight: 9 }, argv: ['true'] }], run: { kind: 'command' }, hedge: 1, pool: 2 });

    expect(begun).toEqual(['j1/v1', 'j1/v2']);
  });

  test('keep the slot each ran in, whichever answers first', async () => {
    const { job: hedged } = await job({ recipe: {}, items: [{ item: { weight: 9 }, argv: ['true'] }, { item: { weight: 1 }, argv: ['true'] }], run: { kind: 'command' }, hedge: 1, slots: 4 });

    await hedged.claim('v1', 0);
    await hedged.claim('v2', 2);
    await hedged.accept('v2', 0, 0, { slot: 2, attempt: 1 });

    expect((await hedged.status())?.running?.filter((each) => each.index === 0).map((each) => [each.vessel, each.slot])).toEqual([['v2', 2]]);
  });

  test('end with the one outcome the job gave a task it cancelled, even when a green was held for the other copy', async () => {
    const { job: hedged } = await job({ recipe: {}, items: [{ item: { weight: 9 }, argv: ['true'] }], run: { kind: 'command' }, hedge: 1 });

    await hedged.claim('v1');
    await hedged.claim('v2');
    await hedged.accept('v1', 0, 0, { slot: 0, attempt: 1 });
    await hedged.complete('v1', exited(0, 'v1'), 1000);
    await hedged.cancel('cancelled by its client', 'cancelled');
    await hedged.stopped('v2', 0, { slot: 0, attempt: 1 });

    expect((await hedged.events(0)).events.map((event) => [event.outcome.kind, event.outcome.reason])).toEqual([['failed', 'cancelled']]);
  });
});

describe('a run the job no longer counts', () => {
  test('is told to stop, though the task it ran is running again elsewhere, or in another slot of its own vessel', async () => {
    const { job: retried } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, slots: 2, retries: { exitCodes: [3], attempts: 3, backoffSeconds: 0 } });

    await retried.claim('v1', 0);
    // The first run's answer names a retry: the task runs again, here in the vessel's other slot.
    await retried.accept('v1', 0, 3, { slot: 0, attempt: 1 });
    await retried.complete('v1', exited(0, 'v1', 3), 1000);
    await retried.claim('v1', 1);

    expect({ stale: await retried.still('v1', 0, 0), current: await retried.still('v1', 0, 1) }).toEqual({ stale: false, current: true });
  });
});

describe('a job an earlier Worker stored', () => {
  test('runs with the fields added since at their defaults', async () => {
    const { job: earlier, begun, stored } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }], run: { kind: 'command' }, open: true });
    const { slots: _slots, hedge: _hedge, ...before } = v.parse(v.looseObject({ slots: v.number(), hedge: v.number() }), await stored.ctx.storage.get('spec'));

    await stored.ctx.storage.put('spec', before);
    await earlier.add([{ item: 'c', argv: ['true'] }]);

    expect(begun).toEqual(['j1/v1', 'j1/v2', 'j1/v3']);
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

describe('a vessel lost before it took a task', () => {
  test('is replaced apart from the losses under a task, as many as the job\'s pool', async () => {
    const { job: booting, begun } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, pool: 12 });
    const replacements = Array.from({ length: 12 }, (_, index) => `r${String(index + 1)}`);

    for (const vessel of ['v1', ...replacements]) await booting.vesselFailed(vessel, 'the first exec exited 137: ');

    expect(begun).toEqual(['j1/v1', ...replacements.map((vessel) => `j1/${vessel}`)]);
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

    expect({ refused: await open.add([{ item: { gang: 4 }, argv: ['true'] }]) !== null, tasks: (await open.status())?.tasks.total }).toEqual({ refused: true, tasks: 0 });
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

describe('a job whose environment\'s snapshot the platform no longer has', () => {
  test('prepares the environment again and starts its vessels from the new snapshot, its task still queued', async () => {
    const recipe = v.parse(RecipeSchema, {});
    const key = await environmentKey(recipe);
    const registry = state();
    let preparations = 0;
    const environments = new ArmadaEnvironments(registry.ctx, world({ PREPARER: namespace(() => ({ begin: async () => { preparations += 1; } })) }));
    const vessels = new Map<string, { readonly vessel: ArmadaVessel; readonly stored: Stored }>();

    // As armada-v2 saw on 2026-10-09: an exec is refused as not started, and the start ends with the snapshot not found.
    const machine = (): Container => {
      let started = '';
      const refusing = container(() => (started === 'gone' ? new Error('The container has not been started') : { exitCode: 0, stdout: 'ready' }));

      Object.assign(refusing, {
        start: (options: ContainerStartupOptions) => { started = options.containerSnapshot?.id ?? ''; },
        monitor: async () => { if (started === 'gone') throw new Error('Snapshot "gone" was not found.'); await Promise.withResolvers<void>().promise; },
      });

      return refusing;
    };

    const env = world({
      ENVIRONMENTS: namespace(() => environments),
      JOB: namespace(() => missing),
      VESSEL: namespace((name) => {
        const held = vessels.get(name) ?? (() => {
          const stored = state(machine());

          return { vessel: new ArmadaVessel(stored.ctx, env), stored };
        })();

        vessels.set(name, held);

        return held.vessel;
      }),
    });

    await registry.ctx.storage.put(`env:${key}`, { state: 'ready', generation: { key, snapshot: { id: 'gone', size: 1 }, sha: null, created: 0, seconds: {} }, lastUsed: 0 });
    const missing = new ArmadaJob(state().ctx, env);

    await missing.create('missing', v.parse(JobSpecSchema, { recipe, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } }));
    await missing.alarm();
    await vessels.get('missing/v1')?.vessel.alarm();
    const lost = await missing.status();

    await environments.prepared({ key, snapshot: { id: 'fresh', size: 1 }, sha: null, created: 1, seconds: {} });
    // A late start from the lost snapshot cannot undo the environment that replaced it.
    await environments.lost(key, 'gone');
    await missing.alarm();
    const snapshots = await Promise.all([...vessels].map(async ([name, { stored }]) => [name, (await stored.ctx.storage.get<VesselSpec>('spec'))?.snapshot]));

    expect({
      preparations, phase: lost?.phase, queued: lost?.tasks.queued, failed: lost?.tasks.failed, vessels: lost?.vessels.map((each) => [each.name, each.state]),
      owed: await registry.ctx.storage.get('debt:gone') !== undefined, snapshots, ready: (await environments.ensure(key, recipe, null)).kind,
    }).toEqual({
      preparations: 1, phase: 'running', queued: 1, failed: 0, vessels: [['v1', 'failed']],
      owed: true, snapshots: [['missing/v1', 'gone'], ['missing/v2', 'fresh']], ready: 'ready',
    });
  });
});

describe('a job whose snapshot is lost while its vessels start', () => {
  const snapshotOf = (id: string): Generation => ({ key: 'k'.repeat(64), snapshot: { id, size: 1 }, sha: null, created: 0, seconds: {} });

  test('refills its pool from the new snapshot for each late start from the old one, spending no replacement', async () => {
    let ready: Generation | undefined = snapshotOf('gone');
    const begun: [string, string][] = [];

    const gang = new ArmadaJob(state().ctx, world({
      VESSEL: namespace((name) => ({ begin: async (spec: VesselSpec) => { begun.push([name.split('/')[1] ?? '', spec.snapshot]); }, stop: async () => undefined })),
      ENVIRONMENTS: namespace(() => ({
        ensure: async () => (ready === undefined ? { kind: 'preparing', since: 0 } : { kind: 'ready', generation: ready }),
        lost: async () => { ready = undefined; },
        used: async () => undefined,
      })),
    }));

    await gang.create('j1', v.parse(JobSpecSchema, { recipe: {}, items: [{ item: { gang: 4 }, argv: ['true'] }], run: { kind: 'command' }, pool: 4 }));
    await gang.alarm();
    await gang.vesselFailed('v1', 'the start ended', { missing: 'gone', gone: true });
    ready = snapshotOf('fresh');
    await gang.alarm();

    for (const late of ['v2', 'v3', 'v4']) await gang.vesselFailed(late, 'the start ended', { missing: 'gone', gone: true });
    const status = await gang.status();

    expect({ begun, alive: status?.vessels.filter((each) => each.state === 'waiting').map((each) => each.name), phase: status?.phase }).toEqual({
      begun: [['v1', 'gone'], ['v2', 'gone'], ['v3', 'gone'], ['v4', 'gone'], ['v5', 'fresh'], ['v6', 'fresh'], ['v7', 'fresh'], ['v8', 'fresh']],
      alive: ['v5', 'v6', 'v7', 'v8'],
      phase: 'running',
    });
  });

  test('asks for no environment once it ended while the registry was told', async () => {
    const told = Promise.withResolvers<undefined>();
    let asked = 0;

    const ending = new ArmadaJob(state().ctx, world({
      VESSEL: idleVessels(),
      ENVIRONMENTS: namespace(() => ({
        ensure: async () => {
          asked += 1;

          return { kind: 'ready', generation: snapshotOf('gone') };
        },
        lost: async () => await told.promise,
        used: async () => undefined,
      })),
    }));

    await ending.create('j1', v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } }));
    await ending.alarm();
    const failing = ending.vesselFailed('v1', 'the start ended', { missing: 'gone', gone: true });

    await ending.cancel('cancelled by its client', 'cancelled');
    told.resolve(undefined);
    await failing;

    expect({ asked, phase: (await ending.status())?.phase }).toEqual({ asked: 1, phase: 'done' });
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
async function formed(open: ArmadaJob, vessels: readonly string[], start = true): Promise<Record<string, Claim>> {
  const held: Record<string, Claim> = {};

  for (let round = 0; round < 3; round += 1) {
    for (const vessel of vessels) {
      const claim = held[vessel] === undefined ? await open.claim(vessel) : null;

      if (claim !== null && !('waitMs' in claim)) held[vessel] = claim;
    }
  }

  if (start) {
    for (const [name, claim] of Object.entries(held)) {
      if (!(await open.started(name, claim.index, claim.attempt))) throw new Error(`${name}'s launch was refused`);
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
  test('a boot loss before joining is replaced before the start bound, and every rank gets the replacement in its rendezvous', async () => {
    const { job: open, begun } = await job({ ...gang(4), gangStartTimeout: 30 });

    expect(await open.claim('v1')).toEqual({ waitMs: 1000 });
    expect(await open.claim('v2')).toEqual({ waitMs: 1000 });
    await open.vesselFailed('v3', 'internal error; reference = boot-loss', { gone: true });
    const ranks = ['v1', 'v2', 'v4', 'r1'];
    const held = await formed(open, ranks);

    expect(begun).toEqual(['j1/v1', 'j1/v2', 'j1/v3', 'j1/v4', 'j1/r1']);
    expect(ranks.map((name) => [held[name]?.gang?.rank, held[name]?.gang?.vessels])).toEqual(ranks.map((_, rank) => [rank, ranks]));
    expect(new Set(Object.values(held).map((claim) => claim.gang?.token)).size).toBe(1);

    for (const name of ranks) await land(open, name, 0, { exitCode: 0 });

    expect(await open.events(0)).toMatchObject({ done: true, events: [{ outcome: { kind: 'exited', exitCode: 0 } }] });
  });

  test('simultaneous first claims and a boot loss do not retire the gang\'s surviving ranks before the replacement joins', async () => {
    const began = Date.now();

    try {
      setSystemTime(began);
      const { job: open } = await job({ ...gang(4), gangStartTimeout: 10 });

      expect(await Promise.all(['v1', 'v2', 'v4'].map(async (name) => await open.claim(name)))).toEqual(Array.from({ length: 3 }, () => ({ waitMs: 1000 })));
      await open.vesselFailed('v3', 'internal error; reference = boot-loss', { gone: true });
      setSystemTime(began + 1000);
      const ranks = ['v1', 'v2', 'v4', 'r1'];
      const held = await formed(open, ranks);

      expect(Object.keys(held).sort()).toEqual([...ranks].sort());
      expect(ranks.map((name) => held[name]?.gang?.vessels)).toEqual(ranks.map(() => ranks));

      for (const name of ranks) await land(open, name, 0, { exitCode: 0 });

      expect((await open.events(0)).done).toBe(true);
      expect((await open.status())?.finishedAt).toBeLessThan(began + 10_000);
    } finally {
      setSystemTime();
    }
  });

  test('a member lost before launch loses the gang whole: it forms anew with the replacement, and the old claims launch and answer nothing', async () => {
    const { job: open, begun } = await job(gang(4));
    const held = await formed(open, ['v1', 'v2', 'v3', 'v4'], false);
    const old = held['v1']?.attempt ?? 0;

    await open.vesselFailed('v3', 'internal error; reference = boot-loss', { gone: true });
    await open.vesselFailed('v3', 'a duplicate failure report', { gone: true });
    const stale = [await open.started('v1', 0, old), await open.still('v1', 0, 0, old)];
    const ranks = ['v1', 'v2', 'v4', 'r1'];
    const again = await formed(open, ranks);

    for (const name of ranks) await land(open, name, 0, { exitCode: 0 });

    expect({ stale, begun, attempt: again['r1']?.attempt === old + 1, events: (await open.events(0)).events.map(({ outcome }) => [outcome.kind, outcome.exitCode]) })
      .toEqual({ stale: [false, false], begun: ['j1/v1', 'j1/v2', 'j1/v3', 'j1/v4', 'j1/r1'], attempt: true, events: [['exited', 0]] });
  });

  test('a forming gang that loses a joined member forms anew rather than waiting on it', async () => {
    const { job: open, begun } = await job(gang(4));

    await open.claim('v1');
    await open.claim('v2');
    await open.vesselFailed('v2', 'container lost before launch', { gone: true });
    const ranks = ['v1', 'v3', 'v4', 'r1'];
    const held = await formed(open, ranks);

    for (const name of ranks) await land(open, name, 0, { exitCode: 0 });

    expect({ begun, ranks: ranks.map((name) => held[name]?.gang?.rank), events: (await open.events(0)).events.map(({ outcome }) => outcome.kind) })
      .toEqual({ begun: ['j1/v1', 'j1/v2', 'j1/v3', 'j1/v4', 'j1/r1'], ranks: [0, 1, 2, 3], events: ['exited'] });
  });

  test('a gang failed by its launch bound refills the pool for the next task without starting an extra replacement', async () => {
    const began = Date.now();

    try {
      const spec = gang(4);
      setSystemTime(began);
      const { job: open, begun } = await job({ ...spec, items: [...spec.items, ...spec.items], gangStartTimeout: 10 });

      await formed(open, ['v1', 'v2', 'v3', 'v4'], false);
      setSystemTime(began + 10_000);
      await open.alarm();
      expect(begun).toEqual(Array.from({ length: 8 }, (_, index) => `j1/v${String(index + 1)}`));
      expect((await open.status())?.vessels.filter((vessel) => vessel.state === 'working' || vessel.state === 'waiting')).toHaveLength(4);

      const names = ['v5', 'v6', 'v7', 'v8'];

      await formed(open, names);

      for (const name of names) await land(open, name, 1, { exitCode: 0 });

      const events = await open.events(0);

      expect(events.done).toBe(true);
      expect(events.events.map(({ outcome }) => [outcome.index, outcome.kind])).toEqual([[0, 'failed'], [1, 'exited']]);
    } finally {
      setSystemTime();
    }
  });

  test('a forming gang waits for a rank busy past its start bound, which counts only once it formed (#35)', async () => {
    const began = Date.now();

    try {
      setSystemTime(began);
      const { job: open } = await job({ recipe: {}, run: { kind: 'command' }, pool: 2, gangStartTimeout: 300, items: [{ item: 'plain', argv: ['true'] }, { item: { gang: 2 }, argv: ['true'] }] });
      const plain = await open.claim('v1');

      // v2 forms the gang and waits on v1, whose plain task runs 6 min, past the bound.
      expect(await open.claim('v2')).toEqual({ waitMs: 1000 });

      for (let minute = 1; minute <= 6; minute += 1) {
        setSystemTime(began + minute * 60_000);
        await open.still('v1', 0);
        await open.claim('v2');
        await open.alarm();
      }

      if (plain === null || 'waitMs' in plain) throw new Error('v1 got no plain task');
      await land(open, 'v1', plain.index, { exitCode: 0 });
      const held = await formed(open, ['v1', 'v2']);

      for (const name of ['v1', 'v2']) await land(open, name, 1, { exitCode: 0 });

      expect({ ranks: [held['v2']?.gang?.rank, held['v1']?.gang?.rank], events: (await open.events(0)).events.map(({ outcome }) => [outcome.index, outcome.kind]) })
        .toEqual({ ranks: [0, 1], events: [[0, 'exited'], [1, 'exited']] });
    } finally {
      setSystemTime();
    }
  });

  test('all claims handed out still have a deadline until every actual launch is acknowledged', async () => {
    const began = Date.now();

    try {
      setSystemTime(began);
      const { job: open, stopped } = await job({ ...gang(4), gangStartTimeout: 10 });

      await formed(open, ['v1', 'v2', 'v3', 'v4'], false);

      for (const name of ['v1', 'v2', 'v3']) expect(await open.started(name, 0, 1)).toBe(true);
      setSystemTime(began + 10_000);
      await open.alarm();

      expect(await open.events(0)).toMatchObject({ done: true, events: [{ outcome: { error: 'GangStartDeadlineExceeded', tail: 'gang start deadline exceeded after 10 s: not every rank launched (pending ranks 3)' } }] });
      expect(stopped).toEqual(['j1/v1', 'j1/v2', 'j1/v3', 'j1/v4']);
      expect(await open.started('v4', 0, 1)).toBe(false);
      expect(await open.accept('v1', 0, 0)).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test('a fully launched gang outlives its start deadline, and stale attempts cannot acknowledge a new launch', async () => {
    const began = Date.now();

    try {
      setSystemTime(began);
      const { job: open, stored } = await job({ ...gang(2), gangStartTimeout: 10 });

      await formed(open, ['v1', 'v2']);
      // As an earlier Worker left it: a launch time it never filled, which says nothing of the ranks' launch (#35).
      stored.ctx.storage.sql.exec('ALTER TABLE members ADD COLUMN started INTEGER');
      setSystemTime(began + 11_000);
      await open.alarm();
      expect((await open.events(0)).events).toHaveLength(0);
      await open.vesselFailed('v2', 'container lost while running', { gone: true });
      await formed(open, ['v1', 'r1'], false);

      expect(await open.started('v1', 0, 1)).toBe(false);
      expect(await open.started('v1', 0, 2)).toBe(true);
      expect(await open.still('v1', 0, 0, 1)).toBe(false);
    } finally {
      setSystemTime();
    }
  });

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

describe('a job deadline', () => {
  test('bounds an unfinished job from its creation, independently of its task timeout', async () => {
    const began = Date.now();

    try {
      setSystemTime(began);
      const { job: open, stopped, stored } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, deadline: 20 });

      await open.claim('v1');
      setSystemTime(began + 19_999);
      await open.alarm();
      expect((await open.events(0)).events).toHaveLength(0);
      expect(await stored.ctx.storage.getAlarm()).toBe(began + 20_000);
      setSystemTime(began + 20_000);
      await open.alarm();

      expect(await open.events(0)).toMatchObject({ done: true, events: [{ outcome: { kind: 'failed', reason: 'lost', tail: 'JobDeadlineExceeded: the job did not finish within 20 s' } }] });
      expect(stopped).toEqual(['j1/v1']);
    } finally {
      setSystemTime();
    }
  });
});
