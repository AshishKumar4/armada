import { describe, expect, test } from 'bun:test';
import { ArmadaTimings } from '../src/timings';
import { state, world } from './harness';

describe('a project\'s timings', () => {
  test('give the most one task used over the last five runs, and none before a run measured it', async () => {
    const timings = new ArmadaTimings(state().ctx, world({}));
    const before = (await timings.estimates()).usage;

    for (const [memory, cores] of [[9, 3], [1, 1], [2, 0.5], [1, 1], [1, 1], [1, 1]] as const) await timings.record({ rows: {}, files: {}, usage: { memory, cores } });
    const recent = (await timings.estimates()).usage;

    await timings.record({ rows: {}, files: {} });

    expect({ before, recent, unmeasured: (await timings.estimates()).usage }).toEqual({ before: null, recent: { memory: 2, cores: 1 }, unmeasured: { memory: 2, cores: 1 } });
  });
});
