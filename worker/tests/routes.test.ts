import { describe, expect, test } from 'bun:test';
import worker from '../src/worker';
import { bucket, namespace, world } from './harness';

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

    expect({ kept: kept.status, body: await kept.text(), none: none.status, leaf: leaf.status })
      .toEqual({ kept: 200, body: 'packed', none: 404, leaf: 404 });
  });
});
