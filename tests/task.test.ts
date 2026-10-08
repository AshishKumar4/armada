import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { INLINE_BYTES, JobSpecSchema, PushSchema, type Outcome } from '../src/protocol';
import { Armada } from '../src/sdk';
import { MapError, push, recipe, sh, task, type Result } from '../src/index';
import { bundleTasks } from '../src/push';
import { echo, encode, flaky, fromFile, greet, keyed, lie, lookalike, refuse, remembered, shout, square, touch, twoBytes, write } from './fixtures/armada/tasks';

const FIXTURES = join(import.meta.dir, 'fixtures');

/**
 * A deployment that runs each task on this machine as a container would: a pushed task's bundle under `node`, a
 * command's argv, each with the item in `ARMADA_ITEM` and its output to `ARMADA_OUT`. Tasks at `lose` are lost.
 */
function localFleet(lose: readonly number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'armada-fleet-'));
  const bundles = new Map<string, Uint8Array>();
  const ids = new Map<string, string>();
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
      const marker = join(dir, `${id}-${String(index)}.answer`);
      const { run: spec } = job.spec;
      const argv = spec.kind === 'task' ? ['node', join(dir, `${spec.bundle ?? ''}.mjs`)] : task.argv ?? [];
      const ran = Bun.spawn(argv, {
        env: { ...process.env, ARMADA_ITEM: JSON.stringify(task.item), ARMADA_INDEX: String(index), ARMADA_ATTEMPT: '1', ARMADA_OUT: out, ARMADA_ANSWER: marker, ARMADA_TASK: spec.kind === 'task' ? spec.id : '' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const exitCode = await ran.exited;
      const tail = await new Response(ran.stdout).text() + await new Response(ran.stderr).text();
      const kept = job.spec.output || spec.kind === 'task' ? readFileSync(out, { flag: 'a+' }) : null;
      const text = kept === null || kept.byteLength > INLINE_BYTES ? undefined : new TextDecoder('utf-8', { fatal: false }).decode(kept);
      const [said, error] = spec.kind === 'task' ? readFileSync(marker, { flag: 'a+' }).toString().split('\n') : [];

      if (kept !== null) outputs.set(`${id}/${String(index)}`, new Uint8Array(kept));
      job.events.push({
        index, kind: 'exited', exitCode, seconds: 0.1, vessel: 'v1', attempt: 1, tail, output: kept !== null, ...text === undefined || text.includes('\uFFFD') ? {} : { value: text },
        ...said === 'value' || said === 'command' ? { answer: said } : {}, ...error === undefined ? {} : { error },
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

        if (spec.run.kind === 'task') {
          const bundle = spec.run.bundle ?? ids.get(spec.run.id);

          if (bundle === undefined) return Response.json({ error: `no task ${spec.run.id} is pushed` }, { status: 409 });
          spec.run = { ...spec.run, bundle };
        }
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

/** A local deployment with the fixtures' project pushed to it. */
async function fleet(lose: readonly number[] = []) {
  const made = localFleet(lose);

  fleets.push(made);
  await push(made.armada, FIXTURES);

  return made;
}

const brief = <I, O>(result: Result<I, O>) => ({ index: result.index, kind: result.kind, ...'value' in result ? { value: result.value } : {}, ...'error' in result ? { error: `${result.error.name}: ${result.error.message}` } : {} });

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
    const rejected = await square.map([2, 3], { armada }).catch((error: unknown) => error);

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
    const refused = await greet.map([{ name: 'ada' }, { name: '' }], { armada }).catch((error: unknown) => String(error));

    expect({ refused, jobs: seen.filter((each) => each === 'POST /jobs') }).toEqual({ refused: 'SchemaError: item 1 does not fit its schema: name: Invalid length: Expected >=1 but received 0', jobs: [] });
  });

  test('whose id no push recorded is refused with what to do', async () => {
    const { armada } = await fleet();
    const unpushed = task({ id: 'nowhere', run: (n: number) => n });

    expect(await unpushed.map([1], { armada }).catch((error: unknown) => String(error))).toContain('no task nowhere is pushed');
  });

  test('a push refuses two tasks that share an id', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-twice-'));

    try {
      mkdirSync(join(scratch, 'armada'));
      writeFileSync(join(scratch, 'armada.config.ts'), `export default { project: 'twice' };\n`);
      const source = (name: string) => `import { task } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'index.ts'))};\nexport const ${name} = task({ id: 'same', run: (n: number) => n });\n`;

      writeFileSync(join(scratch, 'armada', 'a.ts'), source('a'));
      writeFileSync(join(scratch, 'armada', 'b.ts'), source('b'));

      expect(await push(localFleet().armada, scratch).catch((error: unknown) => String(error))).toBe('Error: two tasks have the id same: in armada/a.ts and armada/b.ts');
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
    expect(await keyed.local(null).catch((error: unknown) => String(error)))
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
    const thrown = await refuse.local(3).catch((error: unknown) => String(error));
    const lied = await lie.local(3).catch((error: unknown) => String(error));
    const failed = await write.local(3).catch((error: unknown) => String(error));

    expect({
      square: await square.local(4), greet: await greet.local({ name: 'ada' }), text: await echo.local('a b; c'), json: await write.local(2),
      bytes: [...await twoBytes.local(null)], none: await touch.local(1), shouted: await shout.local('hi'), thrown, lied: String(lied).startsWith('SchemaError: the value does not fit its schema'), failed,
    }).toEqual({
      square: 16, greet: { text: 'hello, ada' }, text: 'a b; c', json: { n: 2 }, bytes: [255, 254], none: null, shouted: 'HI', thrown: 'RangeError: no 3', lied: true,
      failed: expect.stringContaining('ShellError: `printf \'{"n": %s}\' 3 > ') as unknown as string,
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
    const seen: [number, string][] = [];

    for await (const result of attached) {
      seen.push([result.index, result.item]);
      more();
    }

    expect(seen).toEqual([[0, 'a'], [1, 'b']]);
  });
});

describe('a recipe built a step at a time', () => {
  test('appends each step to its script, quotes packages, and leaves the recipe it came from as it was', () => {
    const base = recipe.debian().apt('curl', "it's");
    const ml = base.setup('echo root').install('uv sync --frozen').size('small');

    expect({ base: base.spec, ml: ml.spec, other: recipe.from('cloudflare/other').spec.base, plain: recipe({ install: 'x' }).spec.install }).toEqual({
      base: { base: 'cloudflare/debian-trixie', setup: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl 'it'\\''s'", install: '', size: 'medium' },
      ml: {
        base: 'cloudflare/debian-trixie', setup: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl 'it'\\''s'\necho root",
        install: 'uv sync --frozen', size: 'small',
      },
      other: 'cloudflare/other',
      plain: 'x',
    });
  });
});

describe('sh', () => {
  test('quotes each interpolation as one word, a list as one word each, and refuses one inside the template\'s own quotes', async () => {
    const hostile = `$(echo pwned) "q" 'r' \\ ; |`;

    expect({
      word: await sh`printf '[%s]' ${hostile}`.text(),
      list: await sh`printf '[%s]' ${['a b', 'c']}`.text(),
      number: sh`sleep ${1.5}`.script,
      doubled: (() => { try { return sh`echo "${hostile}"`.script; } catch (cause) { return String(cause); } })(),
      single: (() => { try { return sh`echo '${hostile}'`.script; } catch (cause) { return String(cause); } })(),
      escaped: sh`echo \\" ${'x'}`.script,
      raw: sh.raw`echo ${'$HOME'}`.script,
    }).toEqual({
      word: `[${hostile}]`,
      list: '[a b][c]',
      number: 'sleep 1.5',
      doubled: 'Error: sh quotes each ${} itself: write sh`echo ${word}`, not sh`echo "${word}"`',
      single: 'Error: sh quotes each ${} itself: write sh`echo ${word}`, not sh`echo "${word}"`',
      escaped: 'echo \\" x',
      raw: 'echo $HOME',
    });
  });
});
