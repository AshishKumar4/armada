import { describe, expect, test } from 'bun:test';
import { ArmadaEstimates, MIN_SAMPLES } from '../src/estimates';
import { state, world } from './harness';

const GIB = 2 ** 30;

describe('a class\'s estimates', () => {
  test('count each run once, however often it is delivered, and estimate from enough of the newest', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));
    const run = (at: number, memory: number) => ({ run: `j/${String(at)}/1/v1`, item: `i${String(at)}`, cores: at / 10, memory, disk: at * 1000 });
    const few = Array.from({ length: MIN_SAMPLES - 1 }, (_, at) => run(at, GIB));

    const below = await store.record(few);
    // The same runs again, as a send whose answer was lost, or two sends at once: no new sample.
    const again = await store.record(few);
    const enough = await store.record([run(MIN_SAMPLES - 1, 2 * GIB), ...Array.from({ length: 300 }, (_, at) => run(100 + at, 3 * GIB))]);

    // The newest 200 of 308 are runs 200 to 399: cores 20 to 39.9, whose 90th percentile by rank is 38; 3 GiB each.
    expect({ below, again, enough }).toEqual({ below: null, again: null, enough: { cores: 38, memory: 3 * GIB, disk: 399_000 } });
  });

  test('keep each item\'s most memory and disk and its latest cores, and alone once found to run alone', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));

    await store.record([{ run: 'j/0/1/v1', item: 'a', cores: 1, memory: 2 * GIB, disk: 100 }, { run: 'j/1/1/v1', item: 'b', cores: 0.5, memory: GIB, disk: 50 }]);
    await store.record([{ run: 'j/0/2/v1', item: 'a', cores: 2, memory: GIB, disk: 300 }], ['b']);

    expect((await store.read(['a', 'b', 'unknown'])).items).toEqual({ a: { cores: 2, memory: 2 * GIB, disk: 300, alone: false }, b: { cores: 0.5, memory: GIB, disk: 50, alone: true } });
  });
});
