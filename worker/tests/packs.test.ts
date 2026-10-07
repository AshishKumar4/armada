import { describe, expect, test } from 'bun:test';
import worker from '../src/worker';
import { bucket, world } from './harness';

const TOKEN = 't'.repeat(32);

describe('a commit\'s pack', () => {
  test('one an earlier packer stored is not offered again, so the client uploads the commit anew', async () => {
    const sha = 'a'.repeat(40);
    const stored = bucket(new Map([[`packs/proj/${sha}.root.pack`, 'a pack missing objects']]));
    const env = world({ ARTIFACTS: stored, ARMADA_TOKEN: TOKEN });
    const call = async (method: string, body?: string) => (await worker.fetch(new Request(`https://armada.test/packs/proj/${sha}/root`, { method, body, headers: { authorization: `Bearer ${TOKEN}` } }), env)).status;

    expect({ before: await call('HEAD'), put: await call('PUT', 'the whole commit'), after: await call('HEAD') }).toEqual({ before: 404, put: 200, after: 200 });
  });
});
