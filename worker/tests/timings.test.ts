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

  // #43: Kinu's 103-row run and its files, five samples each, outgrew one value and the POST answered 500 SQLITE_TOOBIG.
  test('take a run of many rows and files, five runs over, and give each its median', async () => {
    const timings = new ArmadaTimings(state().ctx, world({}));
    const name = (kind: string, at: number) => `packages/a-fairly-long-package-name/tests/${kind}-${String(at).padStart(5, '0')}.test.ts`;

    const run = (seconds: number) => ({
      rows: Object.fromEntries(Array.from({ length: 103 }, (_, at) => [`bun test ${name('row', at)}`, seconds])),
      files: Object.fromEntries(Array.from({ length: 20_000 }, (_, at) => [name('file', at), seconds * 1000.123])),
    });

    for (const seconds of [1, 2, 3, 4, 5]) await timings.record(run(seconds));

    const { rows, files } = await timings.estimates();

    expect({ rows: Object.keys(rows).length, row: rows[`bun test ${name('row', 7)}`], files: Object.keys(files).length, file: files[name('file', 19_999)] })
      .toEqual({ rows: 103, row: 3, files: 20_000, file: 3000.369 });
  });

  // 2026-10-16: Kinu's hammer rows were named by the files each change touched, and the 888 a project kept made the
  // answer 8.5 MB, which each job of a run carries in its stored spec: every `armada run` was refused SQLITE_TOOBIG.
  test('keep the rows the last full run named and the files its commit holds, with what it recorded', async () => {
    const timings = new ArmadaTimings(state().ctx, world({}));

    await timings.record({ rows: { 'hammer a.ts': 1, unit: 1 }, files: { 'a.ts': 1, 'gone.ts': 1 }, keep: { rows: ['hammer a.ts', 'unit'], files: ['a.ts', 'gone.ts'] } });
    await timings.record({ rows: { 'hammer b.ts': 2 }, files: { 'b.ts': 2, 'made.ts': 2 }, keep: { rows: ['hammer b.ts', 'unit', 'red'], files: ['a.ts', 'b.ts'] } });

    const { rows, files } = await timings.estimates();

    expect({ rows, files }).toEqual({ rows: { 'hammer b.ts': 2, unit: 1 }, files: { 'a.ts': 1, 'b.ts': 2, 'made.ts': 2 } });
  });

  test('drop once the rows and files an earlier Worker kept, every one a run ever recorded, and keep its usage', async () => {
    const { ctx } = state();

    await ctx.storage.put({ 'row:bun scripts/hammer.ts --run=1 a.ts': [1], 'row:unit': [2], 'file:a.ts': [3], usage: { memory: [4], cores: [1] } });
    const first = await new ArmadaTimings(ctx, world({})).estimates();

    await new ArmadaTimings(ctx, world({})).record({ rows: { unit: 5 }, files: {} });

    expect({ first, after: (await new ArmadaTimings(ctx, world({})).estimates()).rows })
      .toEqual({ first: { rows: {}, files: {}, usage: { memory: 4, cores: 1 } }, after: { unit: 5 } });
  });
});
