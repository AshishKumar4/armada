import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { INLINE_BYTES, JobSpecSchema, MAX_ARGUMENT_BYTES, PushSchema, refusal, type Outcome } from '../src/protocol';
import { Armada } from '../src/sdk';
import { MapError, push, recipe, sh, task, type Json, type Result } from '../src/index';
import { commandTask } from '../src/task';
import { bundleTasks } from '../src/push';
import { failureOf, settled } from './fakes';
import { echo, encode, flaky, fromFile, greet, keyed, lie, lookalike, refuse, remembered, shout, square, touch, twoBytes, write } from './fixtures/armada/tasks';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** The most tasks the local fleet runs at once, as a job's pool bounds its containers. Run as each arrived, a stream of
 *  1,100 items ran up to 709 processes at once, past a 4-vCPU CI container's 1,024 open files (EMFILE, 2026-10-28). */
const LOCAL_POOL = 16;

/**
 * A deployment that runs each task on this machine as a container would: a pushed task's bundle under `node`, a
 * command's argv, each with the item in `ARMADA_ITEM` and its output to `ARMADA_OUT`, LOCAL_POOL at once. Tasks at
 * `lose` are lost. It refuses what the Worker refuses.
 */
function localFleet(lose: readonly number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'armada-fleet-'));
  // Free places in the pool, and the tasks waiting for one.
  let free = LOCAL_POOL;
  const queued: (() => void)[] = [];
  const bundles = new Map<string, Uint8Array>();
  const ids = new Map<string, string>();
  const outputs = new Map<string, Uint8Array>();
  const jobs = new Map<string, { spec: v.InferOutput<typeof JobSpecSchema>; events: Outcome[]; running: Promise<void>[]; open: boolean }>();
  const seen: string[] = [];

  const run = (id: string, index: number) => {
    const job = jobs.get(id);
    const entry = job?.spec.items[index];

    if (job === undefined || entry === undefined) return;
    job.running.push((async () => {
      if (lose.includes(index)) {
        job.events.push({ index, kind: 'failed', reason: 'lost', exitCode: -1, seconds: 0, vessel: 'v1', attempt: 2, tail: 'the container went quiet', output: false });

        return;
      }

      const out = join(dir, `${id}-${String(index)}.out`);
      const marker = join(dir, `${id}-${String(index)}.answer`);
      const { run: spec } = job.spec;
      const argv = spec.kind === 'task' ? ['node', join(dir, `${spec.bundle ?? ''}.mjs`)] : entry.argv ?? [];

      if (free > 0) free -= 1;
      else await new Promise<void>((resolve) => { queued.push(resolve); });
      let exitCode: number;
      let tail: string;

      try {
        const ran = Bun.spawn(argv, {
          env: { ...process.env, ARMADA_ITEM: JSON.stringify(entry.item), ARMADA_INDEX: String(index), ARMADA_ATTEMPT: '1', ARMADA_OUT: out, ARMADA_ANSWER: marker, ARMADA_TASK: spec.kind === 'task' ? spec.id : '' },
          stdout: 'pipe', stderr: 'pipe',
        });

        exitCode = await ran.exited;
        tail = await new Response(ran.stdout).text() + await new Response(ran.stderr).text();
      } finally {
        // Its place goes to the next task waiting, else back to the pool.
        const next = queued.shift();

        if (next === undefined) free += 1;
        else next();
      }

      const kept = job.spec.output || spec.kind === 'task' ? readFileSync(out, { flag: 'a+' }) : null;
      const text = kept === null || kept.byteLength > INLINE_BYTES ? undefined : new TextDecoder('utf-8', { fatal: false }).decode(kept);
      const [said, error] = spec.kind === 'task' ? readFileSync(marker, { flag: 'a+' }).toString().split('\n') : [];

      if (kept !== null) outputs.set(`${id}/${String(index)}`, new Uint8Array(kept));
      job.events.push({
        index, kind: 'exited', exitCode, seconds: 0.1, vessel: 'v1', attempt: 1, tail, output: kept !== null, value: text === undefined || text.includes('\uFFFD') ? undefined : text,
        answer: said === 'value' || said === 'command' ? said : undefined, error,
      });
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

      if (head === 'tasks' && request.method === 'POST') {
        const pushed = v.parse(PushSchema, await request.json());

        for (const each of pushed.ids) ids.set(each, pushed.bundle);

        return Response.json({ pushed: pushed.ids.length });
      }

      if (head !== 'jobs') return Response.json({ error: 'not found' }, { status: 404 });

      if (id === undefined) {
        const spec = v.parse(JobSpecSchema, await request.json());
        const refused = refusal(spec.run, spec.items, spec);

        if (refused !== null) return Response.json({ error: refused }, { status: 400 });

        if (spec.run.kind === 'task') {
          const bundle = spec.run.bundle ?? ids.get(spec.run.id);

          if (bundle === undefined) return Response.json({ error: `no task ${spec.run.id} is pushed` }, { status: 409 });
          spec.run = { ...spec.run, bundle };
        }

        const created = `j${String(jobs.size + 1)}`;

        jobs.set(created, { spec, events: [], running: [], open: spec.open });

        for (const at of spec.items.keys()) run(created, at);

        return Response.json({ id: created });
      }

      const job = jobs.get(id);

      if (job === undefined) return Response.json({ error: 'no such job' }, { status: 404 });

      if (tail === 'items' && request.method === 'POST') {
        const { items } = v.parse(v.object({ items: JobSpecSchema.entries.items }), await request.json());
        const refused = refusal(job.spec.run, items, job.spec);

        if (refused !== null) return Response.json({ error: refused }, { status: 400 });
        const first = job.spec.items.length;

        job.spec.items.push(...items);

        for (const at of items.keys()) run(id, first + at);

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

      if (tail === 'items' && request.method === 'GET') return Response.json({ items: job.spec.items.map((each) => each.item) });

      if (tail === 'events') {
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

afterAll(async () => { await Promise.all(fleets.map(async (made) => { await made.stop(); })); });

/** A local deployment with the fixtures' project pushed to it. */
async function fleet(lose: readonly number[] = []) {
  const made = localFleet(lose);

  fleets.push(made);
  await push(made.armada, FIXTURES);

  return made;
}

/** A result as a test compares it: its index and kind, its value or its error's name and message. */
interface Brief<O> {
  readonly index: number;
  readonly kind: Result<Json, O>['kind'];
  readonly value?: O;
  readonly error?: string;
}

const brief = <I, O>(result: Result<I, O>): Brief<O> => ({
  index: result.index, kind: result.kind, value: 'value' in result ? result.value : undefined, error: 'error' in result ? `${result.error.name}: ${result.error.message}` : undefined,
});

describe('a pushed task', () => {
  test('runs from the project\'s bundle by its id, its imports with it, its schemas checked in the container, its value typed', async () => {
    const { armada, seen } = await fleet();
    const squares: number[] = await square.map([1, 2, 3], { armada });
    const greeting: { text: string } = await greet.run({ name: 'ada' }, { armada });
    const bytes: Uint8Array = await encode.run('hi', { armada });

    expect({ squares, greeting, bytes: [...bytes], pushes: seen.filter((each) => each === 'POST /tasks').length })
      .toEqual({ squares: [1, 4, 9], greeting: { text: 'hello, ada' }, bytes: [104, 105], pushes: 1 });
  });

  test('that throws, answers what its schema refuses, or is lost is a result of its own, and map rejects with all of them', async () => {
    const { armada } = await fleet([1]);
    const thrown = await refuse.stream([7, 8], { armada }).settled();
    const lied = await lie.stream([3], { armada }).settled();
    const rejected = await failureOf(square.map([2, 3], { armada }));

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
    const { armada, seen } = await fleet();
    const refused = await settled(greet.map([{ name: 'ada' }, { name: '' }], { armada }));

    expect({ refused, jobs: seen.filter((each) => each === 'POST /jobs') }).toEqual({ refused: 'SchemaError: item 1 does not fit its schema: name: Invalid length: Expected >=1 but received 0', jobs: [] });
  });

  test('whose id no push recorded is refused with what to do', async () => {
    const { armada } = await fleet();
    const unpushed = task({ id: 'nowhere', run: (n: number) => n });

    expect(await settled(unpushed.map([1], { armada }))).toContain('no task nowhere is pushed');
  });

  test('a push refuses two tasks that share an id', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-twice-'));

    try {
      mkdirSync(join(scratch, 'armada'));
      writeFileSync(join(scratch, 'armada.config.ts'), `export default { project: 'twice' };\n`);
      const source = (name: string) => `import { task } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'index.ts'))};\nexport const ${name} = task({ id: 'same', run: (n: number) => n });\n`;

      writeFileSync(join(scratch, 'armada', 'a.ts'), source('a'));
      writeFileSync(join(scratch, 'armada', 'b.ts'), source('b'));

      // Refused before anything is sent: a client of no deployment does.
      expect(await settled(push(new Armada({ url: 'http://127.0.0.1:9', token: 't', account: '' }), scratch))).toContain('two tasks have the id same');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a push of one task under two names', () => {
  test('takes it once, whether a file exports it twice or an index exports it again', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-alias-'));

    try {
      mkdirSync(join(scratch, 'armada'));
      writeFileSync(join(scratch, 'armada', 'job.ts'), `import { task } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'index.ts'))};\nexport const job = task({ id: 'one', run: (n: number) => n });\nexport { job as alias };\n`);
      writeFileSync(join(scratch, 'armada', 'index.ts'), `export { job } from './job';\n`);

      expect((await bundleTasks(scratch, ['armada'])).ids).toEqual(['one']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a push\'s bundle', () => {
  test('is the same bytes for the same task files, wherever the project is and whichever push made it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-bundle-'));
    const sdk = join(import.meta.dir, '..');

    const project = (where: string, name: string) => {
      const root = join(scratch, where);

      mkdirSync(join(root, 'armada'), { recursive: true });
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      symlinkSync(sdk, join(root, 'node_modules', 'armada'));
      writeFileSync(join(root, 'armada.config.ts'), `export default { project: 'same' };\n`);
      writeFileSync(join(root, 'armada', 'square.ts'), `import { task } from 'armada';\nexport const square = task({ id: ${JSON.stringify(name)}, run: (n: number) => n * n });\n`);

      return root;
    };

    const digest = async (root: string) => new Bun.CryptoHasher('sha256').update((await bundleTasks(root, ['armada'])).bytes).digest('hex');

    try {
      const [near, far, other] = [project('a', 'square'), project('b/c/d', 'square'), project('e', 'cube')];

      expect({ again: await digest(near) === await digest(near), elsewhere: await digest(near) === await digest(far), changed: await digest(near) === await digest(other) })
        .toEqual({ again: true, elsewhere: true, changed: false });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a command task', () => {
  // Five jobs one after another, each waiting on the client's real poll for its results.
  test('runs the sh its body returns, every word escaped, and answers with its out file as text, bytes, JSON or null', async () => {
    const { armada } = await fleet();
    const json = await write.stream([1, 2, 3], { armada }).settled();
    const text: string = await echo.run('a b; c $(rm -rf /) \'q\'', { armada });
    const bytes: Uint8Array = await twoBytes.run(null, { armada });
    const none: null = await touch.run(1, { armada });
    const shouted: string = await shout.run('hi there', { armada });

    expect({ json: json.map(brief), text, bytes: [...bytes], none, shouted }).toEqual({
      json: [{ index: 0, kind: 'ok', value: { n: 1 } }, { index: 1, kind: 'ok', value: { n: 2 } }, { index: 2, kind: 'error', error: 'Exit: the command exited 3' }],
      text: 'a b; c $(rm -rf /) \'q\'',
      bytes: [255, 254],
      none: null,
      shouted: 'HI THERE',
    });
  }, 15_000);
});

describe('a command\'s argument', () => {
  test('longer than Linux starts a process with is refused by name before anything is sent', async () => {
    const { armada, seen } = await fleet();
    const command = commandTask(recipe().spec, (item: string) => ['sh', '-c', item]);
    const refused = await settled(command.map(['true', 'é'.repeat(65_536)], { armada }));

    expect({ refused, jobs: seen.filter((each) => each === 'POST /jobs') }).toEqual({
      refused: `Error: item 1's argument 2 is 131072 bytes, and Linux starts no process with one over ${String(MAX_ARGUMENT_BYTES)} (MAX_ARG_STRLEN): put that payload in a file the command reads`,
      jobs: [],
    });
  });
});

describe('a recipe given as a function', () => {
  test('is called on the machine that makes the job, never in a container', async () => {
    const { armada, jobs } = await fleet();

    expect({ value: await fromFile.run(1, { armada }), setup: [...jobs.values()].at(-1)?.spec.recipe.setup })
      .toEqual({ value: 2, setup: readFileSync(join(FIXTURES, 'greeting.ts'), 'utf8') });
  });
});

describe('a task\'s retries', () => {
  test('travel with its job, for the Worker to decide by', async () => {
    const { armada, jobs } = await fleet();

    await flaky.stream([1], { armada }).settled();

    expect([...jobs.values()].at(-1)?.spec.retries).toEqual({ attempts: 3, backoffSeconds: 0, exitCodes: [], errors: ['Flake'] });
  });
});

describe('a job\'s deadlines', () => {
  test('map jobs retain their six-hour deadline and gangs retain their five-minute start bound by default', async () => {
    const { armada, jobs } = await fleet();

    await echo.stream(['a'], { armada }).settled();

    expect([...jobs.values()].map(({ spec }) => [spec.deadline, spec.gangStartTimeout])).toEqual([[21600, 300]]);
  });

  test('an explicit task timeout must fit the deadline, including the six-hour default, before anything is sent', async () => {
    const { armada, seen } = await fleet();
    const command = commandTask(recipe().spec, () => ['true'], { timeout: 1800 });
    const tooLong = commandTask(recipe().spec, () => ['true'], { timeout: 21601 });
    const before = seen.length;

    expect(await settled(command.stream([1], { armada, deadline: 1799 }).settled())).toBe('Error: JobDeadlineTooShort: job deadline 1799 s is shorter than the task timeout 1800 s');
    expect(await settled(tooLong.stream([1], { armada }).settled())).toBe('Error: JobDeadlineTooShort: job deadline 21600 s is shorter than the task timeout 21601 s');
    expect(seen.length).toBe(before);
    await command.stream([1], { armada, deadline: 1800 }).settled();
  });

  test('the whole-job and gang-start bounds travel with an array submission and a streamed submission', async () => {
    const { armada, jobs } = await fleet();
    const options = { armada, deadline: 120, gangStartTimeout: 15 };

    await echo.stream(['a'], options).settled();
    await echo.stream((function* items() { yield 'b'; })(), options).settled();

    expect([...jobs.values()].map(({ spec }) => [spec.deadline, spec.gangStartTimeout])).toEqual([[120, 15], [120, 15]]);
  });
});

describe('a task\'s cache', () => {
  test('travels with its job, and a result says whether it ran', async () => {
    const { armada, jobs } = await fleet();
    const [result] = await remembered.stream([4], { armada }).settled();

    expect({ cache: [...jobs.values()].at(-1)?.spec.cache, value: result?.ok === true ? result.value : null, cached: result?.meta.cached }).toEqual({ cache: { days: 7 }, value: 8, cached: false });
  });
});

describe('a task\'s secrets', () => {
  test('travel by name with its job, reach its body from the container\'s environment, and locally from this machine\'s', async () => {
    const { armada, jobs } = await fleet();

    process.env['ARMADA_TEST_KEY'] = 'sk-1234';

    try {
      const remote = await keyed.run(null, { armada });

      expect({ remote, local: await keyed.local(null), names: [...jobs.values()].at(-1)?.spec.secrets }).toEqual({ remote: 7, local: 7, names: ['ARMADA_TEST_KEY'] });
    } finally {
      delete process.env['ARMADA_TEST_KEY'];
    }

    expect(await settled(keyed.local(null)))
      .toBe('Error: .local reads the secret ARMADA_TEST_KEY from this machine\'s environment, which lacks it');
  });
});

describe('a body\'s value shaped like a command', () => {
  test('comes back as the value it is, in a container and locally, and runs nothing', async () => {
    const { armada } = await fleet();
    const scratch = mkdtempSync(join(tmpdir(), 'armada-lookalike-'));
    const remote = join(scratch, 'remote');
    const local = join(scratch, 'local');

    try {
      expect({ remote: await lookalike.run(remote, { armada }), local: await lookalike.local(local), ran: [existsSync(remote), existsSync(local)] }).toEqual({
        remote: { script: `touch ${remote}`, text: 'not a command' }, local: { script: `touch ${local}`, text: 'not a command' }, ran: [false, false],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a task run locally', () => {
  test('gives the same values and errors on this machine, with no deployment', async () => {
    const thrown = await settled(refuse.local(3));
    const lied = await settled(lie.local(3));
    const failed = await settled(write.local(3));

    expect({
      square: await square.local(4), greet: await greet.local({ name: 'ada' }), text: await echo.local('a b; c'), json: await write.local(2),
      bytes: [...await twoBytes.local(null)], none: await touch.local(1), shouted: await shout.local('hi'), thrown, lied: lied.startsWith('SchemaError: the value does not fit its schema'), failed,
    }).toEqual({
      square: 16, greet: { text: 'hello, ada' }, text: 'a b; c', json: { n: 2 }, bytes: [255, 254], none: null, shouted: 'HI', thrown: 'RangeError: no 3', lied: true,
      failed: expect.stringContaining('ShellError: `printf \'{"n": %s}\' 3 > '),
    });
  });
});

describe('a job\'s items', () => {
  test('stream from an async iterable into an open job in batches, and come back in input order through ordered()', async () => {
    const { armada, seen, jobs } = await fleet();

    const items = async function* numbers() {
      for (let n = 0; n < 1_100; n += 1) yield n;
    };

    const ordered: number[] = [];

    seen.length = 0;

    for await (const result of touch.stream(items(), { armada }).ordered()) ordered.push(result.item);
    const requests = seen.filter((each) => each !== 'GET /jobs/events');

    expect({
      ordered: ordered.every((n, at) => n === at) && ordered.length === 1_100, sent: jobs.get('j1')?.spec.items.length,
      first: requests[0], last: requests.at(-1), between: [...new Set(requests.slice(1, -1))],
    }).toEqual({ ordered: true, sent: 1_100, first: 'POST /jobs', last: 'POST /jobs/close', between: ['POST /jobs/items'] });
  }, 60_000);

  test('from a source that waits are sent on a timer, and a cancel ends the job without waiting on the source', async () => {
    const { armada } = await fleet();

    const items = async function* stalls() {
      yield 'a';
      await new Promise(() => undefined);
    };

    const job = echo.stream(items(), { armada });

    const [first] = await (async () => {
      for await (const result of job) return [result];

      return [];
    })();

    await job.cancel();

    expect({ first: first?.item, settled: (await job.settled()).map(brief) }).toEqual({ first: 'a', settled: [{ index: 0, kind: 'ok', value: 'a' }] });
  });

  test('of a job read by its id come from the job, read again as it grows', async () => {
    const { armada } = await fleet();
    let more: () => void = () => undefined;
    const later = new Promise<void>((resolve) => { more = resolve; });

    const items = async function* twoParts() {
      yield 'a';
      await later;
      yield 'b';
    };

    const streamed = echo.stream(items(), { armada });
    const attached = echo.job(await streamed.id, { armada });
    const seen: [number, Json][] = [];

    for await (const result of attached) {
      seen.push([result.index, result.item]);
      more();
    }

    expect(seen).toEqual([[0, 'a'], [1, 'b']]);
  });

  test('one the job refuses, while the source waits, ends the stream with why and cancels the job', async () => {
    const { armada, seen } = await fleet();
    const never = Promise.withResolvers<never>();

    const items = async function* refusedThenStalls() {
      yield { gang: 2 };
      await never.promise;
    };

    const job = commandTask(recipe.debian().spec, () => ['true']).stream(items(), { armada, pool: 1 });
    const failed = await job.settled().then(() => false, () => true);

    expect({ failed, cancelled: seen.includes('POST /jobs/cancel') }).toEqual({ failed: true, cancelled: true });
  });

  test('reach their stream as each lands, while another item still runs', async () => {
    const { armada } = await fleet();
    const scratch = mkdtempSync(join(tmpdir(), 'armada-held-'));
    const held = join(scratch, 'go');
    const job = commandTask(recipe.debian().spec, (n: number) => (n === 0 ? ['true'] : ['sh', '-c', `while [ ! -f ${held} ]; do sleep 0.05; done`])).stream([0, 1], { armada });

    try {
      const iterator = job[Symbol.asyncIterator]();
      const first = await iterator.next();

      writeFileSync(held, '');
      const rest = await job.settled().then((all) => all.length, () => -1);

      expect({ first: first.done ? null : first.value.index, rest }).toEqual({ first: 0, rest: 2 });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('that are not JSON as they are, such as NaN, are refused before anything is sent', async () => {
    const { armada, jobs } = await fleet();
    const refused = await touch.map([1, Number.NaN], { armada }).then(() => false, () => true);

    expect({ refused, jobs: jobs.size }).toEqual({ refused: true, jobs: 0 });
  });

  test('of a job attached by its id are read once for a batch of results, not once each', async () => {
    const { armada, seen } = await fleet();
    const ran = touch.stream(Array.from({ length: 50 }, (_, n) => n), { armada });
    const done = await ran.settled();

    seen.length = 0;
    const attached = await touch.job(await ran.id, { armada }).settled();

    expect({ done: done.length, attached: attached.length, reads: seen.filter((each) => each === 'GET /jobs/items').length }).toEqual({ done: 50, attached: 50, reads: 1 });
  });
});

describe('sh', () => {
  test('hands each interpolation to the program as one literal word, and refuses one where the shell would expand it', async () => {
    const hostile = `$(echo pwned) "q" 'r' \\ ; |`;

    expect({
      word: await sh`printf '[%s]' ${hostile}`.text(),
      list: await sh`printf '[%s]' ${['a b', 'c']}`.text(),
      afterHeredoc: await sh`cat <<EOF
here
EOF
printf '[%s]' ${hostile} $((1 << 2))`.text(),
      escaped: await sh`printf '%s ' \\" ${'x'}`.text(),
      raw: await sh.raw`printf %s ${'$((6 * 7))'}`.text(),
    }).toEqual({ word: `[${hostile}]`, list: '[a b][c]', afterHeredoc: `here\n[${hostile}][4]`, escaped: '" x ', raw: '42' });

    for (const misplaced of [
      () => sh`echo "${hostile}"`,
      () => sh`echo '${hostile}'`,
      () => sh`cat <<EOF
${hostile}
EOF`,
      () => sh`cat <<'EOF'
${hostile}
EOF`,
    ]) expect(misplaced).toThrow();
  });

  test('takes a word where the shell reads plain words, and refuses one in quotes or a here-document, as the Python sh does', () => {
    const fixtures = v.parse(v.array(v.object({ script: v.string(), context: v.nullable(v.picklist(['quotes', 'heredoc'])) })), JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'sh-contexts.json'), 'utf8')));

    for (const { script, context } of fixtures) {
      const interpolate = () => sh(Object.assign([script, ''], { raw: [script, ''] }), 'word');

      if (context === null) expect(interpolate).not.toThrow();
      else expect(interpolate).toThrow();
    }
  });
});
