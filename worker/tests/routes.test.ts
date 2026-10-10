import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, TaskStatusSchema } from '../../src/protocol';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

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
  test('reads its job\'s tasks at /status/<job>/<index>, while they run and once they end, and nothing else', async () => {
    const id = '20261010120000-0123abcd';
    const generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

    const env = world({
      JOB: namespace((name) => (name === id ? running : undefined)),
      ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }), used: async () => undefined })),
      VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
    });

    const running = new ArmadaJob(state().ctx, env);

    await running.create(id, v.parse(JobSpecSchema, { recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } }), 'https://armada.test');
    await running.alarm();
    const claim = await running.claim('v1');

    if (claim === null || 'waitMs' in claim) throw new Error('v1 got no task');
    const token = claim.env['ARMADA_STATUS_TOKEN'] ?? '';

    const ask = async (path: string, as = token, method = 'GET') => {
      const answer = await worker.fetch(new Request(path.startsWith('https:') ? path : `https://armada.test${path}`, { method, headers: { authorization: `Bearer ${as}` } }), env);

      return { status: answer.status, body: answer.status === 200 ? v.parse(TaskStatusSchema, await answer.json()) : undefined };
    };

    const during = await ask(`${claim.env['ARMADA_STATUS_URL'] ?? ''}/${claim.env['ARMADA_INDEX'] ?? ''}`);

    await running.accept('v1', 0, 3);
    await running.complete('v1', { index: 0, kind: 'exited', exitCode: 3, seconds: 1, vessel: 'v1', attempt: 1, tail: '', output: false }, 1000);
    const after = await ask(`/status/${id}/0`);
    const refused = await Promise.all([ask(`/jobs/${id}`), ask(`/status/20261010120000-ffffffff/0`), ask(`/status/${id}/0`, 'guess'), ask(`/status/${id}/0`, token, 'POST'), ask(`/status/${id}/1`)]);

    expect({
      identity: [claim.env['ARMADA_JOB_ID'], claim.env['ARMADA_VESSEL'], 'ARMADA_TOKEN' in claim.env],
      during: [during.body?.phase, during.body?.state, during.body?.attempt, during.body?.running.map((each) => [each.vessel, each.slot])],
      after: [after.body?.phase, after.body?.state, after.body?.exitCode, after.body?.running],
      refused: refused.map((each) => each.status),
    }).toEqual({
      identity: [id, 'v1', false],
      during: ['running', 'running', 1, [['v1', 0]]],
      after: ['done', 'exited', 3, []],
      refused: [403, 403, 403, 404, 404],
    });
  });
});
