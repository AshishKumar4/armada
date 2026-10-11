import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, TaskStatusSchema } from '../../src/protocol';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

/** A registry whose one environment is always ready, for a job to run in. */
const ready = () => {
  const generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

  return namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }), used: async () => undefined }));
};

describe('a task\'s artifacts', () => {
  test('are served as stored at /jobs/<id>/tasks/<i>/artifacts, and 404 when it kept none', async () => {
    const env = world({
      ARMADA_TOKEN: TOKEN, VERSION: { id: 'v', tag: '', timestamp: '' },
      ARTIFACTS: bucket(new Map([['jobs/j1/tasks/0/artifacts.tar.gz', 'packed']])),
      JOB: namespace(() => ({})),
    });

    const ask = async (path: string) => await worker.fetch(new Request(`https://armada.test${path}`, { headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': '7' } }), env);
    const kept = await ask('/jobs/j1/tasks/0/artifacts');
    const none = await ask('/jobs/j1/tasks/1/artifacts');
    const leaf = await ask('/jobs/j1/tasks/0/nothing');
    await env.ARTIFACTS.put('jobs/j1/tasks/2/artifacts.tar.gz', 'typed', { httpMetadata: { contentType: 'application/gzip' } });
    const typed = await ask('/jobs/j1/tasks/2/artifacts');

    expect({ kept: kept.status, body: await kept.text(), none: none.status, leaf: leaf.status, typed: typed.headers.get('content-type') })
      .toEqual({ kept: 200, body: 'packed', none: 404, leaf: 404, typed: 'application/gzip' });
  });
});

describe('a task\'s status token', () => {
  test('reads its job\'s tasks at /status/<job>/<index>, each run until its container is gone, and nothing else', async () => {
    const id = '20261010120000-0123abcd';

    const env = world({
      JOB: namespace((name) => (name === id ? running : undefined)),
      ENVIRONMENTS: ready(),
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
  test('stays in its task\'s status, beside the next run in that slot, until the vessel\'s container is gone', async () => {
    const id = '20261010120000-4567abcd';

    const env = world({
      JOB: namespace(() => restarted),
      ENVIRONMENTS: ready(),
      VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => true })),
    });

    const restarted = new ArmadaJob(state().ctx, env);

    await restarted.create(id, v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }], run: { kind: 'command' }, pool: 1 }), 'https://armada.test');
    await restarted.alarm();
    const first = await restarted.claim('v1');

    if (first === null || 'waitMs' in first) throw new Error('v1 got no task');
    const token = first.env['ARMADA_STATUS_TOKEN'] ?? '';
    const ask = async (index: number) => v.parse(TaskStatusSchema, await (await worker.fetch(new Request(`https://armada.test/status/${id}/${String(index)}`, { headers: { authorization: `Bearer ${token}` } }), env)).json());

    // Restarted with its slot's record lost, v1 asks for its slot's next task while the first may still run; a word
    // that names no run, as an earlier vessel's, ends none.
    await restarted.claim('v1');
    await restarted.accept('v1', 1, 0);
    const both = await Promise.all([ask(0), ask(1)]);

    await restarted.retired('v1', true);
    const gone = await Promise.all([ask(0), ask(1)]);

    expect([both, gone].map((each) => each.map((status) => status.running.map((run) => run.vessel)))).toEqual([[['v1'], ['v1']], [[], []]]);
  });
});

describe('a job an earlier Worker made', () => {
  test('refuses its tasks\' status, since none of its runs were recorded', async () => {
    const id = '20261010120000-89abcdef';
    const stored = state();
    const env = world({ JOB: namespace(() => earlier), ENVIRONMENTS: ready(), VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => true })) });
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
