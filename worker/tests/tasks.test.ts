import { describe, expect, test } from 'bun:test';
import { PROTOCOL } from '../../src/protocol';
import { ArmadaTasks } from '../src/tasks';
import worker from '../src/worker';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

/** A deployment whose R2 is in memory, and a request to it; each of `held` holds the next R2 delete until it returns. */
function deployment(held: (() => Promise<void>)[] = []) {
  const stored = bucket();
  const remove = stored.delete;

  const artifacts = Object.assign(stored, {
    delete: async (keys: string | readonly string[]) => {
      await held.shift()?.();
      await remove(keys);
    },
  });

  const registry = new ArmadaTasks(state().ctx, world({ ARTIFACTS: artifacts }));
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

  test('deletes a bundle once no id runs from it and no open job holds it, and keeps the rest', async () => {
    const { artifacts, ask, registry } = deployment();
    const [first, second, third] = ['first', 'second', 'third'].map((text) => new TextEncoder().encode(`export const v = '${text}';\n`));
    const [one = '', two = '', three = ''] = [first, second, third].map((bytes) => digestOf(bytes ?? new Uint8Array()));
    const present = () => [one, two, three].map((digest) => artifacts.objects.has(`code/${digest}.mjs`));

    for (const [digest, bytes] of [[one, first], [two, second], [three, third]] as const) await ask(`/bundles/${digest}`, 'PUT', bytes);
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: one, ids: ['square'] }));
    // A job runs from the first bundle while a push moves its id to the second, and another to the third.
    expect(await registry.pin('job-1', one)).toBeNull();
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: two, ids: ['square'] }));
    const running = present();

    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: three, ids: ['square'] }));
    const pushed = present();

    await registry.unpin('job-1');

    expect({ running, pushed, ended: present() }).toEqual({ running: [true, true, true], pushed: [true, false, true], ended: [false, false, true] });
  });

  test('takes no push or job of a bundle while it is deleted, and says it is not there until it is uploaded again', async () => {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const { ask, registry } = deployment([async () => { reached.resolve(); await released.promise; }]);
    const [first, second] = ['first', 'second'].map((text) => new TextEncoder().encode(`export const v = '${text}';\n`));
    const [one = '', two = ''] = [first, second].map((bytes) => digestOf(bytes ?? new Uint8Array()));

    await ask(`/bundles/${one}`, 'PUT', first);
    await ask(`/bundles/${two}`, 'PUT', second);
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: one, ids: ['square'] }));
    // The push that retires the first bundle is deleting it when another project pushes it, and a job starts from it.
    const retiring = ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: two, ids: ['square'] }));

    await reached.promise;
    const during = { push: await ask('/tasks', 'POST', JSON.stringify({ project: 'two', bundle: one, ids: ['cube'] })), job: await registry.pin('job-1', one) };

    released.resolve();
    await retiring;
    const there = (await ask(`/bundles/${one}`, 'HEAD'))[0];

    await ask(`/bundles/${one}`, 'PUT', first);
    const again = await ask('/tasks', 'POST', JSON.stringify({ project: 'two', bundle: one, ids: ['cube'] }));

    expect({ during, there, again, cube: (await registry.entryOf('cube'))?.bundle }).toEqual({
      during: { push: [409, { error: `upload the bundle ${one} first` }], job: `upload the bundle ${one} first` }, there: 404, again: [200, { pushed: 1 }], cube: one,
    });
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

  test('drops the ids its project no longer exports, and the bundle they ran from', async () => {
    const { artifacts, ask, registry } = deployment();
    const [first, second] = ['first', 'second'].map((text) => new TextEncoder().encode(`export const v = '${text}';\n`));
    const [one, two] = [first, second].map((bytes) => digestOf(bytes ?? new Uint8Array()));

    await ask(`/bundles/${one ?? ''}`, 'PUT', first);
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: one, ids: ['old-name', 'kept'] }));
    await ask(`/bundles/${two ?? ''}`, 'PUT', second);
    await ask('/tasks', 'POST', JSON.stringify({ project: 'one', bundle: two, ids: ['new-name', 'kept'] }));

    expect({ old: await registry.entryOf('old-name'), renamed: (await registry.entryOf('new-name'))?.bundle, kept: (await registry.entryOf('kept'))?.bundle, first: artifacts.objects.has(`code/${one ?? ''}.mjs`) })
      .toEqual({ old: undefined, renamed: two, kept: two, first: false });
  });
});
