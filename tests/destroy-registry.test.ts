import { afterEach, describe, expect, test } from 'bun:test';
import { deleteImageWith, deleteSnapshotWith } from '../src/registry';
import { fakeFetch, settled } from './fakes';

const originalFetch = globalThis.fetch;

const digest = `sha256:${'a'.repeat(64)}`;

const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

afterEach(() => { globalThis.fetch = originalFetch; });

describe('exact registry references journalled by destroy', () => {
  test('journals a snapshot manifest before deleting only its recorded set, snapshot tag, and digest', async () => {
    const snapshot = `rootfs-snapshot-${await hex('owned-snapshot')}`;
    const set = `rootfs-set-${await hex('owned-set')}`;
    const events: string[] = [];

    globalThis.fetch = fakeFetch((request) => {
      const path = new URL(request.url).pathname;

      expect(request.headers.get('authorization')).toBe(`Basic ${btoa('user:fake')}`);

      if (path === '/v2/_catalog') return Response.json({ repositories: { 'account/snapshots': [snapshot, 'some-other-deployment'] } });

      if (request.method === 'GET') return Response.json({ annotations: { 'io.cloudflare.cloudchamber.snapshot_set_id': 'owned-set' } }, { headers: { 'docker-content-digest': digest } });
      events.push(`DELETE ${path}`);

      return new Response(null, { status: 204 });
    });

    expect(await deleteSnapshotWith('user:fake', 'owned-snapshot', async (ref) => { events.push(`remember ${ref}`); })).toEqual({ kind: 'deleted' });
    expect(events).toEqual([
      `remember ${digest}`, `DELETE /v2/account/snapshots/manifests/${set}`,
      `DELETE /v2/account/snapshots/manifests/${snapshot}`, `DELETE /v2/account/snapshots/manifests/${digest}`,
    ]);
  });

  test('a digest saved before a lost tag-delete response remains removable after the snapshot tag has disappeared', async () => {
    const snapshot = `rootfs-snapshot-${await hex('owned-snapshot')}`;
    const names = new Set([snapshot, digest]);
    const remembered: string[] = [];
    let interrupt = true;

    globalThis.fetch = fakeFetch((request) => {
      const path = new URL(request.url).pathname;
      const ref = path.split('/').at(-1) ?? '';

      if (path === '/v2/_catalog') return Response.json({ repositories: { 'account/snapshots': [...names] } });

      if (request.method === 'GET') return Response.json({ annotations: {} }, { headers: { 'docker-content-digest': digest } });
      names.delete(ref);

      if (ref === snapshot && interrupt) {
        interrupt = false;
        throw new Error('DELETE answer lost after the tag went');
      }

      return new Response(null, { status: 204 });
    });

    expect(await settled(deleteSnapshotWith('user:fake', 'owned-snapshot', async (ref) => { remembered.push(ref); }))).toContain('answer lost');
    expect(remembered).toEqual([digest]);
    expect(await deleteSnapshotWith('user:fake', 'owned-snapshot', async () => undefined)).toEqual({ kind: 'absent' });
    expect(await deleteSnapshotWith('user:fake', digest, async () => undefined)).toEqual({ kind: 'deleted' });
    expect(names.size).toBe(0);
  });

  test('deletes the exact inventoried built-image tag and digest, with no registry-wide credential or repository deletion', async () => {
    const events: string[] = [];
    const repository = 'account/armada-dew2-armadavessel';

    globalThis.fetch = fakeFetch((request) => {
      const path = new URL(request.url).pathname;

      if (request.method === 'GET') return Response.json({}, { headers: { 'docker-content-digest': digest } });
      events.push(`DELETE ${path}`);

      return new Response(null, { status: 204 });
    });

    expect(await deleteImageWith('user:fake', repository, 'owned-tag', async (ref) => { events.push(`remember ${ref}`); })).toEqual({ kind: 'deleted' });
    expect(events).toEqual([`remember ${digest}`, `DELETE /v2/${repository}/manifests/owned-tag`, `DELETE /v2/${repository}/manifests/${digest}`]);
  });

  test('an already absent image is a no-op without a DELETE or a new journal entry', async () => {
    const methods: string[] = [];
    const journal: string[] = [];

    globalThis.fetch = fakeFetch((request) => {
      methods.push(request.method);

      return new Response(null, { status: 404 });
    });

    expect(await deleteImageWith('user:fake', 'account/armada-dew2-armadavessel', 'owned-tag', async (ref) => { journal.push(ref); })).toEqual({ kind: 'absent' });
    expect(methods).toEqual(['GET']);
    expect(journal).toEqual([]);
  });
});
