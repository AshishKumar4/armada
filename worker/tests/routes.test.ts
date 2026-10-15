import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, TaskStatusSchema } from '../../src/protocol';
import { runKey, taskKey } from '../src/env';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { bucket, namespace, readyRegistry, state, world } from './harness';

const TOKEN = 't'.repeat(32);

describe('a task\'s files', () => {
  test('are its kept run\'s, served as stored, an earlier Worker\'s where it kept them, and 404 for a task with none', async () => {
    const id = '20261011120000-0123abcd';
    const artifacts = bucket();

    const env = world({
      ARMADA_TOKEN: TOKEN, VERSION: { id: 'v', tag: '', timestamp: '' }, ARTIFACTS: artifacts, ENVIRONMENTS: readyRegistry(),
      JOB: namespace(() => job), VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => true })),
    });

    const job = new ArmadaJob(state().ctx, env);

    await job.create(id, v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }, { item: 'c', argv: ['true'] }], run: { kind: 'command' } }));
    await job.alarm();

    for (const index of [0, 1, 2]) {
      await job.claim('v1');
      await job.accept('v1', index, 0, { slot: 0, attempt: 1 });
      await job.complete('v1', { index, kind: 'exited', exitCode: 0, seconds: 1, vessel: 'v1', attempt: 1, tail: '', output: false, artifacts: index === 1 ? undefined : true }, 1000);
    }

    await artifacts.put(runKey(id, 0, { vessel: 'v1', attempt: 1 }, 'artifacts'), 'packed', { httpMetadata: { contentType: 'application/gzip' } });
    await artifacts.put(taskKey(id, 2, 'artifacts'), 'earlier');
    const ask = async (path: string) => await worker.fetch(new Request(`https://armada.test${path}`, { headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': '7' } }), env);
    const [kept, none, earlier, leaf, missing] = await Promise.all(['0/artifacts', '1/artifacts', '2/artifacts', '0/nothing', '3/artifacts'].map(async (path) => await ask(`/jobs/${id}/tasks/${path}`)));

    expect({ kept: [kept?.status, await kept?.text(), kept?.headers.get('content-type')], none: none?.status, earlier: await earlier?.text(), leaf: leaf?.status, missing: missing?.status })
      .toEqual({ kept: [200, 'packed', 'application/gzip'], none: 404, earlier: 'earlier', leaf: 404, missing: 404 });
  });
});

describe('a task\'s status token', () => {
  test('reads its job\'s tasks at /status/<job>/<index>, each run until its container is gone, and nothing else', async () => {
    const id = '20261010120000-0123abcd';

    const env = world({
      JOB: namespace((name) => (name === id ? running : undefined)),
      ENVIRONMENTS: readyRegistry(),
      // v2's container cannot be destroyed, so its task may still run after the job ends.
      VESSEL: namespace((name) => ({ begin: async () => undefined, stop: async () => !name.endsWith('/v2') })),
    });

    const running = new ArmadaJob(state().ctx, env);

    await running.create(id, v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }, { item: 'c', argv: ['true'] }], run: { kind: 'command' } }), 'https://armada.test');
    await running.alarm();
    const claim = await running.claim('v1');

    if (claim === null || 'waitMs' in claim) throw new Error('v1 got no task');
    const token = claim.env['ARMADA_STATUS_TOKEN'] ?? '';

    const ask = async (path: string, as = token, method = 'GET') => {
      const answer = await worker.fetch(new Request(path.startsWith('https:') ? path : `https://armada.test${path}`, { method, headers: { authorization: `Bearer ${as}` } }), env);

      return { status: answer.status, body: answer.status === 200 ? v.parse(TaskStatusSchema, await answer.json()) : undefined };
    };

    const runs = (asked: Awaited<ReturnType<typeof ask>>) => asked.body?.running.map((run) => [run.vessel, run.slot, run.attempt]);
    const during = await ask(`${claim.env['ARMADA_STATUS_URL'] ?? ''}/${claim.env['ARMADA_INDEX'] ?? ''}`);

    await running.accept('v1', 0, 3, { slot: 0, attempt: 1 });
    await running.complete('v1', { index: 0, kind: 'exited', exitCode: 3, seconds: 1, vessel: 'v1', attempt: 1, tail: '', output: false }, 1000);
    await running.claim('v2');
    await running.claim('v3');
    await running.cancel('cancelled by its client', 'cancelled');
    const landed = await ask(`/status/${id}/0`);
    const stuck = await ask(`/status/${id}/1`);
    const stopped = await ask(`/status/${id}/2`);
    const refused = await Promise.all([ask(`/jobs/${id}`), ask(`/status/20261010120000-ffffffff/0`), ask(`/status/${id}/0`, 'guess'), ask(`/status/${id}/0`, token, 'POST'), ask(`/status/${id}/3`)]);

    expect({
      identity: [claim.env['ARMADA_JOB_ID'], claim.env['ARMADA_VESSEL'], 'ARMADA_TOKEN' in claim.env],
      during: [during.body?.phase, during.body?.state, during.body?.attempt, runs(during)],
      landed: [landed.body?.state, landed.body?.exitCode, runs(landed)],
      stuck: [stuck.body?.phase, stuck.body?.state, stuck.body?.reason, runs(stuck)],
      stopped: [stopped.body?.state, runs(stopped)],
      refused: refused.map((each) => each.status),
    }).toEqual({
      identity: [id, 'v1', false],
      during: ['running', 'running', 1, [['v1', 0, 1]]],
      landed: ['exited', 3, []],
      stuck: ['done', 'failed', 'cancelled', [['v2', 0, 1]]],
      stopped: ['failed', []],
      refused: [403, 403, 403, 404, 404],
    });
  });
});

