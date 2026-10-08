import { describe, expect, test } from 'bun:test';
import { PROTOCOL } from '../../src/protocol';
import { ArmadaTasks } from '../src/tasks';
import worker from '../src/worker';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

/** A deployment whose R2 is in memory, and a request to it. */
function deployment() {
  const artifacts = bucket();
  const registry = new ArmadaTasks(state().ctx, world({}));
  const env = world({ ARMADA_TOKEN: TOKEN, ARTIFACTS: artifacts, TASKS: namespace(() => registry) });
  const ask = async (path: string, method: string, body?: string | Uint8Array) => {
    const answer = await worker.fetch(new Request(`https://armada.test${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': String(PROTOCOL) } }), env);

    return [answer.status, answer.headers.get('content-type')?.includes('json') === true ? await answer.json() : null];
  };

  return { artifacts, ask, registry };
}

const digestOf = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

describe('a push', () => {
  test('points each id at its bundle, refuses an id another project owns, and a bundle not uploaded', async () => {
    const { ask, registry } = deployment();
    const bytes = new TextEncoder().encode('export {};\n');
    const digest = digestOf(bytes);
    const missing = 'f'.repeat(64);

    const before = await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: digest, ids: ['square'] }));
    const uploaded = await ask(`/bundles/${digest}`, 'PUT', bytes);
    const pushed = await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: digest, ids: ['square', 'greet'] }));
    const taken = await ask('/tasks', 'POST', JSON.stringify({ project: 'two', bundle: digest, ids: ['square'] }));
    const absent = await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: missing, ids: ['square'] }));

    expect({ before, uploaded, pushed, taken, absent, square: (await registry.entryOf('square'))?.bundle }).toEqual({
      before: [409, { error: `upload the bundle ${digest} first` }],
      uploaded: [200, { stored: digest }],
      pushed: [200, { pushed: 2 }],
      taken: [409, { error: 'the task id square belongs to the project one' }],
      absent: [409, { error: `upload the bundle ${missing} first` }],
      square: digest,
    });
  });

  test('deletes the bundles no id points to once they are a week old, and keeps the rest', async () => {
    const { artifacts, ask } = deployment();
    const [old, recent, current] = ['old', 'recent', 'current'].map((text) => new TextEncoder().encode(`export const v = '${text}';\n`));
    const digests = [old, recent, current].map((bytes) => digestOf(bytes ?? new Uint8Array()));

    for (const [at, bytes] of [old, recent, current].entries()) await ask(`/bundles/${digests[at] ?? ''}`, 'PUT', bytes);
    const aged = artifacts.kept.get(`code/${digests[0] ?? ''}.mjs`);

    if (aged !== undefined) artifacts.kept.set(`code/${digests[0] ?? ''}.mjs`, { ...aged, uploaded: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: digests[2], ids: ['square'] }));

    expect(digests.map((digest) => artifacts.objects.has(`code/${digest ?? ''}.mjs`))).toEqual([false, true, true]);
  });

  test('records the bundle\'s runtime, node by default, and a re-push switches it', async () => {
    const { ask, registry } = deployment();
    const bytes = new TextEncoder().encode('print(1)\n');
    const digest = digestOf(bytes);

    await ask(`/bundles/${digest}`, 'PUT', bytes);
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: digest, ids: ['square'] }));
    const node = await registry.entryOf('square');
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: digest, ids: ['square'], runtime: 'python' }));
    const python = await registry.entryOf('square');

    expect({ node: node?.runtime, python: python?.runtime }).toEqual({ node: 'node', python: 'python' });
  });

  test('drops the ids its project no longer exports, and the bundle they ran from once it is a week old', async () => {
    const { artifacts, ask, registry } = deployment();
    const [first, second] = ['first', 'second'].map((text) => new TextEncoder().encode(`export const v = '${text}';\n`));
    const [one, two] = [first, second].map((bytes) => digestOf(bytes ?? new Uint8Array()));

    await ask(`/bundles/${one ?? ''}`, 'PUT', first);
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: one, ids: ['old-name', 'kept'] }));
    await ask(`/bundles/${two ?? ''}`, 'PUT', second);
    const aged = artifacts.kept.get(`code/${one ?? ''}.mjs`);

    if (aged !== undefined) artifacts.kept.set(`code/${one ?? ''}.mjs`, { ...aged, uploaded: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: two, ids: ['new-name', 'kept'] }));

    expect({ old: await registry.entryOf('old-name'), renamed: (await registry.entryOf('new-name'))?.bundle, kept: (await registry.entryOf('kept'))?.bundle, first: artifacts.objects.has(`code/${one ?? ''}.mjs`) })
      .toEqual({ old: undefined, renamed: two, kept: two, first: false });
  });
});
