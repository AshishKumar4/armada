import { describe, expect, test } from 'bun:test';
import { ArmadaEstimates, MIN_SAMPLES } from '../src/estimates';
import { state, world } from './harness';

const GIB = 2 ** 30;

describe('a class\'s estimates', () => {
  test('count each run once, however often and however late it is delivered, and estimate from enough of the newest', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));
    const run = (at: number, memory: number) => ({ run: `j/${String(at)}/1/v1`, item: `i${String(at)}`, cores: at / 10, memory, disk: at * 1000 });
    const few = Array.from({ length: MIN_SAMPLES - 1 }, (_, at) => run(at, GIB));

    const below = await store.record(few);
    // The same runs again, as a send whose answer was lost, or two sends at once, however many times: no new sample.
    const again = await Promise.all(Array.from({ length: 30 }, async () => await store.record(few)));
    const enough = await store.record([run(MIN_SAMPLES - 1, 2 * GIB), ...Array.from({ length: 300 }, (_, at) => run(100 + at, 3 * GIB))]);
    // The first runs again, after far more runs than an estimate reads.
    const late = await store.record(few);

    // The newest 200 of 308 are runs 200 to 399: cores 20 to 39.9, whose 90th percentile by rank is 38; 3 GiB each.
    expect({ below: below.usage, again: again.map((each) => each.revision === below.revision && each.usage === null), enough: enough.usage, late: late.revision === enough.revision && late.revision > below.revision })
      .toEqual({ below: null, again: Array.from({ length: 30 }, () => true), enough: { cores: 38, memory: 3 * GIB, disk: 399_000 }, late: true });
  });

  test('estimate once enough runs are in, however many deliveries came again before them', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));
    const runs = Array.from({ length: MIN_SAMPLES }, (_, at) => ({ run: `j/${String(at)}/1/v1`, item: 'a', cores: 1, memory: GIB, disk: 1 }));

    await store.record(runs.slice(0, -1));

    for (let again = 0; again < 30; again += 1) await store.record(runs.slice(0, -1));

    expect((await store.record(runs.slice(-1))).usage).toEqual({ cores: 1, memory: GIB, disk: 1 });
  });

  test('keep each item\'s most memory and disk and its latest cores, and alone once found to run alone', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));

    await store.record([{ run: 'j/0/1/v1', item: 'a', cores: 1, memory: 2 * GIB, disk: 100 }, { run: 'j/1/1/v1', item: 'b', cores: 0.5, memory: GIB, disk: 50 }]);
    await store.record([{ run: 'j/0/2/v1', item: 'a', cores: 2, memory: GIB, disk: 300 }], ['b']);

    expect((await store.read(['a', 'b', 'unknown'])).items).toEqual({ a: { cores: 2, memory: 2 * GIB, disk: 300, alone: false }, b: { cores: 0.5, memory: GIB, disk: 50, alone: true } });
  });
  test('reads every item it is asked for, however many, as the platform binds a statement\'s parameters', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));
    const runs = Array.from({ length: 250 }, (_, at) => ({ run: `j/${String(at)}/1/v1`, item: `i${String(at)}`, cores: 1, memory: GIB, disk: 1 }));

    await store.record(runs);

    expect(Object.keys((await store.read(runs.map((run) => run.item))).items).length).toBe(250);
  });
});
