import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, PACKER, PROTOCOL } from '../../src/protocol';
import worker from '../src/worker';
import { bucket, namespace, world } from './harness';

const TOKEN = 't'.repeat(32);

const SHA = 'a'.repeat(40);

/** A deployment whose bucket holds `objects`, asked as the CLI asks it: a request's status, and a job of `SHA` on a
 *  repository of `history`, packed under `packer` with `shallow` as its boundary. */
function deployment(history: 'full' | 'commit', objects = new Map<string, string>()) {
  const stored = bucket(objects);
  const env = world({ ARTIFACTS: stored, ARMADA_TOKEN: TOKEN, JOB: namespace(() => ({ create: async () => undefined })) });
  const call = async (method: string, path: string, body?: string) => (await worker.fetch(new Request(`https://armada.test${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': String(PROTOCOL) } }), env)).status;

  const job = async ({ packer, shallow }: { readonly packer?: number; readonly shallow?: string[] } = {}) => await call('POST', '/jobs', JSON.stringify(v.parse(JobSpecSchema, {
    recipe: { repo: { project: 'proj', checkout: '/home/ci/work', history, manifest: [] } }, commit: { sha: SHA, base: 'root', packer, shallow }, items: [{ item: 1, argv: ['true'] }], run: { kind: 'command' },
  })));

  return { stored, call, job };
}

describe('a commit\'s pack', () => {
  test('is kept under its packer: an earlier client finds its own, and this client never takes one an earlier client made', async () => {
    const earlier = new Map([[`packs/proj/${SHA}.root.pack`, 'the first client\'s pack'], [`packs/proj/${SHA}.root.p2.pack`, 'a pack with no boundary']]);
    const { stored, call, job } = deployment('commit', earlier);
    const current = `/packs/proj/${SHA}/root?packer=${String(PACKER)}`;
    const before = { first: await call('HEAD', `/packs/proj/${SHA}/root`), second: await call('HEAD', `/packs/proj/${SHA}/root?packer=2`), current: await call('HEAD', current), job: await job({ packer: PACKER }) };
    const put = await call('PUT', current, 'this client\'s pack');

    expect({ before, put, after: await job({ packer: PACKER }), earlierJobs: [await job(), await job({ packer: 2 })], keys: [...stored.objects.keys()].sort() }).toEqual({
      before: { first: 200, second: 200, current: 404, job: 409 }, put: 200, after: 200, earlierJobs: [200, 200],
      keys: [`packs/proj/${SHA}.root.p2.pack`, `packs/proj/${SHA}.root.p${String(PACKER)}.pack`, `packs/proj/${SHA}.root.pack`],
    });
  });

  test('is kept under its shallow boundary, so a shallow clone\'s pack is never taken for one with more history (#34)', async () => {
    const edge = 'b'.repeat(40);
    const { call, job } = deployment('full');
    const pack = `/packs/proj/${SHA}/root?packer=${String(PACKER)}`;
    const put = await call('PUT', `${pack}&shallow=${edge}`, 'a depth-1 clone\'s pack');
    const held = { full: await call('HEAD', pack), shallow: await call('HEAD', `${pack}&shallow=${edge}`) };

    expect({ put, held, jobs: { full: await job({ packer: PACKER }), shallow: await job({ packer: PACKER, shallow: [edge] }) } })
      .toEqual({ put: 200, held: { full: 404, shallow: 200 }, jobs: { full: 409, shallow: 200 } });
  });
});
