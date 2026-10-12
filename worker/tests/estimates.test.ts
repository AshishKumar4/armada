import { describe, expect, test } from 'bun:test';
import { ArmadaEstimates, classEstimate, MIN_SAMPLES } from '../src/estimates';
import { state, world } from './harness';

const GIB = 2 ** 30;

describe('a class\'s estimates', () => {
  test('keep its newest samples, and each item\'s most memory and disk, alone once found to run alone', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));

    await store.record([{ item: 'a', cores: 1, memory: 2 * GIB, disk: 100 }, { item: 'b', cores: 0.5, memory: GIB, disk: 50 }]);
    await store.record([{ item: 'a', cores: 2, memory: GIB, disk: 300 }], ['b']);
    await store.record(Array.from({ length: 250 }, (_, at) => ({ item: `x${String(at)}`, cores: 1, memory: GIB, disk: 1 })));
    const read = await store.read(['a', 'b', 'unknown']);

    expect({ samples: read.samples.length, items: read.items }).toEqual({
      samples: 200,
      items: { a: { cores: 2, memory: 2 * GIB, disk: 300, alone: false }, b: { cores: 0.5, memory: GIB, disk: 50, alone: true } },
    });
  });

  test('estimate a class from enough samples only: its 90th percentile of cores, 95th of memory, and most disk', () => {
    const samples = Array.from({ length: 20 }, (_, at) => ({ cores: at / 10, memory: (at + 1) * GIB, disk: at * 1000 }));

    expect({ few: classEstimate(samples.slice(0, MIN_SAMPLES - 1)), enough: classEstimate(samples) }).toEqual({
      few: null, enough: { cores: 1.8, memory: 20 * GIB, disk: 19_000 },
    });
  });
});
