import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { hex, JobSpecSchema, PACKER, PROTOCOL } from '../../src/protocol';
import { packKey } from '../src/env';
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

/** What R2 throws for a write to a key written within the last second: it takes one write a second to a key. */
const LIMITED = 'put: Reduce your concurrent request rate for the same object. (10058)';

// #62: a run at one of Dew's commits lost every outcome when another run of the commit was storing the same pack.
describe('a pack or bundle two clients store at once', () => {
  test('answers stored once the other\'s object is there, which every writer stores alike, and 429 while it never comes', async () => {
    const waits: number[] = [];

    Object.assign(globalThis, { scheduler: { wait: async (ms: number) => { waits.push(ms); } } });
    const { stored, call } = deployment('commit');
    const key = await packKey('proj', { sha: SHA, base: 'root', packer: PACKER });
    const pack = `/packs/proj/${SHA}/root?packer=${String(PACKER)}`;
    const put = stored.put;
    // Each write R2 refuses, and whether the other client's write lands a second later.
    const refusals: boolean[] = [];
    const lands: (() => Promise<void>)[] = [];
    const head = stored.head;

    stored.put = async (at, body, options) => {
      const other = refusals.shift();

      if (other === undefined) return await put(at, body, options);

      if (other) lands.push(async () => { await put(at, 'the other client\'s', options); });
      throw new Error(LIMITED);
    };

    stored.head = async (at) => {
      await lands.shift()?.();

      return await head(at);
    };

    refusals.push(true);
    const taken = [await call('PUT', pack, 'this client\'s pack'), stored.text(key), waits.splice(0).length];

    stored.objects.delete(key);
    refusals.push(false);
    const never = [await call('PUT', pack, 'this client\'s pack'), stored.text(key), waits.splice(0).length];
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('a bundle')));

    refusals.push(true);
    const bundle = await call('PUT', `/bundles/${digest}`, 'a bundle');

    stored.put = async () => { throw new Error('put: We encountered an internal error. Please try again. (10001)'); };

    const failed = await call('PUT', pack, 'this client\'s pack');

    expect({ taken, never, bundle, failed }).toEqual({ taken: [200, 'the other client\'s', 1], never: [429, undefined, 30], bundle: 200, failed: 500 });
  });

  test('a large pack completes, or gives its parts back once the other client\'s pack is there', async () => {
    Object.assign(globalThis, { scheduler: { wait: async () => undefined } });
    const { stored, call } = deployment('commit');
    const key = await packKey('proj', { sha: SHA, base: 'root', packer: PACKER });
    const aborted: string[] = [];
    let others = 1;

    Object.assign(stored, {
      createMultipartUpload: async () => ({ uploadId: 'u1' }),
      resumeMultipartUpload: (at: string, upload: string) => ({
        uploadPart: async (partNumber: number) => ({ partNumber, etag: `e${String(partNumber)}` }),
        complete: async () => {
          if (others > 0) {
            others -= 1;
            await stored.put(at, 'the other client\'s');
            throw new Error(LIMITED.replace('put', 'completeMultipartUpload'));
          }

          await stored.put(at, 'this client\'s pack');
        },
        abort: async () => { aborted.push(upload); },
      }),
    });

    const pack = `/packs/proj/${SHA}/root?packer=${String(PACKER)}&upload=u1`;
    const completed = await call('POST', pack, JSON.stringify({ parts: [{ partNumber: 1, etag: 'e1' }] }));

    expect({ completed, aborted, text: stored.text(key) }).toEqual({ completed: 200, aborted: ['u1'], text: 'the other client\'s' });
  });
});
