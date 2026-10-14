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

  test('keep what one value held before #43, each row and file under its own key', async () => {
    const stored = state();

    await stored.ctx.storage.put('history', { rows: { a: [1, 2, 3] }, files: { 'f.ts': [10] }, usage: { memory: [4], cores: [2] } });
    const timings = new ArmadaTimings(stored.ctx, world({}));

    await timings.record({ rows: { a: 5 }, files: {} });

    expect({ estimates: await timings.estimates(), history: await stored.ctx.storage.get('history') })
      .toEqual({ estimates: { rows: { a: 2.5 }, files: { 'f.ts': 10 }, usage: { memory: 4, cores: 2 } }, history: undefined });
  });
});