describe('a run its vessel lost track of', () => {
  test('stays in its task\'s status until its container is gone; the ambiguous slot cannot silently take another task', async () => {
    const id = '20261010120000-4567abcd';

    const env = world({
      JOB: namespace(() => restarted),
      ENVIRONMENTS: readyRegistry(),
      VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => true })),
    });

    const restarted = new ArmadaJob(state().ctx, env);

    // One task a container: the vessel asks again because it lost its slot's record, not to pack another task.
    await restarted.create(id, v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }], run: { kind: 'command' }, pool: 1, mode: 'fast' }), 'https://armada.test');
    await restarted.alarm();
    const first = await restarted.claim('v1');

    if (first === null || 'waitMs' in first) throw new Error('v1 got no task');
    const token = first.env['ARMADA_STATUS_TOKEN'] ?? '';
    const ask = async (index: number) => v.parse(TaskStatusSchema, await (await worker.fetch(new Request(`https://armada.test/status/${id}/${String(index)}`, { headers: { authorization: `Bearer ${token}` } }), env)).json());

    // A reset with no Current cannot safely repeat a launch or overwrite it with another. The job refuses the
    // claim; the vessel's alarm then reports a loss. A stop not confirmed keeps the first run in status.
    await expect(restarted.claim('v1')).rejects.toThrow('before task 0 attempt 1 ended');
    await restarted.vesselFailed('v1', 'the slot lost its claim', { gone: false });
    await restarted.claim('v2');
    const both = await ask(0);

    await restarted.retired('v1', true);
    const gone = await ask(0);

    expect([both, gone].map((status) => status.running.map((run) => [run.vessel, run.attempt])))
      .toEqual([[['v1', 1], ['v2', 2]], [['v2', 2]]]);
  });
});

describe('a job an earlier Worker made', () => {
  test('refuses its tasks\' status, since none of its runs were recorded', async () => {
    const id = '20261010120000-89abcdef';
    const stored = state();
    const env = world({ JOB: namespace(() => earlier), ENVIRONMENTS: readyRegistry(), VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => true })) });
    const earlier = new ArmadaJob(stored.ctx, env);

    await earlier.create(id, v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } }), 'https://armada.test');
    await stored.ctx.storage.delete('recorded');
    await earlier.alarm();
    const claim = await earlier.claim('v1');

    if (claim === null || 'waitMs' in claim) throw new Error('v1 got no task');
    const answer = await worker.fetch(new Request(`https://armada.test/status/${id}/0`, { headers: { authorization: `Bearer ${claim.env['ARMADA_STATUS_TOKEN'] ?? ''}` } }), env);

    expect(answer.status).toBe(409);
  });
});

describe('a gang rank\'s relay', () => {
  test('reaches any vessel its job names, however many the job started, an earlier Worker\'s replacements too, and nothing else', async () => {
    const reached: string[] = [];

    const env = world({
      ARMADA_TOKEN: TOKEN,
      VESSEL: namespace((name: string) => ({
        fetch: async () => {
          reached.push(name);

          return new Response('relayed');
        },
      })),
    });

    const id = '20261011120000-0123abcd';
    const ask = async (vessel: string) => (await worker.fetch(new Request(`https://armada.test/relay/${id}/${vessel}?port=1`), env)).status;

    expect({ statuses: [await ask('v1'), await ask('v10000'), await ask('r12'), await ask('x1'), await ask('v'), await ask('v01')], reached })
      .toEqual({ statuses: [200, 200, 200, 404, 404, 404], reached: [`${id}/v1`, `${id}/v10000`, `${id}/r12`] });
  });
});
