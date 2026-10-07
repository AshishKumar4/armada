import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema } from '../../src/protocol';
import worker from '../src/worker';
import { bucket, namespace, world } from './harness';

const TOKEN = 't'.repeat(32);

describe('a commit\'s pack', () => {
  test('is kept under its packer: an earlier client finds its own, and this client never takes one an earlier client made', async () => {
    const sha = 'a'.repeat(40);
    const stored = bucket(new Map([[`packs/proj/${sha}.root.pack`, 'an earlier client\'s pack']]));
    const env = world({ ARTIFACTS: stored, ARMADA_TOKEN: TOKEN, JOB: namespace(() => ({ create: async () => undefined })) });
    const call = async (method: string, path: string, body?: string) => (await worker.fetch(new Request(`https://armada.test${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}` } }), env)).status;
    const job = async (packer?: number) => await call('POST', '/jobs', JSON.stringify(v.parse(JobSpecSchema, {
      recipe: { repo: { project: 'proj', checkout: '/home/ci/work', history: 'commit', manifest: [] } }, commit: { sha, base: 'root', packer }, items: [{ item: 1, argv: ['true'] }], run: { kind: 'command' },
    })));
    const before = { earlier: await call('HEAD', `/packs/proj/${sha}/root`), current: await call('HEAD', `/packs/proj/${sha}/root?packer=2`), job: await job(2) };
    const put = await call('PUT', `/packs/proj/${sha}/root?packer=2`, 'this client\'s pack');

    expect({ before, put, after: await job(2), earlierJob: await job(), keys: [...stored.objects.keys()].sort() }).toEqual({
      before: { earlier: 200, current: 404, job: 409 }, put: 200, after: 200, earlierJob: 200,
      keys: [`packs/proj/${sha}.root.p2.pack`, `packs/proj/${sha}.root.pack`],
    });
  });
});
