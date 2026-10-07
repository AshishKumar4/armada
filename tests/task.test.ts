import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { INLINE_BYTES, JobSpecSchema, type Outcome } from '../src/protocol';
import { Armada } from '../src/sdk';
import { cmd, fn, MapError, recipe, type Result } from '../src/index';
import { encode, greet, lie, refuse, square } from './fixtures/tasks';

/**
 * A deployment that runs each task on this machine as a container would: a function's bundle under `node`, a
 * command's argv, each with the item in `ARMADA_ITEM` and its output to `ARMADA_OUT`. Tasks at `lose` are lost.
 */
function localFleet(lose: readonly number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'armada-fleet-'));
  const bundles = new Map<string, Uint8Array>();
  const outputs = new Map<string, Uint8Array>();
  const jobs = new Map<string, { spec: v.InferOutput<typeof JobSpecSchema>; events: Outcome[]; running: Promise<void>[]; open: boolean }>();
  const seen: string[] = [];
  const run = (id: string, index: number) => {
    const job = jobs.get(id);
    const task = job?.spec.items[index];

    if (job === undefined || task === undefined) return;
    job.running.push((async () => {
      if (lose.includes(index)) {
        job.events.push({ index, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: 'v1', attempt: 2, tail: 'the container went quiet', output: false });

        return;
      }
      const out = join(dir, `${id}-${String(index)}.out`);
      const argv = job.spec.run.kind === 'fn' ? ['node', join(dir, `${job.spec.run.bundle}.mjs`)] : task.argv ?? [];
      const ran = Bun.spawn(argv, { env: { ...process.env, ARMADA_ITEM: JSON.stringify(task.item), ARMADA_INDEX: String(index), ARMADA_ATTEMPT: '1', ARMADA_OUT: out }, stdout: 'pipe', stderr: 'pipe' });
      const exitCode = await ran.exited;
      const tail = await new Response(ran.stdout).text() + await new Response(ran.stderr).text();
      const kept = job.spec.output || job.spec.run.kind === 'fn' ? readFileSync(out, { flag: 'a+' }) : null;
      const text = kept === null || kept.byteLength > INLINE_BYTES ? undefined : new TextDecoder('utf-8', { fatal: false }).decode(kept);

      if (kept !== null) outputs.set(`${id}/${String(index)}`, new Uint8Array(kept));
      job.events.push({ index, kind: 'exited', exitCode, seconds: 0.1, vessel: 'v1', attempt: 1, tail, output: kept !== null, ...text === undefined || text.includes('\uFFFD') ? {} : { value: text } });
    })());
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const [, head, id, tail, index] = pathname.split('/');

      seen.push(`${request.method} /${head ?? ''}${tail === undefined ? '' : `/${tail}`}`);

      if (head === 'bundles' && id !== undefined) {
        if (request.method === 'HEAD') return new Response(null, { status: bundles.has(id) ? 200 : 404 });
        const bytes = new Uint8Array(await request.arrayBuffer());

        bundles.set(id, bytes);
        writeFileSync(join(dir, `${id}.mjs`), bytes);

        return Response.json({ stored: id });
      }

      if (head !== 'jobs') return Response.json({ error: 'not found' }, { status: 404 });

      if (id === undefined) {
        const spec = v.parse(JobSpecSchema, await request.json());
        const created = `j${String(jobs.size + 1)}`;

        jobs.set(created, { spec, events: [], running: [], open: spec.open });
        spec.items.forEach((_, at) => { run(created, at); });

        return Response.json({ id: created });
      }
      const job = jobs.get(id);

      if (job === undefined) return Response.json({ error: 'no such job' }, { status: 404 });

      if (tail === 'items' && request.method === 'POST') {
        const { items } = v.parse(v.object({ items: JobSpecSchema.entries.items }), await request.json());
        const first = job.spec.items.length;

        job.spec.items.push(...items);
        items.forEach((_, at) => { run(id, first + at); });

        return Response.json({ added: items.length });
      }

      if (tail === 'close') {
        job.open = false;

        return Response.json({ closed: id });
      }

      if (tail === 'cancel') {
        job.open = false;

        return Response.json({ cancelled: id });
      }

      if (tail === 'items' && request.method === 'GET') return Response.json({ items: job.spec.items.map((task) => task.item) });

      if (tail === 'events') {
        await Promise.all(job.running);
        const after = Number(new URL(request.url).searchParams.get('after') ?? '0');

        return Response.json({ events: job.events.slice(after).map((outcome, at) => ({ seq: after + at + 1, outcome })), done: !job.open && job.events.length === job.spec.items.length });
      }

      if (tail === 'tasks' && index !== undefined) {
        const bytes = outputs.get(`${id}/${index}`);

        return bytes === undefined ? Response.json({ error: 'not found' }, { status: 404 }) : new Response(bytes);
      }

      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });

  return { armada: new Armada({ url: server.url.href, token: 't', account: 'a' }), jobs, seen, stop: async () => { await server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}

const fleets: { stop: () => Promise<void> }[] = [];

afterAll(async () => { await Promise.all(fleets.map(async (fleet) => { await fleet.stop(); })); });

function fleet(lose: readonly number[] = []) {
  const made = localFleet(lose);

  fleets.push(made);

  return made;
}

const brief = <I, O>(result: Result<I, O>) => ({ index: result.index, kind: result.kind, ...'value' in result ? { value: result.value } : {}, ...'error' in result ? { error: `${result.error.name}: ${result.error.message}` } : {} });

describe('a function', () => {
  test('runs in a container from its bundle, its imports with it, its schemas checked there, and its value typed', async () => {
    const { armada, seen } = fleet();
    const squares: number[] = await square.map([1, 2, 3], { armada }).values();
    const greeting: { text: string } = await greet.run({ name: 'ada' }, { armada });
    const bytes: Uint8Array = await encode.run('hi', { armada });

    expect({ squares, greeting, bytes: [...bytes], uploads: seen.filter((each) => each.startsWith('PUT /bundles')).length })
      .toEqual({ squares: [1, 4, 9], greeting: { text: 'hello, ada' }, bytes: [104, 105], uploads: 3 });
  });

  test('that throws, answers what its schema refuses, or is lost is a result of its own, and values() rejects with all of them', async () => {
    const { armada } = fleet([1]);
    const thrown = await refuse.map([7, 8], { armada }).settled();
    const lied = await lie.map([3], { armada }).settled();
    const rejected = await square.map([2, 3], { armada }).values().catch((error: unknown) => error);

    expect({
      thrown: thrown.map(brief),
      exits: thrown.map((result) => result.meta.exitCode),
      lied: lied.map((result) => [result.kind, 'error' in result ? result.error.name : '']),
      rejected: rejected instanceof MapError ? rejected.results.map(brief) : rejected,
    }).toEqual({
      thrown: [{ index: 0, kind: 'error', error: 'RangeError: no 7' }, { index: 1, kind: 'lost' }],
      exits: [1, -1],
      lied: [['error', 'SchemaError']],
      rejected: [{ index: 0, kind: 'ok', value: 4 }, { index: 1, kind: 'lost' }],
    });
  });

  test('refuses an item its input schema refuses before anything is sent', async () => {
    const { armada, seen } = fleet();
    const refused = await greet.map([{ name: 'ada' }, { name: '' }], { armada }).values().catch((error: unknown) => String(error));

    expect({ refused, jobs: seen.filter((each) => each === 'POST /jobs') }).toEqual({ refused: 'SchemaError: item 1 does not fit its schema: name: Invalid length: Expected >=1 but received 0', jobs: [] });
  });

  test('that its module does not export is refused with what to do', async () => {
    const { armada } = fleet();
    const hidden = fn(import.meta, (n: number) => n);

    expect(await hidden.map([1], { armada }).values().catch((error: unknown) => String(error))).toContain('export the function from');
  });
});

describe('a command', () => {
  test('builds its argv per item, and answers its output as text, bytes or JSON its schema checks, or its exit as an error', async () => {
    const { armada } = fleet();
    const write = (n: number) => ['sh', '-c', 'printf "{\\"n\\": %s}" "$1" > "$ARMADA_OUT"; exit "$2"', 'write', String(n), String(n > 2 ? 3 : 0)];
    const json = await cmd(recipe(), write, { output: v.object({ n: v.number() }) }).map([1, 2, 3], { armada }).settled();
    const text: string = await cmd(recipe(), (word: string) => ['sh', '-c', 'printf %s "$1" > "$ARMADA_OUT"', 'echo', word], { output: 'text' }).run('a b; c', { armada });
    const bytes = await cmd(recipe(), () => ['sh', '-c', 'printf "\\377\\376" > "$ARMADA_OUT"'], { output: 'bytes' }).run(null, { armada });
    const none: null = await cmd(recipe(), () => ['true']).run(null, { armada });

    expect({ json: json.map(brief), text, bytes: [...bytes], none }).toEqual({
      json: [{ index: 0, kind: 'ok', value: { n: 1 } }, { index: 1, kind: 'ok', value: { n: 2 } }, { index: 2, kind: 'error', error: 'Exit: the command exited 3' }],
      text: 'a b; c',
      bytes: [255, 254],
      none: null,
    });
  });
});

describe('a job\'s items', () => {
  test('stream from an async iterable into an open job in batches, and come back in input order through ordered()', async () => {
    const { armada, seen, jobs } = fleet();
    const items = async function* numbers() {
      for (let n = 0; n < 1_100; n += 1) yield n;
    };
    const ordered: number[] = [];

    for await (const result of cmd(recipe(), (n: number) => ['true', String(n)]).map(items(), { armada }).ordered()) ordered.push(result.item);
    const requests = seen.filter((each) => each !== 'GET /jobs/events');

    expect({
      ordered: ordered.every((n, at) => n === at) && ordered.length === 1_100, sent: jobs.get('j1')?.spec.items.length,
      first: requests[0], last: requests.at(-1), between: [...new Set(requests.slice(1, -1))],
    }).toEqual({ ordered: true, sent: 1_100, first: 'POST /jobs', last: 'POST /jobs/close', between: ['POST /jobs/items'] });
  }, 60_000);

  test('from a source that waits are sent on a timer, and a cancel ends the job without waiting on the source', async () => {
    const { armada } = fleet();
    const items = async function* stalls() {
      yield 'a';
      await new Promise(() => undefined);
    };
    const job = cmd(recipe(), (word: string) => ['echo', word]).map(items(), { armada });
    const [first] = await (async () => {
      for await (const result of job) return [result];

      return [];
    })();

    await job.cancel();

    expect({ first: first?.item, settled: (await job.settled()).map(brief) }).toEqual({ first: 'a', settled: [{ index: 0, kind: 'ok', value: null }] });
  });

  test('of a job read by its id come from the job, read again as it grows', async () => {
    const { armada } = fleet();
    const echo = cmd(recipe(), (word: string) => ['echo', word]);
    let more: () => void = () => undefined;
    const later = new Promise<void>((resolve) => { more = resolve; });
    const items = async function* twoParts() {
      yield 'a';
      await later;
      yield 'b';
    };
    const streamed = echo.map(items(), { armada });
    const attached = echo.job(await streamed.id, { armada });
    const seen: [number, string][] = [];

    for await (const result of attached) {
      seen.push([result.index, result.item]);
      more();
    }

    expect(seen).toEqual([[0, 'a'], [1, 'b']]);
  });
});
