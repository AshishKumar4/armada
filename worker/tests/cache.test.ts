import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { cacheKey, environmentKey, JobSpecSchema, RecipeSchema, type Json, type Outcome } from '../../src/protocol';
import { runKey } from '../src/env';
import { ArmadaJob, type Claim } from '../src/job';
import { bucket, namespace, readyRegistry, state, world } from './harness';


const bundle = 'b'.repeat(64);

/** A job of the cached pushed task `task` over `items`, on a ready environment, beside the other jobs of `artifacts`;
 *  its vessels only record that they began. An `open` job takes more items. */
async function cachedJob(id: string, items: readonly Json[], artifacts: ReturnType<typeof bucket>, { task = 'square', open = false, hedge = 0 }: { readonly task?: string; readonly open?: boolean; readonly hedge?: number } = {}) {
  const begun: string[] = [];
  const stored = state();

  const job = new ArmadaJob(stored.ctx, world({
    ARTIFACTS: artifacts,
    VESSEL: namespace((name: string) => ({ begin: async () => { begun.push(name); }, stop: async () => undefined })),
    ENVIRONMENTS: readyRegistry(),
  }));

  await job.create(id, v.parse(JobSpecSchema, { recipe: {}, items: items.map((item) => ({ item })), run: { kind: 'task', id: task, bundle }, cache: { days: 7 }, open, hedge, pool: 2 }));
  await job.alarm();

  return { job, id, artifacts, begun, pending: stored.pending };
}

/** `vessel` runs its next task, as a vessel does: its envelope into R2 under its run, then its outcome, exiting `exitCode`. */
async function answer({ job, id, artifacts }: Awaited<ReturnType<typeof cachedJob>>, vessel: string, exitCode: number, envelope: string): Promise<void> {
  const claim = await job.claim(vessel);

  if (claim === null || 'waitMs' in claim) throw new Error(`${vessel} got no task`);
  await finish({ job, id, artifacts }, { vessel, claim, exitCode, envelope });
}

/** A run's end: its vessel and claim, its exit code, and the envelope it wrote. */
interface Run {
  readonly vessel: string;
  readonly claim: Claim;
  readonly exitCode: number;
  readonly envelope: string;
}

/** `vessel`'s run of `claim` ends with `exitCode`: its envelope into R2 under its run, if its answer is the one kept, then
 *  its outcome. */
async function finish({ job, id, artifacts }: Pick<Awaited<ReturnType<typeof cachedJob>>, 'job' | 'id' | 'artifacts'>, { vessel, claim, exitCode, envelope }: Run): Promise<void> {
  if (!(await job.accept(vessel, claim.index, exitCode, { slot: 0, attempt: claim.attempt }))) return;
  await artifacts.put(runKey(id, claim.index, { vessel, attempt: claim.attempt }, 'output'), envelope);
  const outcome: Outcome = { index: claim.index, kind: 'exited', exitCode, seconds: 1, vessel, attempt: claim.attempt, tail: '', output: true, value: envelope, answer: 'value' };

  await job.complete(vessel, outcome, 1000);
}

const brief = (outcome: Outcome) => ({ index: outcome.index, cached: outcome.cached ?? false, value: outcome.value });

