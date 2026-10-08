import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, refusal, type Outcome } from '../../src/protocol';
import type { Generation } from '../src/environments';
import { ArmadaJob, type Claim } from '../src/job';
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
  index, kind: 'exited', exitCode, seconds: 1, vessel, attempt: 1, tail: '', output: false, ...error === undefined ? {} : { error },
});

/** `vessel` claims, runs and lands its next task, which exits `exitCode`, having thrown `error`. */
async function finish(open: ArmadaJob, vessel: string, exitCode = 0, error?: string): Promise<void> {
  const claim = await open.claim(vessel);

  if (claim === null || 'waitMs' in claim || !(await open.accept(vessel, claim.index))) throw new Error(`${vessel} got no task`);
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

describe('a task\'s claim', () => {
  test('runs a pushed task\'s bundle under node with its id and the item as JSON, and a command\'s own argv', async () => {
    const bundle = 'b'.repeat(64);
    const { job: taskJob } = await job({ recipe: {}, items: [{ item: { n: 1 } }], run: { kind: 'task', id: 'square', bundle } });
    const { job: cmdJob } = await job({ recipe: {}, items: [{ item: 'x', argv: ['echo', 'x'] }], run: { kind: 'command' } });
    const [taskClaim, cmdClaim] = [await taskJob.claim('v1'), await cmdJob.claim('v1')].map((claim) => claim === null || 'waitMs' in claim ? undefined : claim);

    expect([taskClaim?.argv, taskClaim?.env['ARMADA_TASK'], taskClaim?.env['ARMADA_ITEM'], taskClaim?.env['ARMADA_ATTEMPT'], cmdClaim?.argv, cmdClaim?.env['ARMADA_TASK'], cmdClaim?.env['ARMADA_ITEM']])
      .toEqual([['node', '/armada/bundle.mjs'], 'square', '{"n":1}', '1', ['echo', 'x'], undefined, '"x"']);
  });
});

describe('a task\'s outcome', () => {
  test('is one per task: an answer that lands after the job cancelled it adds none', async () => {
    const { job: cancelled } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } });
    const claim = await cancelled.claim('v1');

    await cancelled.accept('v1', claim === null || 'waitMs' in claim ? -1 : claim.index);
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
      tails: ['no vessel was left to run it', 'no vessel was left to run it'],
      vessels: 10,
    });
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

/** `vessel` lands its rank's answer, exiting `exitCode`. */
async function land(open: ArmadaJob, vessel: string, index: number, exitCode: number): Promise<void> {
  if (!(await open.accept(vessel, index))) throw new Error(`${vessel}'s answer was refused`);
  await open.complete(vessel, { ...exited(index, vessel), exitCode, tail: `${vessel} said this` }, 1000);
}

describe('a gang task', () => {
  test('reserves before continuing single arrivals and eventually takes every rank', async () => {
    const { job: open } = await job({ recipe: {}, open: true, pool: 2, timeout: 10, run: { kind: 'command' },
      items: [{ item: { weight: 1 }, argv: ['true'] }, { item: { weight: 1 }, argv: ['true'] }] });
    const first = await open.claim('v1');
    if (first === null || 'waitMs' in first) throw new Error('the initial single never started');
    await open.add([{ item: { gang: 2 }, argv: ['true'] }]);
    await open.add([{ item: { weight: 1000 }, argv: ['true'] }]);
    const held = await open.claim('v2');
    expect(held).toEqual({ waitMs: 1000 });
    expect(await open.accept('v1', first.index)).toBe(true);
    await open.complete('v1', exited(first.index, 'v1'), 1000);
    const ranks = await formed(open, ['v1', 'v2']);
    expect(Object.values(ranks).map((claim) => claim.env['ARMADA_WORLD'])).toEqual(['2', '2']);
  });
  test('is refused unless it is a whole number of containers the pool holds', () => {
    const items = (gang: number) => [{ item: { gang }, argv: ['true'] }];

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

    await land(green, 'v2', 0, 0);
    const early = (await green.events(0)).events.length;

    await land(green, 'v1', 0, 0);
    const { job: red } = await job(gang(2));

    await formed(red, ['v1', 'v2']);
    await land(red, 'v2', 0, 3);
    const outcomes = [...(await green.events(0)).events, ...(await red.events(0)).events].map((event) => [event.outcome.vessel, event.outcome.exitCode, event.outcome.tail]);

    expect({ early, outcomes, stillRank0: await red.still('v1', 0) })
      .toEqual({ early: 0, outcomes: [['v1', 0, 'v1 said this'], ['v2', 3, 'rank 1 of 2:\nv2 said this']], stillRank0: false });
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
