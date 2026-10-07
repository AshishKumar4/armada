import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { cacheKey, environmentKey, JobSpecSchema, RecipeSchema, type Outcome } from '../../src/protocol';
import type { Generation } from '../src/environments';
import { taskKey } from '../src/env';
import { ArmadaJob } from '../src/job';
import { bucket, namespace, state, world } from './harness';

const generation: Generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

const bundle = 'b'.repeat(64);

/** A job of the cached pushed task `task` over `items`, on a ready environment, beside the other jobs of `artifacts`;
 *  its vessels only record that they began. An `open` job takes more items. */
async function cachedJob(id: string, items: readonly unknown[], artifacts: ReturnType<typeof bucket>, task = 'square', open = false) {
  const begun: string[] = [];
  const stored = state();
  const job = new ArmadaJob(stored.ctx, world({
    ARTIFACTS: artifacts,
    VESSEL: namespace((name: string) => ({ begin: async () => { begun.push(name); }, stop: async () => undefined })),
    ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }) })),
  }));

  await job.create(id, v.parse(JobSpecSchema, { recipe: {}, items: items.map((item) => ({ item })), run: { kind: 'task', id: task, bundle }, cache: { days: 7 }, open }));
  await job.alarm();

  return { job, begun, pending: stored.pending };
}

/** `vessel` runs its next task: its envelope lands in R2, and its outcome exits `exitCode`. */
async function answer(job: ArmadaJob, id: string, artifacts: ReturnType<typeof bucket>, vessel: string, exitCode: number, envelope: string): Promise<void> {
  const claim = await job.claim(vessel);

  if (claim === null || 'waitMs' in claim || !(await job.accept(vessel, claim.index))) throw new Error(`${vessel} got no task`);
  await artifacts.put(taskKey(id, claim.index, 'output'), envelope);
  const outcome: Outcome = { index: claim.index, kind: 'exited', exitCode, seconds: 1, vessel, attempt: 1, tail: '', output: true, value: envelope, answer: 'value' };

  await job.complete(vessel, outcome, 1000);
}

const brief = (outcome: Outcome) => ({ index: outcome.index, cached: outcome.cached ?? false, value: outcome.value });

describe('a cached task', () => {
  test('answers an item it answered green before, its keys in any order, with nothing run; a red answer and an expired one run again', async () => {
    const artifacts = bucket();
    const first = await cachedJob('j1', [{ a: 1, b: 2 }, { a: 3 }], artifacts);

    await answer(first.job, 'j1', artifacts, 'v1', 0, '{"ok":true,"value":3}');
    await answer(first.job, 'j1', artifacts, 'v1', 1, '{"ok":false,"error":{"name":"Error","message":"red","stack":""}}');
    await Promise.all(first.pending);
    const second = await cachedJob('j2', [{ a: 3 }, { b: 2, a: 1 }], artifacts);
    const events = (await second.job.events(0)).events.map((event) => brief(event.outcome));

    for (const [key, held] of artifacts.kept) if (key.startsWith('cache/')) artifacts.kept.set(key, { ...held, customMetadata: { ...held.customMetadata, expires: '0' } });
    const third = await cachedJob('j3', [{ a: 1, b: 2 }], artifacts);

    expect({
      first: first.begun, second: second.begun, events, copied: artifacts.objects.get(taskKey('j2', 1, 'output')),
      key: artifacts.objects.has(await cacheKey(bundle, 'square', await environmentKey(v.parse(RecipeSchema, {})), { b: 2, a: 1 })), third: third.begun,
    }).toEqual({
      first: ['j1/v1', 'j1/v2'], second: ['j2/v1'], events: [{ index: 1, cached: true, value: '{"ok":true,"value":3}' }], copied: '{"ok":true,"value":3}',
      key: true, third: ['j3/v1'],
    });
  });

  test('is its own: two tasks of one push, with one recipe and one item, each get their own answer', async () => {
    const artifacts = bucket();
    const square = await cachedJob('s1', [3], artifacts, 'square');

    await answer(square.job, 's1', artifacts, 'v1', 0, '{"ok":true,"value":9}');
    await Promise.all(square.pending);
    const cube = await cachedJob('c1', [3], artifacts, 'cube');

    await answer(cube.job, 'c1', artifacts, 'v1', 0, '{"ok":true,"value":27}');
    await Promise.all(cube.pending);
    const [squareAgain, cubeAgain] = [await cachedJob('s2', [3], artifacts, 'square'), await cachedJob('c2', [3], artifacts, 'cube')];
    const answered = async (job: ArmadaJob) => (await job.events(0)).events.map((event) => brief(event.outcome));

    expect({ cubeRan: cube.begun, square: await answered(squareAgain.job), cube: await answered(cubeAgain.job) }).toEqual({
      cubeRan: ['c1/v1'], square: [{ index: 0, cached: true, value: '{"ok":true,"value":9}' }], cube: [{ index: 0, cached: true, value: '{"ok":true,"value":27}' }],
    });
  });

  test('reserves a task while it reads the cache, so no vessel runs it and its stored output is the answer it lands with', async () => {
    const artifacts = bucket();
    const first = await cachedJob('w1', [5], artifacts);

    await answer(first.job, 'w1', artifacts, 'v1', 0, '{"ok":true,"value":25}');
    await Promise.all(first.pending);
    // The next job's cache reads wait for `release`; `reached` says one is waiting.
    let release = () => undefined as void;
    let reached = () => undefined as void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const read = artifacts.get;

    artifacts.get = async (key: string) => {
      if (key.startsWith('cache/')) {
        reached();
        await held;
      }

      return await read(key);
    };
    const open = await cachedJob('w2', [], artifacts, 'square', true);
    const adding = open.job.add([{ item: 5 }]);

    await waiting;
    const claimed = await open.job.claim('v1');

    release();
    await adding;

    expect({ claimed, events: (await open.job.events(0)).events.map((event) => brief(event.outcome)), output: artifacts.objects.get(taskKey('w2', 0, 'output')) }).toEqual({
      claimed: null, events: [{ index: 0, cached: true, value: '{"ok":true,"value":25}' }], output: '{"ok":true,"value":25}',
    });
  });

  test('gives a task back to the queue when its cache read fails', async () => {
    const artifacts = bucket();
    const first = await cachedJob('f1', [6], artifacts);

    await answer(first.job, 'f1', artifacts, 'v1', 0, '{"ok":true,"value":36}');
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