describe('a cached task', () => {
  test('answers an item it answered green before, its keys in any order, with nothing run; a red answer and an expired one run again', async () => {
    const artifacts = bucket();
    const first = await cachedJob('j1', [{ a: 1, b: 2 }, { a: 3 }], artifacts);

    await answer(first, 'v1', 0, '{"ok":true,"value":3}');
    await answer(first, 'v1', 1, '{"ok":false,"error":{"name":"Error","message":"red","stack":""}}');
    await Promise.all(first.pending);
    const second = await cachedJob('j2', [{ a: 3 }, { b: 2, a: 1 }], artifacts);
    const events = (await second.job.events(0)).events.map((event) => brief(event.outcome));

    for (const [key, held] of artifacts.kept) if (key.startsWith('cache/')) artifacts.kept.set(key, { ...held, customMetadata: { ...held.customMetadata, expires: '0' } });
    const third = await cachedJob('j3', [{ a: 1, b: 2 }], artifacts);

    expect({
      first: first.begun, second: second.begun, events, output: artifacts.text((await second.job.fileOf(1, 'output')) ?? ''),
      key: artifacts.objects.has(await cacheKey(bundle, 'square', await environmentKey(v.parse(RecipeSchema, {})), { b: 2, a: 1 })), third: third.begun,
    }).toEqual({
      first: ['j1/v1', 'j1/v2'], second: ['j2/v1'], events: [{ index: 1, cached: true, value: '{"ok":true,"value":3}' }], output: '{"ok":true,"value":3}',
      key: true, third: ['j3/v1'],
    });
  });

  test('is its own: two tasks of one push, with one recipe and one item, each get their own answer', async () => {
    const artifacts = bucket();
    const square = await cachedJob('s1', [3], artifacts, { task: 'square' });

    await answer(square, 'v1', 0, '{"ok":true,"value":9}');
    await Promise.all(square.pending);
    const cube = await cachedJob('c1', [3], artifacts, { task: 'cube' });

    await answer(cube, 'v1', 0, '{"ok":true,"value":27}');
    await Promise.all(cube.pending);
    const [squareAgain, cubeAgain] = [await cachedJob('s2', [3], artifacts, { task: 'square' }), await cachedJob('c2', [3], artifacts, { task: 'cube' })];
    const answered = async (job: ArmadaJob) => (await job.events(0)).events.map((event) => brief(event.outcome));

    expect({ cubeRan: cube.begun, square: await answered(squareAgain.job), cube: await answered(cubeAgain.job) }).toEqual({
      cubeRan: ['c1/v1'], square: [{ index: 0, cached: true, value: '{"ok":true,"value":9}' }], cube: [{ index: 0, cached: true, value: '{"ok":true,"value":27}' }],
    });
  });

  test('reserves a task while it reads the cache, so no vessel runs it and its stored output is the answer it lands with', async () => {
    const artifacts = bucket();
    const first = await cachedJob('w1', [5], artifacts);

    await answer(first, 'v1', 0, '{"ok":true,"value":25}');
    await Promise.all(first.pending);
    // The next job's cache reads wait for `held`; `waiting` says one is waiting.
    const held = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const read = artifacts.get;

    artifacts.get = async (key: string) => {
      if (key.startsWith('cache/')) {
        waiting.resolve();
        await held.promise;
      }

      return await read(key);
    };

    const open = await cachedJob('w2', [], artifacts, { task: 'square', open: true });
    const adding = open.job.add([{ item: 5 }]);

    await waiting.promise;
    const claimed = await open.job.claim('v1');

    held.resolve();
    await adding;

    expect({ claimed, events: (await open.job.events(0)).events.map((event) => brief(event.outcome)), output: artifacts.text((await open.job.fileOf(0, 'output')) ?? '') }).toEqual({
      claimed: null, events: [{ index: 0, cached: true, value: '{"ok":true,"value":25}' }], output: '{"ok":true,"value":25}',
    });
  });

  test('keeps a hedged task\'s green only once its other copy can no longer end it red', async () => {
    const artifacts = bucket();

    const answered = async (copies: readonly number[]) => {
      const job = await cachedJob(`h${copies.join('')}`, [7], artifacts, { hedge: 1 });
      const claims = [await job.job.claim('v1'), await job.job.claim('v2')];

      for (const [at, claim] of claims.entries()) {
        if (claim === null || 'waitMs' in claim) throw new Error('both copies run');
        await finish(job, { vessel: `v${String(at + 1)}`, claim, exitCode: copies[at] ?? 0, envelope: '{"ok":true,"value":49}' });
      }

      await Promise.all(job.pending);
      const again = await cachedJob(`a${copies.join('')}`, [7], artifacts);

      return (await again.job.events(0)).events.map((event) => brief(event.outcome));
    };

    // The first copy's green, then the other copy's red: the task is red, and nothing is cached.
    const red = await answered([0, 1]);
    const green = await answered([0, 0]);

    expect({ red, green }).toEqual({ red: [], green: [{ index: 0, cached: true, value: '{"ok":true,"value":49}' }] });
  });

  test('keeps no gang\'s answer: a gang item runs its ranks again', async () => {
    const artifacts = bucket();
    const first = await cachedJob('g1', [{ gang: 2 }], artifacts);
    const ranks: Record<string, Claim> = {};

    for (let round = 0; round < 3; round += 1) {
      for (const vessel of ['v1', 'v2']) {
        const claim = ranks[vessel] === undefined ? await first.job.claim(vessel) : null;

        if (claim !== null && !('waitMs' in claim)) ranks[vessel] = claim;
      }
    }

    for (const [vessel, claim] of Object.entries(ranks)) {
      await first.job.started(vessel, claim.index, claim.attempt);
      await finish(first, { vessel, claim, exitCode: 0, envelope: '{"ok":true,"value":1}' });
    }

    await Promise.all(first.pending);
    const again = await cachedJob('g2', [{ gang: 2 }], artifacts);

    expect({ landed: (await first.job.events(0)).events.length, cached: (await again.job.events(0)).events.length, begun: again.begun })
      .toEqual({ landed: 1, cached: 0, begun: ['g2/v1', 'g2/v2'] });
  });

  test('gives a task back to the queue when its cache read fails', async () => {
    const artifacts = bucket();
    const first = await cachedJob('f1', [6], artifacts);

    await answer(first, 'v1', 0, '{"ok":true,"value":36}');
    await Promise.all(first.pending);
    const read = artifacts.get;

    artifacts.get = async (key: string) => {
      if (key.startsWith('cache/')) throw new Error('R2 is unavailable');

      return await read(key);
    };

    const failing = await cachedJob('f2', [6], artifacts);

    expect({ begun: failing.begun, status: (await failing.job.status())?.tasks }).toMatchObject({ begun: ['f2/v1'], status: { queued: 1 } });
  });
});
