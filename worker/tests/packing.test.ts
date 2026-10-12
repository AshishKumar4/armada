import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { environmentKey, JobSpecSchema, RecipeSchema, type Json, type Outcome } from '../../src/protocol';
import { ArmadaEstimates, itemKey, MIN_SAMPLES, type Usage } from '../src/estimates';
import { ArmadaJob, type Claim } from '../src/job';
import { namespace, READY, runOf, state, world } from './harness';

const GIB = 2 ** 30;

/** Half a core and 2 GiB: four fit a medium container's 4 vCPUs and 85% of its 11.5 GiB. */
const SMALL: Usage = { cores: 0.5, memory: 2 * GIB, disk: 1e6 };

/** Each item's command: one class, `sim work`, whatever the item. */
const argvOf = (item: Json) => ['sim', 'work', JSON.stringify(item)];

/** The class every task of these jobs is: `sim work` on a medium recipe's environment. */
const CLASS = `command ${JSON.stringify(['sim', 'work'])} ${await environmentKey(v.parse(RecipeSchema, { size: 'medium' }))}`;

/** The classes' stores, as a job reaches them, and each class's real object. */
interface Stores {
  readonly space: DurableObjectNamespace;
  readonly store: (name: string) => ArmadaEstimates | undefined;
}

/** The classes' stores, real objects, kept by class; `answers` decides whether a read is answered, and each of `held`
 *  holds the next answered read in flight until it returns. */
function stores(answers: () => boolean = () => true, held: (() => Promise<void>)[] = []): Stores {
  const kept = new Map<string, ArmadaEstimates>();
  const of = (name: string) => kept.get(name) ?? kept.set(name, new ArmadaEstimates(state().ctx, world({}))).get(name);

  const space = namespace((name: string) => {
    const store = of(name);

    return {
      read: async (items: readonly string[]) => {
        if (!answers()) throw new Error('the store is not answering');
        const answer = await store?.read(items);

        await held.shift()?.();

        return answer;
      },
      record: async (...args: Parameters<ArmadaEstimates['record']>) => await store?.record(...args),
    };
  });

  return { space, store: (name: string) => of(name) };
}

/** A class store that has learned `sample`, MIN_SAMPLES times. */
async function learned(sample: Usage, answers?: () => boolean): Promise<Stores> {
  const made = stores(answers);

  await made.store(CLASS)?.record(Array.from({ length: MIN_SAMPLES }, (_, at) => ({ ...sample, run: `earlier/${String(at)}/1/v1`, item: `earlier-${String(at)}` })));

  return made;
}

/** A job of `items` on a ready medium environment, its classes' stores `estimates`: the job, and the vessels it began. */
async function packing(items: readonly Json[], estimates: Stores, more: Partial<v.InferInput<typeof JobSpecSchema>> = {}) {
  const begun: string[] = [];
  const stored = state();

  const created = new ArmadaJob(stored.ctx, world({
    VESSEL: namespace((name: string) => ({ begin: async () => { begun.push(name.slice('j1/'.length)); }, stop: async () => true })),
    ENVIRONMENTS: namespace(() => ({ used: async () => undefined, ensure: async () => ({ kind: 'ready', generation: READY }) })),
    ESTIMATES: estimates.space,
  }));

  await created.create('j1', v.parse(JobSpecSchema, { recipe: { size: 'medium' }, items: items.map((item) => ({ item, argv: argvOf(item) })), run: { kind: 'command' }, pool: 4, ...more }));
  await created.alarm();

  return { job: created, begun, stored };
}

/** What `vessel`'s next `count` slots are handed: each task's index, or null. */
async function slotsOf(open: ArmadaJob, vessel: string, count = 5, from = 0): Promise<(number | null)[]> {
  const handed: (number | null)[] = [];

  for (let slot = from; slot < from + count; slot += 1) {
    const claim = await open.claim(vessel, slot);

    handed.push(claim === null || 'waitMs' in claim ? null : claim.index);
  }

  return handed;
}

const ran = (index: number, vessel: string, exitCode: number, more: Partial<Outcome> = {}): Outcome => ({
  index, kind: 'exited', exitCode, seconds: 10, vessel, attempt: 1, tail: '', output: false, cpuSeconds: 5, peakMemory: 2 * GIB, diskBytes: 1e6, ...more,
});

/** `vessel` lands its run of a task with `outcome`. */
async function land(open: ArmadaJob, vessel: string, outcome: Outcome): Promise<void> {
  if (!(await open.accept(vessel, outcome.index, outcome.exitCode, await runOf(open, vessel, outcome.index)))) throw new Error(`${vessel} could not land task ${String(outcome.index)}`);
  await open.complete(vessel, outcome, 1000);
}

