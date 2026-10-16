import { describe, expect, test } from 'bun:test';
import { ArmadaEstimates, itemKey, MIN_SAMPLES, type Sample } from '../src/estimates';
import { state, world } from './harness';

const GIB = 2 ** 30;

/** Run `run` of `item`: one core, 1 GiB and a byte of disk, alone, unless `usage` says otherwise. */
const sampled = (run: string, item: string, usage: Partial<Sample> = {}): Sample => ({ run, item, cores: 1, memory: GIB, disk: 1, beside: false, ...usage });

describe('a class\'s estimates', () => {
  test('count each run once, however often and however late it is delivered, and estimate from enough of the newest', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));
    const run = (at: number, memory: number) => ({ run: `j/${String(at)}/1/v1`, item: `i${String(at)}`, cores: at / 10, memory, disk: at * 1000, beside: false });
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
    const runs = Array.from({ length: MIN_SAMPLES }, (_, at) => sampled(`j/${String(at)}/1/v1`, 'a'));

    await store.record(runs.slice(0, -1));

    for (let again = 0; again < 30; again += 1) await store.record(runs.slice(0, -1));

    expect((await store.record(runs.slice(-1))).usage).toEqual({ cores: 1, memory: GIB, disk: 1 });
  });

  test('keep each item\'s most memory and disk and the cores of its latest run alone, and alone once found to run alone', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));

    await store.record([{ run: 'j/0/1/v1', item: 'a', cores: 1, memory: 2 * GIB, disk: 100, beside: false }, { run: 'j/1/1/v1', item: 'b', cores: 0.5, memory: GIB, disk: 50, beside: false }]);
    await store.record([{ run: 'j/0/2/v1', item: 'a', cores: 2, memory: GIB, disk: 300, beside: false }, { run: 'j/2/1/v1', item: 'c', cores: 0.4, memory: GIB, disk: 1, beside: true }], ['b']);
    // Beside others it got a quarter of a core, and reached 3 GiB.
    await store.record([{ run: 'j/0/3/v1', item: 'a', cores: 0.25, memory: 3 * GIB, disk: 10, beside: true }]);

    expect((await store.read(['a', 'b', 'c', 'unknown'])).items).toEqual({
      a: { cores: 2, memory: 3 * GIB, disk: 300, alone: false }, b: { cores: 0.5, memory: GIB, disk: 50, alone: true }, c: { cores: null, memory: GIB, disk: 1, alone: false },
    });
  });

  test('estimate cores only from runs alone, and read and keep what an earlier Worker recorded', async () => {
    const stored = state();

    // As an earlier Worker left it: every run taken as alone, every item with cores.
    stored.ctx.storage.sql.exec('CREATE TABLE samples (seq INTEGER PRIMARY KEY, run TEXT NOT NULL UNIQUE, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL)');
    stored.ctx.storage.sql.exec('CREATE TABLE items (key TEXT PRIMARY KEY, cores REAL NOT NULL, memory REAL NOT NULL, disk REAL NOT NULL, alone INTEGER NOT NULL, at INTEGER NOT NULL)');

    for (let at = 0; at < MIN_SAMPLES; at += 1) stored.ctx.storage.sql.exec('INSERT INTO samples (run, cores, memory, disk) VALUES (?, 2, ?, 1)', `j/${String(at)}/1/v1`, GIB);
    stored.ctx.storage.sql.exec('INSERT INTO items (key, cores, memory, disk, alone, at) VALUES (\'a\', 2, ?, 1, 0, 0)', GIB);
    const store = new ArmadaEstimates(stored.ctx, world({}));
    const before = (await store.read(['a'])).estimate.usage;
    // Twenty runs beside others, each given half a core, outnumber the runs alone and still leave the cores alone.
    const after = await store.record(Array.from({ length: 20 }, (_, at) => sampled(`k/${String(at)}/1/v1`, 'a', { cores: 0.5, beside: true })));

    expect({ before, after: after.usage, item: (await store.read(['a'])).items['a'] })
      .toEqual({ before: { cores: 2, memory: GIB, disk: 1 }, after: { cores: 2, memory: GIB, disk: 1 }, item: { cores: 2, memory: GIB, disk: 1, alone: false } });
  });
  test('reads every item it is asked for, however many, as the platform bounds a statement', async () => {
    const store = new ArmadaEstimates(state().ctx, world({}));
    const keys = await Promise.all(Array.from({ length: 40_000 }, async (_, at) => await itemKey({ item: at, argv: ['work'] })));

    await store.record(keys.slice(0, 250).map((item, at) => sampled(`j/${String(at)}/1/v1`, item)));

    expect(Object.keys((await store.read(keys)).items).length).toBe(250);
  });
});
