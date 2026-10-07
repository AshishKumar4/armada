import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, type Outcome } from '../../src/protocol';
import type { Generation } from '../src/environments';
import { ArmadaJob } from '../src/job';
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

const exited = (index: number, vessel: string): Outcome => ({ index, kind: 'exited', exitCode: 0, seconds: 1, vessel, attempt: 1, tail: '', output: false });

/** `vessel` claims, runs and lands its next task. */
async function finish(open: ArmadaJob, vessel: string): Promise<void> {
  const claim = await open.claim(vessel);

  if (claim === null || !(await open.accept(vessel, claim.index))) throw new Error(`${vessel} got no task`);
  await open.complete(vessel, exited(claim.index, vessel), 1000);
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
  test('runs a function\'s bundle under node with the item as JSON, and a command\'s own argv', async () => {
    const bundle = 'b'.repeat(64);
    const { job: fnJob } = await job({ recipe: {}, items: [{ item: { n: 1 } }], run: { kind: 'fn', bundle } });
    const { job: cmdJob } = await job({ recipe: {}, items: [{ item: 'x', argv: ['echo', 'x'] }], run: { kind: 'command' } });
    const [fnClaim, cmdClaim] = [await fnJob.claim('v1'), await cmdJob.claim('v1')];

    expect([fnClaim?.argv, fnClaim?.env['ARMADA_ITEM'], fnClaim?.env['ARMADA_ATTEMPT'], cmdClaim?.argv, cmdClaim?.env['ARMADA_ITEM']])
      .toEqual([['node', '/armada/bundle.mjs'], '{"n":1}', '1', ['echo', 'x'], '"x"']);
  });
});

describe('a task\'s outcome', () => {
  test('is one per task: an answer that lands after the job cancelled it adds none', async () => {
    const { job: cancelled } = await job({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } });
    const claim = await cancelled.claim('v1');

    await cancelled.accept('v1', claim?.index ?? -1);
    await cancelled.cancel('cancelled by its client', 'cancelled');
    await cancelled.complete('v1', exited(0, 'v1'), 1000);
    const { events } = await cancelled.events(0);

    expect(events.map((event) => [event.outcome.index, event.outcome.kind, event.outcome.reason])).toEqual([[0, 'failed', 'cancelled']]);
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