/** Item `item`'s record in its class's store: whether it runs alone, or null for none. */
async function aloneIn(made: Stores, item: Json): Promise<boolean | null> {
  const key = await itemKey({ item, argv: argvOf(item) });

  return (await made.store(CLASS)?.read([key]))?.items[key]?.alone ?? null;
}

/** `vessel`'s claim of a task, which must be one. */
async function claimed(open: ArmadaJob, vessel: string, slot = 0): Promise<Claim> {
  const claim = await open.claim(vessel, slot);

  if (claim === null || 'waitMs' in claim) throw new Error(`${vessel} got no task`);

  return claim;
}

describe('an efficient job', () => {
  test('packs tasks into a container as their estimates fit, within its pool of runs, asking only for the containers they fill', async () => {
    const four = await packing(['a', 'b', 'c', 'd'], await learned(SMALL));
    const capped = await packing(['a', 'b', 'c', 'd'], await learned(SMALL), { pool: 2 });

    expect({ four: [four.begun, await slotsOf(four.job, 'v1')], capped: [capped.begun, await slotsOf(capped.job, 'v1')] })
      .toEqual({ four: [['v1'], [0, 1, 2, 3, null]], capped: [['v1'], [0, 1, null, null, null]] });
  });

  test('runs each task alone, a container each, until its class is measured, and in fast mode', async () => {
    const unmeasured = await packing(['a', 'b', 'c'], stores());
    const fast = await packing(['a', 'b', 'c'], await learned(SMALL), { mode: 'fast' });

    expect({ unmeasured: [unmeasured.begun, await slotsOf(unmeasured.job, 'v1', 2)], fast: fast.begun })
      .toEqual({ unmeasured: [['v1', 'v2', 'v3'], [0, null]], fast: ['v1', 'v2', 'v3'] });
  });

  test('asks for the widest gang\'s containers beside packed tasks that fill one, and the gang forms on them', async () => {
    const items: Json[] = [{ weight: 9, n: 0 }, { weight: 9, n: 1 }, { weight: 9, n: 2 }, { weight: 9, n: 3 }, { gang: 2 }];
    const { job, begun } = await packing(items, await learned(SMALL));
    const packed = await slotsOf(job, 'v1', 4);
    // The four runs fill the pool: the gang waits for them.
    const full = await job.claim('v2');

    for (const index of [0, 1, 2, 3]) await land(job, 'v1', ran(index, 'v1', 0));

    const forming = await job.claim('v2');
    const rank = await claimed(job, 'v1');
    const lead = await claimed(job, 'v2');

    expect({ begun, packed, full, forming, ranks: [lead.gang?.rank, rank.gang?.rank] })
      .toEqual({ begun: ['v1', 'v2'], packed: [0, 1, 2, 3], full: { waitMs: 1000 }, forming: { waitMs: 1000 }, ranks: [0, 1] });
  });

  test('runs its tasks whole while their class\'s store does not answer, and packs them once it does', async () => {
    let answering = false;
    const { job, begun } = await packing(['a', 'b', 'c'], await learned(SMALL, () => answering));
    const meanwhile = await slotsOf(job, 'v1', 2);

    answering = true;
    await job.alarm();

    expect({ begun, meanwhile, after: await slotsOf(job, 'v1', 2, 2) }).toEqual({ begun: ['v1', 'v2', 'v3'], meanwhile: [0, null], after: [1, 2] });
  });

  test('delivers each run\'s use once, though two sends carry it at once', async () => {
    const made = stores();

    // Six samples of 1 GiB: one more makes seven, below MIN_SAMPLES; the same one twice would make eight.
    await made.store(CLASS)?.record(Array.from({ length: MIN_SAMPLES - 2 }, (_, at) => ({ ...SMALL, memory: GIB, run: `earlier/${String(at)}/1/v1`, item: `e${String(at)}` })));
    const { job } = await packing(['a'], made);

    await claimed(job, 'v1');
    await land(job, 'v1', ran(0, 'v1', 0, { peakMemory: 4 * GIB }));
    await Promise.all([job.alarm(), job.alarm()]);

    expect((await made.store(CLASS)?.read([]))?.estimate.usage).toBeNull();
  });

  test('runs a task again alone, before its own retries, when it failed beside others, says how, and keeps its item alone', async () => {
    const made = await learned(SMALL);
    const { job, begun } = await packing(['a', 'b'], made, { retries: { exitCodes: [1], attempts: 3 } });

    await slotsOf(job, 'v1', 2);
    await land(job, 'v1', ran(0, 'v1', 1));
    // Alone, it takes a container whole: the busy one has no room for it, so the job asks for another.
    const besideB = await job.claim('v1', 2);

    await job.alarm();
    const alone = await claimed(job, 'v2');

    await land(job, 'v2', ran(0, 'v2', 0, { attempt: alone.attempt }));
    await land(job, 'v1', ran(1, 'v1', 0));
    await job.alarm();
    const { events } = await job.events(0);

    expect({ besideB, begun, landed: events.map(({ outcome }) => [outcome.index, outcome.exitCode, outcome.aloneAfter ?? null]), alone: [await aloneIn(made, 'a'), await aloneIn(made, 'b')] })
      .toEqual({ besideB: null, begun: ['v1', 'v2'], landed: [[0, 0, 'exit 1'], [1, 0, null]], alone: [true, false] });
  });

  test('runs a task killed for memory beside others again alone, and leaves its item to its own record', async () => {
    const made = await learned(SMALL);
    const { job } = await packing(['a', 'b'], made);

    await slotsOf(job, 'v1', 2);
    await land(job, 'v1', ran(0, 'v1', 137, { oomKilled: true, peakMemory: 11 * GIB }));
    await job.alarm();
    const alone = await claimed(job, 'v2');

    await land(job, 'v2', ran(0, 'v2', 0, { attempt: alone.attempt }));
    await land(job, 'v1', ran(1, 'v1', 0));
    await job.alarm();
    const { events } = await job.events(0);

    expect({ landed: events.map(({ outcome }) => [outcome.index, outcome.aloneAfter ?? null]), alone: await aloneIn(made, 'a') })
      .toEqual({ landed: [[0, 'killed for memory'], [1, null]], alone: false });
  });

  test('a hedged copy takes its container whole, and its red stays the task\'s', async () => {
    const { job } = await packing([{ weight: 9 }, { weight: 1 }], await learned(SMALL), { hedge: 1 });

    await slotsOf(job, 'v1', 2);
    // The queue is empty: the heaviest task's copy goes to an empty vessel, and nothing joins it.
    const copy = await claimed(job, 'v2');
    const beside = await job.claim('v2', 1);

    await land(job, 'v2', ran(0, 'v2', 1));
    // The copy's red is the task's: the first copy's later green is refused, and nothing runs it again.
    const late = await job.accept('v1', 0, 0);

    await land(job, 'v1', ran(1, 'v1', 0));

    expect({ copy: [copy.index, copy.duplicate], beside, late, landed: (await job.events(0)).events.map(({ outcome }) => [outcome.index, outcome.exitCode, outcome.aloneAfter ?? null]) })
      .toEqual({ copy: [0, true], beside: null, late: false, landed: [[0, 1, null], [1, 0, null]] });
  });

  test('a run lost with its container starts its next run alone and unmarked, so its red is its own', async () => {
    const { job } = await packing(['a', 'b'], await learned(SMALL));

    await slotsOf(job, 'v1', 2);
    await land(job, 'v1', ran(1, 'v1', 0));
    await job.vesselFailed('v1', 'container lost', { gone: true });
    const again = await claimed(job, 'v2');

    await land(job, 'v2', ran(0, 'v2', 1, { attempt: again.attempt }));

    expect((await job.events(0)).events.map(({ outcome }) => [outcome.index, outcome.exitCode, outcome.aloneAfter ?? null])).toEqual([[1, 0, null], [0, 1, null]]);
  });
  test('holds its pool of runs at once whatever holds them: a hedged copy waits for a run to end, as a packed one does', async () => {
    const { job, begun } = await packing([{ weight: 9 }, { weight: 1 }, { weight: 1 }], await learned(SMALL), { pool: 2, hedge: 1 });
    const packed = await slotsOf(job, 'v1', 3);
    const copy = await job.claim('v2');

    await land(job, 'v1', ran(1, 'v1', 0));

    expect({ begun, packed, copy, after: (await claimed(job, 'v2')).index }).toEqual({ begun: ['v1', 'v2'], packed: [0, 1, null], copy: { waitMs: 1000 }, after: 0 });
  });

  test('keeps the red of a copied task\'s packed run, though its copy alone was green first', async () => {
    const { job } = await packing([{ weight: 9 }, { weight: 1 }], await learned(SMALL), { hedge: 1 });

    await slotsOf(job, 'v1', 2);
    const copy = await claimed(job, 'v2');

    await land(job, 'v2', ran(0, 'v2', 0, { attempt: copy.attempt }));
    await land(job, 'v1', ran(0, 'v1', 1));
    await land(job, 'v1', ran(1, 'v1', 0));

    expect((await job.events(0)).events.map(({ outcome }) => [outcome.index, outcome.exitCode, outcome.aloneAfter ?? null])).toEqual([[0, 1, null], [1, 0, null]]);
  });

  test('a run whose process exited before another joined its container ran beside nothing, so its red is its own', async () => {
    const { job } = await packing(['a', 'b'], await learned(SMALL));

    await claimed(job, 'v1');
    expect(await job.accept('v1', 0, 1)).toBe(true);
    // Task a is landing, its process gone, when b joins.
    const joined = await claimed(job, 'v1', 1);

    await job.complete('v1', ran(0, 'v1', 1), 1000);
    await land(job, 'v1', ran(1, 'v1', 0));

    expect({ joined: joined.index, landed: (await job.events(0)).events.map(({ outcome }) => [outcome.index, outcome.exitCode, outcome.aloneAfter ?? null]) })
      .toEqual({ joined: 1, landed: [[0, 1, null], [1, 0, null]] });
  });

  test('learns only from the run whose answer lands, so nothing is left to deliver after the job ended', async () => {
    const made = await learned(SMALL);
    const { job, stored } = await packing([{ weight: 9 }], made, { hedge: 1 });
    const copy = await claimed(job, 'v2');

    await claimed(job, 'v1');
    // v1's green is uploading when v2's red lands and ends the job.
    expect(await job.accept('v1', 0, 0)).toBe(true);
    await land(job, 'v2', ran(0, 'v2', 1, { attempt: copy.attempt }));
    await job.complete('v1', ran(0, 'v1', 0), 1000);

    expect({ done: (await job.events(0)).done, undelivered: stored.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').one()['n'], alarm: await stored.ctx.storage.getAlarm() })
      .toEqual({ done: true, undelivered: 0, alarm: null });
  });

  test('starts no vessel past its replacements, however often it grows', async () => {
    const { job, begun } = await packing(['a', 'b'], stores(), { pool: 2 });

    await claimed(job, 'v1');

    // Every other start fails, until the job stops replacing them.
    for (let lost = 0; lost < 12; lost += 1) await job.vesselFailed(begun.at(-1) ?? '', 'the first exec exited 137: ');

    const spent = [...begun];

    for (let alarm = 0; alarm < 3; alarm += 1) await job.alarm();

    expect({ spent, after: begun }).toEqual({ spent: Array.from({ length: 10 }, (_, index) => `v${String(index + 1)}`), after: spent });
  });
  test('keeps the newest estimate of a class, though an older answer arrives after it', async () => {
    const big: Usage = { cores: 1, memory: 6 * GIB, disk: 1e6 };
    const answered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();

    const made = stores(() => true, [async () => {
      answered.resolve();
      await released.promise;
    }]);

    await made.store(CLASS)?.record(Array.from({ length: MIN_SAMPLES }, (_, at) => ({ ...SMALL, run: `earlier/${String(at)}/1/v1`, item: `e${String(at)}` })));
    const { job } = await packing([], made, { open: true });
    // Its read answered small, and held in flight while the class is measured bigger and the job reads that.
    const adding = job.add(['c', 'd'].map((item) => ({ item, argv: argvOf(item) })));

    await answered.promise;
    await made.store(CLASS)?.record(Array.from({ length: MIN_SAMPLES }, (_, at) => ({ ...big, run: `later/${String(at)}/1/v1`, item: `l${String(at)}` })));
    await job.alarm();
    released.resolve();
    await adding;

    expect(await slotsOf(job, 'v1', 2)).toEqual([0, null]);
  });
  test('holds a losing copy in its pool until its vessel says it stopped', async () => {
    const { job } = await packing([{ weight: 9 }, { weight: 1 }, { weight: 1 }], await learned(SMALL), { pool: 2, hedge: 1 });
    const first = await claimed(job, 'v1');
    const copy = await claimed(job, 'v2');

    // The first copy's red is the task's; the copy on v2 runs on until its next check tells it to stop.
    await land(job, 'v1', ran(0, 'v1', 1, { attempt: first.attempt }));
    const meanwhile = await slotsOf(job, 'v1', 2, 1);

    await job.stopped('v2', 0, { slot: 0, attempt: copy.attempt });

    expect({ meanwhile, after: await slotsOf(job, 'v1', 2, 3) }).toEqual({ meanwhile: [1, null], after: [2, null] });
  });

  test('closes an open job only once what it took has had its vessels asked for', async () => {
    const answered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();

    const made = stores(() => true, [async () => {
      answered.resolve();
      await released.promise;
    }]);

    const { job, begun } = await packing([], made, { open: true });
    const adding = job.add([{ item: { gang: 2 }, argv: argvOf({ gang: 2 }) }]);

    await answered.promise;
    await job.close();
    released.resolve();
    await adding;

    expect({ begun, done: (await job.events(0)).done }).toEqual({ begun: ['v1', 'v2'], done: false });
  });
});
