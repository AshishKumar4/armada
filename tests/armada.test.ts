import { describe, expect, setSystemTime, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { extractTar, lanesFor, poolFor, remainingDeadline } from '../src/ci';
import { manifestOf, packBase, packOf } from '../src/git';
import { parseConfig } from '../src/config';
import { grade, rowName, taskName, underExit, type TaskAnswer } from '../src/grade';
import { environmentKey, JsonSchema, PACKER, PROTOCOL, errorOf, fill, fitSize, itemValues, JobSpecSchema, MAX_ARGUMENT_BYTES, medians, mustDrain, RecipeSchema, recordSamples, refusal, servedFloor, usageOf, weightOf, type Health, type Json, type Outcome, type Recipe } from '../src/protocol';
import { Armada, PACK_PART } from '../src/sdk';
import { fakeFetch, git, scratchEnv } from './fakes';

describe('a task\'s command', () => {
  test('fills from the item: a string as itself, an object\'s scalar keys, its JSON as {item}', () => {
    const object = { row: 'bun test a.test.ts', weight: 12.5, nested: { no: true } };

    expect({
      text: fill('echo {item} {index}', itemValues('hello', 3)),
      object: fill('suite --row={row} --weight={weight}', itemValues(object, 0)),
      json: fill('{item}', itemValues(object, 0)),
    }).toEqual({ text: 'echo hello 3', object: 'suite --row=bun test a.test.ts --weight=12.5', json: JSON.stringify(object) });
  });

  test('a placeholder the task does not have is refused, never left empty', () => {
    expect(() => fill('--part={part}', itemValues({ row: 'x' }, 0))).toThrow();
  });

  test('an item weighs its numeric `weight`, and anything else nothing', () => {
    expect([weightOf({ weight: 301 }), weightOf({ weight: '9' }), weightOf('a'), weightOf(null), weightOf([1])]).toEqual([301, 0, 0, 0, 0]);
  });
});

describe('an environment', () => {
  test('is keyed by the recipe\'s own text, the driver and its packs\' packer, so a fixed script is a new environment', async () => {
    const recipe: Recipe = { base: 'cloudflare/debian-trixie', setup: 'apt-get install -y git', install: '', size: 'medium' };
    const repo = { project: 'app', checkout: '/home/ci/work/app/app', history: 'full' as const, manifest: [{ path: 'bun.lock', id: 'a'.repeat(40) }, { path: 'package.json', id: 'b'.repeat(40) }] };
    const key = await environmentKey(recipe);

    const keys = {
      fixed: await environmentKey({ ...recipe, setup: 'apt-get install -y git strace' }),
      rebased: await environmentKey({ ...recipe, base: 'cloudflare/debian-trixie@sha256:' + 'c'.repeat(64) }),
      repo: await environmentKey({ ...recipe, repo }),
      reordered: await environmentKey({ ...recipe, repo: { ...repo, manifest: [...repo.manifest].reverse() } }),
      relocked: await environmentKey({ ...recipe, repo: { ...repo, manifest: [{ path: 'bun.lock', id: 'd'.repeat(40) }, ...repo.manifest.slice(1)] } }),
      // A client that sends its packs' boundary never shares an environment an earlier client prepared (#34), as the
      // Worker keys the recipe it parsed.
      packed: await environmentKey(v.parse(RecipeSchema, { ...recipe, repo: { ...repo, packer: PACKER } })),
    };

    expect({ fixed: keys.fixed === key, rebased: keys.rebased === key, repo: keys.repo === key, reordered: keys.reordered === keys.repo, relocked: keys.relocked === keys.repo, packed: keys.packed === keys.repo })
      .toEqual({ fixed: false, rebased: false, repo: false, reordered: true, relocked: false, packed: false });
  });

  test('a row\'s estimate is the median of its last five green runs: one slow run moves nothing, and old ones age out', () => {
    let history: Record<string, number[]> = {};

    for (const seconds of [900, 900, 900, 900, 1, 1, 1]) history = recordSamples(history, { aged: seconds });

    for (const seconds of [100, 100, 900, 100]) history = recordSamples(history, { row: seconds });

    expect(medians({ ...history, even: [1, 2, 3, 10] })).toEqual({ aged: 1, row: 100, even: 2.5 });
  });
});

describe('a project\'s CI config', () => {
  test('defaults what a project leaves out, and refuses a script outside the commit', () => {
    const base = { name: 'app', environment: { setup: 'ci/setup.sh' }, plan: { command: ['plan'] }, task: { command: ['run', '{row}'] } };
    const config = parseConfig(JSON.stringify(base));

    expect({ base: config.environment.base, history: config.history, pool: config.pool, deadline: config.deadline, verdict: config.task.verdict, speculative: config.task.speculative })
      .toEqual({ base: 'cloudflare/debian-trixie', history: 'full', pool: 40, deadline: 1800, verdict: true, speculative: false });
    expect(parseConfig(JSON.stringify({ ...base, deadline: 600 })).deadline).toBe(600);
    expect(() => parseConfig(JSON.stringify({ ...base, deadline: 0 }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ ...base, environment: { setup: '../outside.sh' } }))).toThrow('a path inside the commit');
  });

  test('a base the runtime cannot start by name is refused before anything starts, by `run` and by `map --env`', async () => {
    const base = { name: 'app', environment: {}, plan: { command: ['plan'] }, task: { command: ['run'] } };

    expect(parseConfig(JSON.stringify(base)).environment.base).toBe('cloudflare/debian-trixie');
    expect(() => parseConfig(JSON.stringify({ ...base, environment: { base: 'ubuntu:26.04' } }))).toThrow('Cloudflare-managed image');
    const scratch = mkdtempSync(join(tmpdir(), 'armada-base-'));
    const requests: string[] = [];

    const server = Bun.serve({ port: 0, fetch: (request) => { requests.push(new URL(request.url).pathname);

 return Response.json({ id: 'j1' }); } });

    try {
      writeFileSync(join(scratch, 'recipe.json'), JSON.stringify({ base: 'ubuntu:26.04@sha256:' + 'f'.repeat(64) }));

      const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'map', `--env=${join(scratch, 'recipe.json')}`, '--times=1', '--', 'true'], {
        env: { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      expect({ exit: await cli.exited, said: (await new Response(cli.stderr).text()).includes('Cloudflare-managed image'), requests }).toEqual({ exit: 2, said: true, requests: [] });
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('keys its environment by the commit\'s files its globs match, * within a segment and ** across, any name as it is', () => {
    const repo = mkdtempSync(join(tmpdir(), 'armada-manifest-'));
    const paths = ['bun.lock', 'packages/core/package.json', 'packages/core/src/package.json', 'patches/a.patch', 'patches/deep/b.patch', 'package.json', 'env/café.lock', 'ci/setup.sh'];

    try {
      git(repo, 'init', '-q');

      for (const path of paths) {
        mkdirSync(join(repo, path, '..'), { recursive: true });
        writeFileSync(join(repo, path), path);
      }

      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'files');
      const config = parseConfig(JSON.stringify({ name: 'app', environment: { setup: 'ci/setup.sh', key: ['bun.lock', 'packages/*/package.json', 'patches/**', 'env/**'] }, plan: { command: ['plan'] }, task: { command: ['run'] } }));

      expect(manifestOf(repo, git(repo, 'rev-parse', 'HEAD'), config.environment).map(({ path }) => path).toSorted())
        .toEqual(['bun.lock', 'ci/setup.sh', 'env/café.lock', 'packages/core/package.json', 'patches/a.patch', 'patches/deep/b.patch']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('grading a CI run', () => {
  const row = (name: string, exitCode = 0, timings?: Record<string, number>) => ({ name, exitCode, seconds: 1, output: `${name} said this`, timings });

  test('a task is named by its configured key, else `name`, else its first string value, else its position', () => {
    expect([taskName({ row: 'a b', name: 'x' }, 'name', 0), taskName({ part: 'source-1' }, undefined, 1), taskName({ weight: 2 }, undefined, 2)]).toEqual(['x', 'source-1', 'task-3']);
  });

  test('every named row reported once by its task, a red one listed: graded, with the red', () => {
    const answers: TaskAnswer[] = [
      { name: 'a', entry: { rows: ['one', { name: 'two', files: ['x.test.ts', 'y.test.ts'] }] }, rows: [row('one'), row('two', 1, { 'x.test.ts': 2, 'y.test.ts': 3 })], artifacts: null },
      { name: 'b', entry: {}, rows: [{ run: 'bun scripts/three.ts', exitCode: 0, seconds: 0, output: '' }], artifacts: null },
    ];

    const graded = grade(answers);

    expect({ problems: graded.problems, rows: graded.rows.length, reds: graded.reds.map((each) => each.name) }).toEqual({ problems: [], rows: 3, reds: ['two'] });
  });

  test('a file is timed at what all its rows report for it, and not at all where a row of it, by its timings or its plan entry, was red or reused', () => {
    const split = (file: string) => ({ rows: [1, 2].map((part) => ({ name: `${file}#${String(part)}/2`, files: [file] })) });

    const graded = grade([
      { name: 'a', entry: split('a.test.ts'), rows: [row('a.test.ts#1/2', 0, { 'a.test.ts': 2 }), row('a.test.ts#2/2', 0, { 'a.test.ts': 3 })], artifacts: null },
      { name: 'b', entry: {}, rows: [row('b', 0, { 'b.test.ts': 4, 'c.test.ts': 1 }), row('c', 1, { 'c.test.ts': 5 }), { ...row('d', 0, { 'd.test.ts': 6 }), cached: 'abc123' }, row('e')], artifacts: null },
      // A row cut off before its verdict timed nothing, and its file's other row holds only part of the file (#36).
      { name: 'f', entry: split('f.test.ts'), rows: [row('f.test.ts#1/2', 0, { 'f.test.ts': 2 }), row('f.test.ts#2/2', 124)], artifacts: null },
    ]);

    expect({ problems: graded.problems, files: graded.files }).toEqual({ problems: [], files: { 'a.test.ts': 5, 'b.test.ts': 4 } });
  });

  test('a task that exits nonzero fails every row it reported green; one it reported red keeps its own exit', () => {
    const exited = underExit([row('one'), row('two', 1), { ...row('three', 1), output: '' }], { exitCode: 7, tail: 'Segmentation fault' }, 'a');

    expect(exited.map((each) => [rowName(each), each.exitCode, each.output])).toEqual([
      ['one', 7, 'the task exited 7 after reporting this row green\nSegmentation fault'],
      ['two', 1, 'two said this'],
      ['three', 1, 'Segmentation fault'],
    ]);
    expect(grade([{ name: 'a', entry: {}, rows: exited, artifacts: null }]).reds.map(rowName)).toEqual(['one', 'two', 'three']);
    expect(underExit([row('one')], { exitCode: 0, tail: '' }, 'a')).toEqual([row('one')]);
  });

  test('a task that exits nonzero having reported no row is a red row of its own', () => {
    const exited = underExit([], { exitCode: 7, tail: 'Segmentation fault' }, 'a');

    expect(exited.map((each) => [rowName(each), each.exitCode, each.output])).toEqual([
      ['a', 7, 'the task exited 7 and reported no row\nSegmentation fault'],
    ]);
    expect(grade([{ name: 'a', entry: {}, rows: exited, artifacts: null }])).toMatchObject({ problems: [], reds: exited });
    expect(underExit([], { exitCode: 0, tail: '' }, 'a')).toEqual([]);
  });

  test('a task cut off before it reported a row is red in every row its entry names, graded, with its exit', () => {
    const expected = ['one', { name: 'two', files: ['two.test.ts'] }];
    const exited = underExit([], { exitCode: 124, tail: 'still running at the timeout', seconds: 1800 }, 'a', expected);

    expect(exited.map((each) => [rowName(each), each.exitCode, each.output])).toEqual([
      ['one', 124, 'the task exited 124 and reported no row\nstill running at the timeout'],
      ['two', 124, 'the task exited 124 and reported no row\nstill running at the timeout'],
    ]);
    expect(grade([{ name: 'a', entry: { rows: ['one', 'two'] }, rows: exited, artifacts: null }])).toMatchObject({ problems: [], reds: exited });
  });

  test('a missing verdict, a missing or extra row, a row twice, and an untimed file are each named, and none is green', () => {
    const graded = grade([
      { name: 'a', entry: { rows: ['one', 'two', { name: 'split', files: ['x.test.ts', 'y.test.ts'] }] }, rows: [row('one'), row('stray'), row('split', 0, { 'x.test.ts': 1 })], artifacts: null },
      { name: 'b', entry: {}, rows: [row('one')], artifacts: null },
      { name: 'c', entry: { rows: ['four'] }, rows: null, artifacts: null },
    ]);

    expect(graded.problems).toEqual([
      'a has no verdict for two; missing is not green',
      'a: split timed 1 of its 2 files',
      'a reported stray, which its plan entry does not name',
      'one was reported by both a and b',
      'c wrote no verdict',
    ]);
  });

  test('a task cut off before it reported is red in its named rows; one exiting 0 without a verdict is ungradable', () => {
    const graded = grade([
      { name: 'a', entry: { rows: ['one', 'two'] }, rows: ['one', 'two'].map((name) => ({ name, exitCode: 124, seconds: 1800, output: 'the task exited 124 and reported no row\nthe timeout killed it' })), artifacts: null },
      { name: 'c', entry: { rows: ['three'] }, rows: null, artifacts: null },
    ]);

    expect({ problems: graded.problems, reds: graded.rows.map((each) => [rowName(each), each.exitCode]) }).toEqual({ problems: ['c wrote no verdict'], reds: [['one', 124], ['two', 124]] });
  });

  test('a row may name the task\'s kept artifacts as evidence; one it did not keep is a problem', () => {
    const withFile = { name: 'a', entry: {}, rows: [{ ...row('x'), artifacts: ['shots/home.png'] }], artifacts: new Set(['shots/home.png']) };
    const without = { name: 'a', entry: {}, rows: [{ ...row('x'), artifacts: ['shots/home.png'] }], artifacts: null };

    const missing = grade([without]);

    expect({ graded: grade([withFile]).problems, missing: missing.problems, row: missing.rows.map((each) => [each.exitCode, each.problem]) })
      .toEqual({ graded: [], missing: ['a: x names evidence shots/home.png its task did not keep'], row: [[2, 'a: x names evidence shots/home.png its task did not keep']] });
  });
});

describe('a task\'s stored artifacts', () => {
  test('extract as the tar.gz lists them, refusing a member that is absolute or climbs out', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-artifacts-'));

    try {
      mkdirSync(join(scratch, 'src', 'shots'), { recursive: true });
      writeFileSync(join(scratch, 'src', 'shots', 'home.png'), 'png');
      const made = Bun.spawnSync(['tar', '-czf', '-', '-C', join(scratch, 'src'), '.'], { stdout: 'pipe' });
      const members = extractTar(new Uint8Array(made.stdout), join(scratch, 'out'));

      expect({ members, file: readFileSync(join(scratch, 'out', 'shots', 'home.png'), 'utf8') }).toEqual({ members: ['shots/home.png'], file: 'png' });

      const evil = Bun.spawnSync(['tar', '-czf', '-', '-C', join(scratch, 'src'), '--transform', 's|^\\./shots/home\\.png$|../evil|', '.'], { stdout: 'pipe' });
      const abs = Bun.spawnSync(['tar', '-czf', '-', '-C', join(scratch, 'src'), '--transform', 's|^\\./shots/home\\.png$|/etc/evil|', '.'], { stdout: 'pipe' });

      expect([() => extractTar(new Uint8Array(evil.stdout), join(scratch, 'x')), () => extractTar(new Uint8Array(abs.stdout), join(scratch, 'y'))].map((fn) => {
        try {
          fn();

          return null;
        } catch (error) {
          return String(error);
        }
      })).toEqual(['Error: the artifacts hold ../evil, which escapes ' + join(scratch, 'x'), 'Error: the artifacts hold /etc/evil, which escapes ' + join(scratch, 'y')]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a deploy', () => {
  const health = (protocol: number, oldest?: number, driver = 2): Health => ({ ok: true, driver, protocol, oldest, vcpus: 0, jobs: 0 });

  test('reads the oldest wire a Worker serves: said, else 3 since protocol 4, else only its own', () => {
    expect([servedFloor(health(7, 5)), servedFloor(health(6)), servedFloor(health(4)), servedFloor(health(2))]).toEqual([5, 3, 3, 2]);
  });

  test('drains only what this Worker could not take over: forced, unanswering, newer, below the floor, other driver', () => {
    expect([
      mustDrain(health(PROTOCOL, 3), true),
      mustDrain(null, false),
      mustDrain(health(PROTOCOL + 1, 3), false),
      mustDrain(health(PROTOCOL - 1, 2), false),
      mustDrain(health(PROTOCOL - 1), false),
      mustDrain(health(PROTOCOL), false),
      mustDrain(health(PROTOCOL, 3), false),
      mustDrain(health(PROTOCOL - 1, 3, 1), false),
    ]).toEqual([true, true, true, true, false, false, false, true]);
  });
});

describe('armada deploy', () => {
  test('refuses a connection file of another account, before it reaches Cloudflare', async () => {
    const home = mkdtempSync(join(tmpdir(), 'armada-home-'));

    try {
      mkdirSync(join(home, '.config', 'armada'), { recursive: true });
      writeFileSync(join(home, '.config', 'armada', 'lab.json'), JSON.stringify({ url: 'https://lab.test', token: 't', account: 'A' }));
      const ran = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'deploy', '--name=lab', '--account=B'], { env: { ...scratchEnv(), HOME: home }, stdout: 'pipe', stderr: 'pipe' });

      expect({ exit: await ran.exited, said: (await new Response(ran.stderr).text()).includes('account A, not B') }).toEqual({ exit: 2, said: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('a size', () => {
  const GiB = 2 ** 30;

  test('fits the most a task used with a quarter to spare, and goes up when a task filled its vCPUs', () => {
    expect([
      fitSize({ memory: 0.5 * GiB, cores: 0.3 }), fitSize({ memory: 0.5 * GiB, cores: 0.6 }), fitSize({ memory: 5 * GiB, cores: 0.3 }),
      fitSize({ memory: 2 * GiB, cores: 1.9 }), fitSize({ memory: 10 * GiB, cores: 1 }),
    ]).toEqual(['micro', 'mini', 'small', 'medium', 'medium']);
  });

  test('reads what tasks used from the outcomes that measured it', () => {
    const outcome = (seconds: number, peakMemory?: number, cpuSeconds?: number): Outcome => ({
      index: 0, kind: 'exited', exitCode: 0, seconds, vessel: 'v1', attempt: 1, tail: '', output: false, peakMemory, cpuSeconds,
    });

    expect([usageOf([outcome(10, GiB, 5), outcome(4, 2 * GiB, 1), outcome(3)]), usageOf([outcome(3)])]).toEqual([{ memory: 2 * GiB, cores: 0.5 }, null]);
  });
});

describe('a CI run\'s pool', () => {
  test('is the fewest containers that finish as soon as the most would, with a fifth of the longest task to spare', () => {
    const tail = Array.from({ length: 89 }, (_, index) => 20 + index % 40);

    expect({
      oneLong: poolFor([500, ...tail], 60),
      even: poolFor(Array.from({ length: 30 }, () => 300), 60),
      capped: poolFor(Array.from({ length: 30 }, () => 300), 12),
      pairs: poolFor([100, 40, 40, 40, 40], 5),
    }).toEqual({ oneLong: 10, even: 30, capped: 12, pairs: 3 });
  });

  test('sizes lanes for a slotted run and rounds them up into containers', () => {
    const ones = (count: number) => Array.from({ length: count }, () => 1);

    expect({
      even: lanesFor(Array.from({ length: 60 }, () => 300), ones(60), 40, 4),
      oneLong: lanesFor([500, ...Array.from({ length: 89 }, (_, index) => 20 + index % 40)], ones(90), 40, 4),
      unsized: lanesFor([undefined, 5], ones(2), 40, 4),
      gang: lanesFor([5, 5], [1, 4], 4, 1),
    }).toEqual({ even: { lanes: 60, pool: 15 }, oneLong: { lanes: 10, pool: 3 }, unsized: { lanes: 2, pool: 1 }, gang: { lanes: 4, pool: 4 } });
  });

  test('refuses a job a container could not start: an argument or an item too long for Linux, or a slotted gang', () => {
    const word = (text: string) => [{ item: 0, argv: ['sh', '-c', text] }];
    const item = (text: string) => [{ item: text, argv: ['true'] }];
    const gang = [{ item: { gang: 4 }, argv: ['true'] }];
    const ok = (refused: string | null) => refused === null;

    expect([
      ok(refusal({ kind: 'command' }, word('x'.repeat(MAX_ARGUMENT_BYTES)), 4)), ok(refusal({ kind: 'command' }, word('é'.repeat(65_536)), 4)),
      ok(refusal({ kind: 'task' }, item('x'.repeat(MAX_ARGUMENT_BYTES)), 4)), ok(refusal({ kind: 'command' }, item('x'.repeat(MAX_ARGUMENT_BYTES)), 4)),
      ok(refusal({ kind: 'command' }, gang, 4, 1)), ok(refusal({ kind: 'command' }, gang, 4, 2)),
    ]).toEqual([true, false, false, false, true, false]);
  });
});

describe('a repository recipe', () => {
  test('keys its environment by this client\'s packer, however its caller wrote it, as it resolves and as its job starts', async () => {
    const sent: unknown[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = fakeFetch(async (request) => {
      sent.push(await request.json());

      return new URL(request.url).pathname === '/jobs' ? Response.json({ id: 'j1' }) : Response.json({ key: 'k', base: 'root' });
    });

    try {
      const armada = new Armada({ url: 'https://armada.test', token: 't', account: 'a' });
      const recipe = v.parse(RecipeSchema, { repo: { project: 'app', checkout: '/home/ci/work', history: 'full', manifest: [] } });

      await armada.resolve(recipe);
      await armada.create({ recipe, items: [{ item: 1, argv: ['true'] }], run: { kind: 'command' } });
      const packers = sent.map((body) => v.parse(v.object({ recipe: v.object({ repo: v.object({ packer: v.optional(v.number()) }) }) }), body).recipe.repo.packer);

      expect(packers).toEqual([PACKER, PACKER]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('uploading a pack', () => {
  test('one no larger than a part goes in one PUT; a larger one in equal parts, then completes', async () => {
    const seen: string[] = [];
    const sent: number[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = fakeFetch(async (request) => {
      const url = new URL(request.url);
      const { method } = request;

      seen.push(`${method} ${url.pathname.split('/').slice(-1)[0] ?? ''}${url.search}`);

      if (url.searchParams.has('part')) sent.push((await request.arrayBuffer()).byteLength);

      if (method === 'HEAD') return new Response(null, { status: 404 });

      if (url.searchParams.has('uploads')) return Response.json({ upload: 'u1' });

      if (url.searchParams.has('part')) return Response.json({ partNumber: Number(url.searchParams.get('part')), etag: `e${url.searchParams.get('part') ?? ''}` });

      return Response.json({ stored: 'key' });
    });

    try {
      const armada = new Armada({ url: 'https://armada.test', token: 't', account: 'a' });

      expect(await armada.uploadPack('app', { sha: 'a'.repeat(40), base: 'root' }, () => new Blob([new Uint8Array(PACK_PART)]))).toBe(PACK_PART);
      expect(seen.splice(0)).toEqual([`HEAD root?packer=${String(PACKER)}`, `PUT root?packer=${String(PACKER)}`]);
      expect(await armada.uploadPack('app', { sha: 'b'.repeat(40), base: 'root' }, () => new Blob([new Uint8Array(2 * PACK_PART + 5)]))).toBe(2 * PACK_PART + 5);
      expect(seen).toEqual([
        `HEAD root?packer=${String(PACKER)}`, `POST root?packer=${String(PACKER)}&uploads`, `PUT root?packer=${String(PACKER)}&upload=u1&part=1`, `PUT root?packer=${String(PACKER)}&upload=u1&part=2`,
        `PUT root?packer=${String(PACKER)}&upload=u1&part=3`, `POST root?packer=${String(PACKER)}&upload=u1`,
      ]);
      expect(sent).toEqual([PACK_PART, PACK_PART, 5]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a part that fails aborts the upload, so its parts don\'t stay, and the failure is the error', async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = fakeFetch(async (request) => {
      const url = new URL(request.url);

      seen.push(`${request.method} ${url.search}`);

      if (request.method === 'HEAD') return new Response(null, { status: 404 });

      if (url.searchParams.has('uploads')) return Response.json({ upload: 'u1' });

      if (url.searchParams.get('part') === '2') return new Response('the part was cut off', { status: 400 });

      return url.searchParams.has('part') ? Response.json({ partNumber: 1, etag: 'e1' }) : Response.json({ aborted: 'u1' });
    });

    try {
      const armada = new Armada({ url: 'https://armada.test', token: 't', account: 'a' });
      let failed = '';

      try {
        await armada.uploadPack('app', { sha: 'c'.repeat(40), base: 'root' }, () => new Blob([new Uint8Array(2 * PACK_PART + 5)]));
      } catch (cause) {
        failed = errorOf({ cause }).message;
      }

      expect({ failed: failed.includes('the part was cut off'), last: seen.at(-1) }).toEqual({ failed: true, last: `DELETE ?packer=${String(PACKER)}&upload=u1` });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('a failed request', () => {
  test('says the Worker\'s own error, and an HTML error page by its status and title, even a 404 one', async () => {
    const page = '<!DOCTYPE html>\n<html>\n<head>\n<title>Service Unavailable</title>\n</head>\n<body>' + '<p>retry</p>'.repeat(500) + '</body>\n</html>\n';

    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        if (pathname === '/jobs') return Response.json({ error: 'upload the pack first' }, { status: 409 });

        if (pathname === '/jobs/j1') return Response.json({ error: 'no such job' }, { status: 404 });

        // A workers.dev name a Worker was just deployed to answers with this until it is live.
        if (pathname === '/health') return new Response('<html><head><title>There is nothing here yet</title></head></html>', { status: 404, headers: { 'content-type': 'text/html' } });

        return new Response(page, { status: 503, headers: { 'content-type': 'text/html' } });
      },
    });

    try {
      const armada = new Armada({ url: server.url.href, token: 't', account: 'a' });

      const failed = async (path: string, method = 'POST') => {
        try {
          return `answered ${String((await armada.call(path, { method })).status)}`;
        } catch (cause) {
          return String(errorOf({ cause }));
        }
      };

      expect([await failed('/jobs'), await failed('/environments/resolve'), await failed('/health', 'GET'), await failed('/jobs/j1', 'GET')]).toEqual([
        'RequestError: POST /jobs: 409 upload the pack first',
        'RequestError: POST /environments/resolve: 503 from the Worker (it may still be deploying): Service Unavailable',
        'RequestError: GET /health: 404 from the Worker (it may still be deploying): There is nothing here yet',
        'answered 404',
      ]);
    } finally {
      await server.stop(true);
    }
  });
});

describe('packing a commit', () => {
  test('a clone without the environment\'s commit packs from the root, and that pack checks out where the environment is', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-pack-'));

    try {
      const origin = join(scratch, 'origin');

      git(scratch, 'init', '-q', origin);
      writeFileSync(join(origin, 'a.txt'), 'one\n');
      git(origin, 'add', '.');
      git(origin, 'commit', '-qm', 'environment');
      const environment = git(origin, 'rev-parse', 'HEAD');

      writeFileSync(join(origin, 'b.txt'), 'two\n');
      git(origin, 'add', '.');
      git(origin, 'commit', '-qm', 'head');
      const head = git(origin, 'rev-parse', 'HEAD');

      git(scratch, 'clone', '-q', '--depth=1', `file://${origin}`, 'shallow');
      const shallow = join(scratch, 'shallow');

      expect([packBase(origin, environment), packBase(shallow, environment), packBase(origin, 'root')]).toEqual([environment, 'root', 'root']);
      // A container's checkout (`receive`, `history: commit`): the environment's commit from its preparation's pack,
      // then the head, packed in the shallow clone.
      const checkout = join(scratch, 'checkout');

      git(scratch, 'init', '-q', checkout);

      for (const { sha, from, base } of [{ sha: environment, from: origin, base: 'root' }, { sha: head, from: shallow, base: packBase(shallow, environment) }]) {
        const pack = new Uint8Array(await packOf(from, sha, base, 'commit').arrayBuffer());

        expect(Bun.spawnSync(['git', 'index-pack', '--stdin'], { cwd: checkout, env: scratchEnv(), stdin: pack, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
        appendFileSync(join(checkout, '.git', 'shallow'), `${sha}\n`);
        git(checkout, 'checkout', '-q', '-f', '-B', 'armada', sha);
      }

      expect({ head: git(checkout, 'rev-parse', 'HEAD'), status: git(checkout, 'status', '--porcelain'), files: git(checkout, 'ls-files') }).toEqual({ head, status: '', files: 'a.txt\nb.txt' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a commit checkout', () => {
  test('takes a commit whose parent is an ancestor of the environment\'s, sharing a tree with it the checkout never held', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-pack-'));
    const origin = join(scratch, 'origin');
    const checkout = join(scratch, 'checkout');

    const commit = (message: string, files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(origin, path, '..'), { recursive: true });
        writeFileSync(join(origin, path), text);
      }

      git(origin, 'add', '.');
      git(origin, 'commit', '-qm', message);

      return git(origin, 'rev-parse', 'HEAD');
    };

    try {
      git(scratch, 'init', '-q', origin);
      const fork = commit('fork', { 'apps/a.txt': 'one\n', 'b.txt': 'b\n' });
      const environment = commit('environment', { 'apps/a.txt': 'two\n' });
      // A commit on the fork point, as `git commit-tree -p <fork>` makes one: its `apps` is the fork's.
      git(origin, 'checkout', '-q', fork);
      const head = commit('overlay', { 'c.txt': 'c\n' });

      git(scratch, 'init', '-q', checkout);

      // The environment's own commit run again packs nothing, and the overlay's pack carries what the checkout lacks.
      for (const [sha, base] of [[environment, 'root'], [environment, environment], [head, environment]] as const) {
        const pack = new Uint8Array(await packOf(origin, sha, base, 'commit').arrayBuffer());

        expect(Bun.spawnSync(['git', 'index-pack', '--stdin'], { cwd: checkout, env: scratchEnv(), stdin: pack, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
        appendFileSync(join(checkout, '.git', 'shallow'), `${sha}\n`);
        git(checkout, 'checkout', '-q', '-f', '-B', 'armada', sha);
      }

      expect({ head: git(checkout, 'rev-parse', 'HEAD'), a: git(checkout, 'show', 'HEAD:apps/a.txt'), status: git(checkout, 'status', '--porcelain') }).toEqual({ head, a: 'one', status: '' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the CLI\'s arguments', () => {
  test('with no command, or with --help, are answered with the usage; a wrong option says what to give instead', async () => {
    const requests: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);

        return Response.json({ error: 'no route' }, { status: 404 });
      },
    });

    const cli = async (...words: string[]) => {
      const ran = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), ...words], { env: { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't'.repeat(32) }, stdout: 'pipe', stderr: 'pipe' });

      return { exit: await ran.exited, said: await new Response(ran.stdout).text() + await new Response(ran.stderr).text() };
    };

    try {
      expect([await cli(), await cli('map', '--help')].map(({ exit, said }) => [exit, said.includes('\nUsage:\n')])).toEqual([[0, true], [0, true]]);

      // Each otherwise a valid map but for the word it names, refused before any request reaches the deployment.
      const wrong = await Promise.all(([
        [['map', '--times', '3', '--', 'true'], '--times'], [['map', '--times=3', '--time=3', '--', 'true'], '--time'], [['map', '-pool=1', '--times=3', '--', 'true'], '-pool'],
        [['map', '--times=0', '--', 'true'], '--times'], [['deploy', 'garbage'], 'garbage'], [['toString'], 'toString'], [['--pool=1'], 'no command'],
      ] as const).map(async ([words, named]) => {
        const ran = await cli(...words);

        return [ran.exit, ran.said.includes(named)];
      }));

      expect({ wrong, requests }).toEqual({ wrong: Array.from({ length: 7 }, () => [2, true]), requests: [] });
    } finally {
      await server.stop(true);
    }
  });

  test('are its own before --, every word after -- is the command\'s, and --connection wins over ARMADA_URL', async () => {
    const jobs: unknown[] = [];

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);

        if (pathname === '/jobs') {
          jobs.push(await request.json());

          return Response.json({ id: 'j1' });
        }

        if (pathname === '/jobs/j1/events') return Response.json({ events: [], done: true });

        return Response.json({
          id: 'j1', label: '', phase: 'done', key: 'k', createdAt: 0, startedAt: 0, finishedAt: 1, vessels: [], problems: [], environment: null,
          tasks: { total: 2, queued: 0, running: 0, exited: 2, red: 0, failed: 0 },
        });
      },
    });

    const scratch = mkdtempSync(join(tmpdir(), 'armada-connection-'));
    const named = join(scratch, 'named.json');

    writeFileSync(named, JSON.stringify({ url: server.url.href, token: 't', account: '' }));

    try {
      const map = async (args: readonly string[], url: string) => await Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'map', ...args, '--times=2', '--', 'tool', '--output', '--items=x'], {
        env: { ...scratchEnv(), ARMADA_URL: url, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      }).exited;

      const argv = ['tool', '--output', '--items=x'];
      // Nothing listens on port 9: the named connection's server is the only one that can answer.
      const exits = [await map([], server.url.href), await map([`--connection=${named}`], 'http://127.0.0.1:9')];
      const job = { items: [{ item: 1, argv }, { item: 2, argv }], run: { kind: 'command' }, output: false };

      expect({ exits, jobs }).toMatchObject({ exits: [0, 0], jobs: [job, job] });
      expect(v.parse(JobSpecSchema, jobs[0]).deadline).toBe(21600);
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a map deadline', () => {
  test('shorter than an explicit task timeout is refused before any request', async () => {
    const requests: string[] = [];

    const server = Bun.serve({ port: 0, fetch: (request) => {
      requests.push(new URL(request.url).pathname);

      return Response.json({});
    } });

    try {
      const cli = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'map', '--times=1', '--timeout=1800', '--deadline=1799', '--', 'true'], {
        env: { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      expect({ exit: await cli.exited, requests }).toEqual({ exit: 2, requests: [] });
    } finally {
      await server.stop(true);
    }
  });
});

describe('the CLI following a job', () => {
  test('interrupted, it cancels the job and exits 2, even when the job finishes green while the cancel is answered', async () => {
    const seen: string[] = [];
    let polled: () => void = () => undefined;
    const polling = new Promise<void>((resolve) => { polled = resolve; });
    let cancelled = false;
    const green = { index: 0, kind: 'exited', exitCode: 0, seconds: 1, vessel: 'v1', attempt: 1, tail: '', output: false };

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);

        seen.push(`${request.method} ${pathname}`);

        if (pathname === '/jobs') return Response.json({ id: 'j1' });

        if (pathname === '/jobs/j1/events') {
          polled();

          return Response.json(cancelled ? { events: [{ seq: 1, outcome: green }], done: true } : { events: [], done: false });
        }

        if (pathname === '/jobs/j1/cancel') {
          cancelled = true;
          await Bun.sleep(2_500);

          return Response.json({ cancelled: 'j1' });
        }

        return Response.json({
          id: 'j1', label: '', phase: 'done', key: 'k', createdAt: 0, startedAt: 0, finishedAt: 1, vessels: [], problems: [], environment: null,
          tasks: { total: 1, queued: 0, running: 0, exited: 1, red: 0, failed: 0 },
        });
      },
    });

    try {
      const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'map', '--times=1', '--', 'true'], {
        env: { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      await polling;
      cli.kill('SIGINT');
      expect({ exit: await cli.exited, cancelled: seen.includes('POST /jobs/j1/cancel') }).toEqual({ exit: 2, cancelled: true });
    } finally {
      await server.stop(true);
    }
  });
});

describe('armada verdict', () => {
  test('prints the verdict armada run stored for the commit, and exits 0 green, 1 red and 2 with none', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-verdict-'));
    const repo = join(scratch, 'repo');
    const stored = new Map<string, unknown>();

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const found = stored.get(new URL(request.url).pathname);

        return found === undefined ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json(found);
      },
    });

    const verdict = async (...words: string[]) => {
      const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'verdict', 'HEAD', ...words], {
        cwd: repo, env: { ...scratchEnv(), HOME: scratch, ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      return { exit: await cli.exited, said: (await new Response(cli.stdout).text() + await new Response(cli.stderr).text()).trim() };
    };

    try {
      mkdirSync(repo);
      git(repo, 'init', '-q');
      writeFileSync(join(repo, '.armada.json'), JSON.stringify({ name: 'proj', environment: {}, plan: { command: ['plan'] }, task: { command: ['task'] } }));
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'one');
      const sha = git(repo, 'rev-parse', 'HEAD');
      const none = await verdict();
      const noneJson = await verdict('--json');
      const rows = [{ run: 'unit', exitCode: 0, seconds: 1, output: '' }, { run: 'e2e', exitCode: 1, seconds: 2, output: 'a real failure' }];

      stored.set(`/verdicts/proj/${sha}`, { sha, part: 'all', rows });
      const red = await verdict();
      const json = await verdict('--json');

      stored.set(`/verdicts/proj/${sha}`, { sha, part: 'all', rows: rows.slice(0, 1) });

      expect({ none, noneJson: noneJson.said.split('\n')[0], red: [red.exit, red.said.includes('RED  e2e') && red.said.endsWith(`FAIL: 1 of 2 rows green, proj ${sha}`)], json: [json.exit, JSON.parse(json.said)], green: await verdict() }).toEqual({
        none: { exit: 2, said: `proj ${sha} has no verdict; armada run ${sha.slice(0, 12)} grades one` },
        noneJson: 'null',
        red: [1, true],
        json: [1, { sha, part: 'all', rows }],
        green: { exit: 0, said: `PASS: 1 of 1 rows green, proj ${sha}` },
      });
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/** How a test's runner answers `armada run` beyond its plan and verdict: the task's and the plan's exits, the plan and task
 *  configuration, and the timings it holds. */
interface Runner {
  readonly deadline?: number;
  readonly planDelayMs?: number;
  readonly taskExit?: number;
  readonly planExit?: number;
  readonly planConfig?: Json;
  readonly taskConfig?: Readonly<Record<string, Json>>;
  readonly timings?: Json;
  /** Each task's artifacts archive, one task each: the task job then lands these, every one with its archive. */
  readonly artifacts?: readonly Uint8Array[];
  /** More of `.armada.json`, and files beside it in the commit. */
  readonly config?: Readonly<Record<string, Json>>;
  readonly files?: Readonly<Record<string, string>>;
  /** Each task job then lands every one of its tasks, exiting with this for its item. */
  readonly exitOf?: (item: Json) => number;
  /** The task job, counted from 1, whose creation the runner refuses. */
  readonly refuse?: number;
  /** The task job, counted from 1, whose results the runner no longer has. */
  readonly lose?: number;
  /** Run from a bare clone, with no checkout, as the webhook driver fetches a commit. */
  readonly bare?: boolean;
}

describe('armada run', () => {
  /** `armada run HEAD …` in a one-commit repository, against a runner that answers the plan and the one task with
   *  these outputs: what the CLI printed, how it exited, and what it asked of the runner. */
  async function run(args: readonly string[], plan: Json, verdict: Json, runner: Runner = {}) {
    const { deadline, planDelayMs = 0, taskExit = 0, planExit = 0, planConfig = { command: ['plan'] }, taskConfig = {}, timings = { rows: {}, files: {} }, artifacts, exitOf, refuse, lose } = runner;
    const scratch = mkdtempSync(join(tmpdir(), 'armada-run-'));
    const repo = join(scratch, 'repo');
    const commands: string[][] = [];
    const bodies: unknown[] = [];
    const seen: string[] = [];
    const cancelled: string[] = [];
    // Each task job's items, by its id: the first is `tasks`, the next `tasks-2` and on.
    const tasked = new Map<string, Json[]>();
    const outcome = { index: 0, kind: 'exited', exitCode: 0, seconds: 1, vessel: 'v1', attempt: 1, tail: '', output: true };

    /** What job `id` lands, the one description its events and its status both read: each task's exit code. The plan
     *  lands one task; a task job, each of its items by `exitOf`, else each artifacts archive green, else one task. */
    const exitsOf = (id: string): number[] => {
      const items = tasked.get(id);

      if (items === undefined) return [planExit];

      if (exitOf !== undefined) return items.map(exitOf);

      return artifacts === undefined ? [taskExit] : artifacts.map(() => 0);
    };

    const status = (id: string) => {
      const exits = exitsOf(id);

      return {
        id, label: '', phase: 'done', key: 'k'.repeat(64), createdAt: 0, startedAt: 0, finishedAt: 1, vessels: [], problems: [], environment: null,
        tasks: { total: exits.length, queued: 0, running: 0, exited: exits.length, red: exits.filter((exit) => exit !== 0).length, failed: 0 },
      };
    };

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);

        seen.push(`${request.method} ${pathname.split('/').slice(0, 3).join('/')}`);

        if (pathname.endsWith('/cancel')) cancelled.push(pathname.split('/')[2] ?? '');

        if (pathname === '/environments/resolve') return Response.json({ key: 'k'.repeat(64), base: 'root' });

        if (pathname === '/timings/proj' && request.method === 'GET') return Response.json(timings);

        if (pathname === '/jobs') {
          const body: unknown = await request.json();
          const { items } = v.parse(v.object({ items: v.array(v.object({ item: JsonSchema, argv: v.array(v.string()) })) }), body);

          bodies.push(body);
          commands.push(items[0]?.argv ?? []);

          if (commands.at(-1)?.includes('task') !== true) return Response.json({ id: 'plan' });

          if (tasked.size + 1 === refuse) return Response.json({ error: 'refused' }, { status: 400 });
          const id = tasked.size === 0 ? 'tasks' : `tasks-${String(tasked.size + 1)}`;

          tasked.set(id, items.map(({ item }) => item));

          return Response.json({ id });
        }

        const job = pathname.split('/')[2] ?? '';

        if (lose !== undefined && job === (lose === 1 ? 'tasks' : `tasks-${String(lose)}`) && !pathname.endsWith('/cancel')) return Response.json({ error: 'no such job' }, { status: 404 });

        if (pathname.endsWith('/events')) {
          // A task job of artifacts lands each task with its archive.
          const archives = tasked.has(job) && exitOf === undefined && artifacts !== undefined;

          return Response.json({ events: exitsOf(job).map((exitCode, index) => ({ seq: index + 1, outcome: { ...outcome, index, exitCode, artifacts: archives } })), done: true });
        }

        const archive = /^\/jobs\/tasks\/tasks\/(\d+)\/artifacts$/u.exec(pathname)?.[1];

        if (archive !== undefined) return new Response(artifacts?.[Number(archive)]);

        if (pathname === '/jobs/plan/tasks/0/output') {
          if (planDelayMs > 0) await Bun.sleep(planDelayMs);

          return new Response(JSON.stringify(plan));
        }

        if (pathname === '/jobs/tasks/tasks/0/output') return new Response(JSON.stringify(verdict));

        if (pathname.startsWith('/jobs/')) return Response.json(status(pathname.split('/')[2] ?? ''));

        return request.method === 'HEAD' ? new Response(null) : Response.json({ ok: true });
      },
    });

    try {
      mkdirSync(repo);
      git(repo, 'init', '-q');

      for (const [file, text] of Object.entries(runner.files ?? {})) {
        mkdirSync(join(repo, file, '..'), { recursive: true });
        writeFileSync(join(repo, file), text);
      }

      writeFileSync(join(repo, '.armada.json'), JSON.stringify({ name: 'proj', deadline, environment: {}, plan: planConfig, task: { command: ['task', '{out}'], ...taskConfig }, ...runner.config }));
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'one');

      if (runner.bare === true) git(scratch, 'clone', '-q', '--bare', repo, 'repo.git');

      const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'HEAD', ...args], {
        cwd: runner.bare === true ? join(scratch, 'repo.git') : repo, env: { ...scratchEnv(), HOME: scratch, ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      const exit = await cli.exited;
      const stdout = await new Response(cli.stdout).text();
      const stderr = await new Response(cli.stderr).text();
      // The report it names, and the evidence each artifact directory holds, read before its home goes.
      const path = /^report: (.+)$/mu.exec(stdout)?.[1];
      const report = path === undefined || !existsSync(path) ? '' : readFileSync(path, 'utf8');
      const directories = report === '' ? {} : v.parse(v.looseObject({ artifacts: v.optional(v.record(v.string(), v.string()), {}) }), JSON.parse(report)).artifacts;
      const evidence = Object.fromEntries(Object.entries(directories).map(([index, dir]) => [index, { dir, files: Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), 'utf8')])) }]));

      return { exit, stdout, stderr, commands, bodies, seen, cancelled, report, evidence };
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** A commit with three environments: the project's, and py312 and py314 over it, each installing its own Python. */
  const environments = {
    config: { environment: { install: 'ci/install.sh' }, environments: { py312: { install: 'ci/py312.sh' }, py314: { install: 'ci/py314.sh' } } },
    files: { 'ci/install.sh': 'echo project', 'ci/py312.sh': 'echo 3.12', 'ci/py314.sh': 'echo 3.14' },
  };

  /** Each task job a run started: its environment's install, each task's argv, and its pool. */
  const taskJobs = (bodies: readonly unknown[]) => bodies.slice(1).map((body) => {
    const { recipe, items, pool } = v.parse(v.object({ recipe: v.object({ install: v.string() }), items: v.array(v.object({ argv: v.array(v.string()) })), pool: v.number() }), body);

    return { install: recipe.install, argv: items.map(({ argv }) => argv), pool };
  });

  const reportOf = (report: string) => v.parse(v.looseObject({
    graded: v.string(), problems: v.array(v.string()), verdicts: v.object({ rows: v.array(v.looseObject({ name: v.string(), exitCode: v.number() })) }),
    jobs: v.optional(v.array(v.looseObject({ environment: v.string(), job: v.string() }))),
  }), JSON.parse(report));

  const exitOf = (item: Json) => v.is(v.object({ name: v.literal('red') }), item) ? 1 : 0;

  test('runs each environment\'s entries in a task job of its own, {index} the plan\'s, and grades every row as one run (#31)', async () => {
    const plan: Json = { include: [{ name: 'a' }, { name: 'b', environment: 'py314' }, { name: 'red', environment: 'py314' }, { name: 'd', environment: 'py312' }] };
    const ran = await run([], plan, {}, { ...environments, config: { ...environments.config, pool: 6 }, taskConfig: { command: ['task', '{name}', '{index}'], verdict: false }, exitOf });
    const report = reportOf(ran.report);

    // The jobs are made at once, so the runner may get them in any order: each is told by its environment's install.
    const byInstall = Object.fromEntries(taskJobs(ran.bodies).map(({ install, argv, pool }) => [install, { argv, pool }]));

    expect({
      exit: ran.exit, jobs: byInstall, rows: report.verdicts.rows.map(({ name, exitCode }) => [name, exitCode]),
      each: report.jobs?.map(({ environment }) => environment), ids: report.jobs?.map(({ job }) => job).toSorted((left, right) => left.localeCompare(right)),
    }).toEqual({
      exit: 1,
      jobs: {
        'echo project': { argv: [['task', 'a', '0']], pool: 1 },
        'echo 3.14': { argv: [['task', 'b', '1'], ['task', 'red', '2']], pool: 2 },
        'echo 3.12': { argv: [['task', 'd', '3']], pool: 1 },
      },
      rows: [['a', 0], ['b', 0], ['red', 1], ['d', 0]],
      each: ['', 'py314', 'py312'],
      ids: ['tasks', 'tasks-2', 'tasks-3'],
    });
  });

  test('runs every environment at once within the pool, each job on at least its widest gang, and refuses a plan that needs more (#31)', async () => {
    const gang = await run([], { include: [{ name: 'a' }, { name: 'g', environment: 'py314', gang: 6 }] }, {}, { ...environments, config: { ...environments.config, pool: 8 }, taskConfig: { verdict: false }, exitOf });
    const three: Json = { include: [{ name: 'a' }, { name: 'b', environment: 'py314' }, { name: 'c', environment: 'py312' }] };
    const crowded = await run([], three, {}, { ...environments, config: { ...environments.config, pool: 2 }, taskConfig: { verdict: false }, exitOf });
    // A gang wider than the pool counts whole toward what the plan needs.
    const wide = await run([], { include: [{ name: 'a' }, { name: 'g', environment: 'py314', gang: 6 }] }, {}, { ...environments, config: { ...environments.config, pool: 4 }, taskConfig: { verdict: false }, exitOf });
    const said = [crowded, wide].map((ran) => reportOf(ran.report).problems.find((problem) => problem.includes('containers')) ?? '');

    expect({ gang: [gang.exit, taskJobs(gang.bodies).map(({ pool }) => pool).toSorted((left, right) => left - right)], refused: [crowded, wide].map((ran) => [ran.exit, taskJobs(ran.bodies).length, reportOf(ran.report).graded]), need: said.map((problem) => /need (\d+) containers/u.exec(problem)?.[1]) })
      .toEqual({ gang: [0, [1, 6]], refused: [[2, 0, 'not graded'], [2, 0, 'not graded']], need: ['3', '7'] });
  });

  test('is not graded, and leaves no task job running, when the plan names an unknown environment or a task job does not start (#31)', async () => {
    const unknown = await run([], { include: [{ name: 'a' }, { name: 'b', environment: 'py399' }] }, {}, { ...environments, taskConfig: { verdict: false }, exitOf });
    const refused = await run([], { include: [{ name: 'a' }, { name: 'b', environment: 'py314' }] }, {}, { ...environments, taskConfig: { verdict: false }, exitOf, refuse: 2 });
    // The runner loses the second job's results while it is followed.
    const lost = await run([], { include: [{ name: 'a' }, { name: 'b', environment: 'py314' }] }, {}, { ...environments, taskConfig: { verdict: false }, exitOf, lose: 2 });

    expect([unknown, refused].map((ran) => ({ exit: ran.exit, started: taskJobs(ran.bodies).length, cancelled: ran.cancelled, graded: reportOf(ran.report).graded })))
      .toEqual([{ exit: 2, started: 0, cancelled: [], graded: 'not graded' }, { exit: 2, started: 2, cancelled: ['tasks'], graded: 'not graded' }]);
    expect({ exit: lost.exit, cancelled: lost.cancelled.toSorted((left, right) => left.localeCompare(right)) }).toEqual({ exit: 2, cancelled: ['tasks', 'tasks-2'] });
    expect(reportOf(unknown.report).problems.some((problem) => problem.includes('py399'))).toBe(true);
  });

  test('names a task by its configured key, even its environment (#31)', async () => {
    const plan = { include: [{ name: 'smoke', environment: 'py312' }, { name: 'smoke', environment: 'py314' }] };
    const ran = await run([], plan, {}, { ...environments, taskConfig: { name: 'environment', verdict: false }, exitOf });

    expect({ exit: ran.exit, rows: reportOf(ran.report).verdicts.rows.map(({ name }) => name) }).toEqual({ exit: 0, rows: ['py312', 'py314'] });
  });

  test('defaults below GitHub\'s 40-minute timeout, and a CLI deadline overrides the commit\'s config', async () => {
    const plan = { include: [{ name: 'a', rows: ['x'] }] };
    const verdict = { rows: [{ name: 'x', exitCode: 0 }] };
    const defaults = await run([], plan, verdict);
    const override = await run(['--deadline=60'], plan, verdict, { deadline: 2100 });

    for (const [ran, most] of [[defaults, 1800], [override, 60]] as const) {
      expect(ran.exit).toBe(0);
      expect(ran.bodies).toHaveLength(2);

      for (const body of ran.bodies) {
        const { deadline: bound, timeout } = v.parse(v.object({ deadline: v.number(), timeout: v.number() }), body);

        expect(bound).toBeGreaterThan(0);
        expect(bound).toBeLessThanOrEqual(most);
        expect(timeout).toBeLessThanOrEqual(bound);
      }
    }
  });

  test('the plan and task jobs share one CI deadline rather than each getting a fresh one', async () => {
    const ran = await run([], { include: [{ name: 'a', rows: ['x'] }] }, { rows: [{ name: 'x', exitCode: 0 }] }, { deadline: 30, planDelayMs: 1100 });
    const bounds = ran.bodies.map((body) => v.parse(v.object({ deadline: v.number() }), body).deadline);

    expect(ran.exit).toBe(0);
    expect(bounds).toHaveLength(2);
    expect(bounds[0]).toBeLessThanOrEqual(30);
    expect(bounds[1]).toBeLessThan(bounds[0] ?? 0);
  });

  test('a local plan is bounded by the same CI deadline', async () => {
    const ran = await run(['--deadline=1'], null, null, { planConfig: { command: [process.execPath, '-e', 'await Bun.sleep(10000)'], local: true } });

    const report = v.parse(v.looseObject({ graded: v.string(), problems: v.array(v.string()) }), JSON.parse(ran.report));

    // Stopped at the deadline, not after the plan's 10 s, and said in the run's report.
    expect({ exit: ran.exit, commands: ran.commands.length, graded: report.graded, deadline: report.problems.some((problem) => problem.includes('CiDeadlineExceeded')) })
      .toEqual({ exit: 2, commands: 0, graded: 'not graded', deadline: true });
  });

  test('an invalid deadline is refused before submitting anything', async () => {
    const ran = await run(['--deadline=0'], null, null);

    expect(ran.exit).toBe(2);
    expect(ran.seen).toHaveLength(0);
    expect(ran.stderr).toContain('--deadline takes a positive whole number');
  });

  test('words after -- reach the plan, and a narrowed run stores neither the verdict nor its timings; a full one both', async () => {
    const full = await run([], { include: [{ name: 'a', rows: ['x'] }] }, { rows: [{ name: 'x', exitCode: 0, seconds: 2 }] });
    const ran = await run(['--', '--tier', 'fast'], { include: [{ name: 'a', rows: ['x'] }] }, { rows: [{ name: 'x', exitCode: 0, seconds: 2 }] });
    const told = (each: typeof ran) => ({ verdicts: each.seen.filter((one) => one.startsWith('PUT /verdicts')), timings: each.seen.includes('POST /timings/proj') });

    expect({ exit: ran.exit, plan: ran.commands[0]?.slice(-3), narrowed: told(ran), full: told(full) })
      .toEqual({ exit: 0, plan: ['plan', '--tier', 'fast'], narrowed: { verdicts: [], timings: false }, full: { verdicts: ['PUT /verdicts/proj'], timings: true } });
  });

  test('a CI deadline passed before the task jobs could start leaves the run ungraded, with its report and its --json object (#37)', async () => {
    // The plan job ends green, but its answer comes 1.5 s in, past the run's 1 s.
    const ran = await run(['--deadline=1', '--json'], { include: [{ name: 'a', rows: ['x'] }] }, { rows: [{ name: 'x', exitCode: 0, seconds: 2 }] }, { planDelayMs: 1500 });
    const result = v.parse(v.looseObject({ graded: v.string(), report: v.string(), problems: v.array(v.string()) }), JSON.parse(ran.stdout));

    expect({ exit: ran.exit, graded: result.graded, jobs: ran.bodies.length, passed: result.problems.some((problem) => problem.includes('before its task jobs could start')), report: result.report.endsWith('.json') })
      .toEqual({ exit: 2, graded: 'not graded', jobs: 1, passed: true, report: true });
  });

  test('a task cut off before its verdict makes its rows red, also rows that declare files (#36)', async () => {
    const rows = [{ name: 'unit-a', files: ['a.test.ts'] }, 'unit-b'];
    const ran = await run([], { include: [{ name: 'unit', rows }] }, null, { taskExit: 124 });

    expect({ exit: ran.exit, graded: ran.stdout.includes('NOT GRADED') ? 'not graded' : 'graded', red: ['unit-a', 'unit-b'].every((row) => ran.stdout.includes(`RED  ${row}`)) })
      .toEqual({ exit: 1, graded: 'graded', red: true });
  });

  test('a task gets the deployment secrets its config names, and the plan gets none', async () => {
    const ran = await run([], { include: [{ name: 'a', rows: ['x'] }] }, { rows: [{ name: 'x', exitCode: 0, seconds: 2 }] }, { taskConfig: { secrets: ['CACHE_TOKEN'] } });
    const secrets = ran.bodies.map((body) => v.parse(v.object({ secrets: v.optional(v.array(v.string())) }), body).secrets ?? []);

    expect({ exit: ran.exit, secrets }).toEqual({ exit: 0, secrets: [[], ['CACHE_TOKEN']] });
  });

  test('a local plan runs in the checkout of the commit, with its target and timings filled, and no plan job; a bare repository plans in a container (#33)', async () => {
    const plan = { include: [{ name: 'a', rows: ['x'] }] };
    // The plan checks what it was given: the timings file the runner answered, and the default target.
    const command = ['sh', '-c', `grep -q '"rows"' "$1" && [ "$2" = 300 ] && echo '${JSON.stringify(plan)}'`, 'plan', '{timings}', '{target}'];
    const verdict = { rows: [{ name: 'x', exitCode: 0, seconds: 2 }] };
    const ran = await Promise.all([false, true].map(async (bare) => await run([], plan, verdict, { planConfig: { command, local: true }, bare })));

    expect(ran.map(({ exit, commands }) => ({ exit, jobs: commands.length, task: commands.at(-1)?.slice(-2) }))).toEqual([
      { exit: 0, jobs: 1, task: ['task', '/armada/task/out'] },
      { exit: 0, jobs: 2, task: ['task', '/armada/task/out'] },
    ]);
  });

  test('a task that exits 0 with a red row among its rows is named RED as it lands, with the row', async () => {
    const ran = await run([], { include: [{ name: 'part-1', rows: ['x.mjs', 'y.mjs'] }] }, {
      rows: [{ name: 'x.mjs', exitCode: 0, seconds: 2 }, { name: 'y.mjs', exitCode: 1, seconds: 1, output: 'AssertionError: y broke' }],
    });

    const line = ran.stdout.split('\n').find((each) => each.includes('part-1'));

    expect({ exit: ran.exit, line: line?.replace(/^\s*\d+:\d+\s+/u, ''), told: ran.stdout.includes('AssertionError: y broke') })
      .toEqual({ exit: 1, line: 'part-1         RED: 1 of 2 rows (y.mjs) in 0:01 on v1', told: true });
  });

  test('an entry with no weight of its own dispatches by its estimate; its own weight wins', async () => {
    const ran = await run([], { include: [{ name: 'a' }, { name: 'b' }, { name: 'c', weight: 7 }] }, '', { taskConfig: { verdict: false }, timings: { rows: { a: 42, b: 10 }, files: {} } });
    const items = v.parse(v.object({ items: v.array(v.looseObject({ item: v.looseObject({ name: v.optional(v.string()), weight: v.optional(v.number()) }) })) }), ran.bodies[1]).items;

    expect(items.map((task) => [task.item.name, task.item.weight])).toEqual([['a', 42], ['b', 10], ['c', 7]]);
  });

  test('a run\'s pool counts each rank of a gang, so a gang wider than the plan has entries is not refused', async () => {
    const ran = await run([], { include: [{ name: 'test' }, { name: 'relay', gang: 4 }] }, '', { taskConfig: { verdict: false } });
    // The plan job's pool, then the task job's: one container for `test` and four for the gang's ranks.
    expect(ran.bodies.map((body) => v.parse(v.looseObject({ pool: v.optional(v.number()) }), body).pool)).toEqual([1, 5]);
  });

  test('a run it cannot grade names its report, which says so and holds the rows that did report', async () => {
    const ran = await run([], { include: [{ name: 'part-1', rows: ['x.mjs', 'y.mjs'] }] }, { rows: [{ name: 'x.mjs', exitCode: 0, seconds: 2 }] });
    const path = /^report: (.+)$/mu.exec(ran.stdout)?.[1] ?? '';
    const report = v.parse(v.looseObject({ graded: v.string(), verdicts: v.object({ rows: v.array(v.looseObject({ name: v.string(), exitCode: v.number() })) }) }), JSON.parse(ran.report));

    expect({ exit: ran.exit, said: ran.stdout.includes('NOT GRADED'), named: path.endsWith('proj-tasks.json'), graded: report.graded, rows: report.verdicts.rows.map((row) => [row.name, row.exitCode]) })
      .toEqual({ exit: 2, said: true, named: true, graded: 'not graded', rows: [['x.mjs', 0]] });
  });

  test('a plan that fails, or prints no plan, ends the run ungraded with a report that says why, and starts no task', async () => {
    const reports = await Promise.all([
      run([], { include: [{ name: 'a', rows: ['x'] }] }, '', { planExit: 1 }),
      run([], 'not a plan', ''),
    ]);

    expect(reports.map((ran) => {
      const report = v.parse(v.looseObject({ graded: v.string(), planJob: v.string(), job: v.null(), problems: v.array(v.string()) }), JSON.parse(ran.report));

      return { exit: ran.exit, jobs: ran.commands.length, graded: report.graded, plan: report.planJob, problems: report.problems.length };
    })).toEqual([{ exit: 2, jobs: 1, graded: 'not graded', plan: 'plan', problems: 1 }, { exit: 2, jobs: 1, graded: 'not graded', plan: 'plan', problems: 1 }]);
  });

  test('two tasks of one name each keep their own evidence, under their index', async () => {
    const made: string[] = [];

    const tar = (file: string, text: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'armada-evidence-'));

      made.push(dir);
      writeFileSync(join(dir, file), text);

      return Bun.spawnSync(['tar', '-czf', '-', '-C', dir, file]).stdout;
    };

    try {
      const ran = await run([], { include: [{ name: 'unit', rows: ['x'] }, { name: 'unit', rows: ['y'] }] }, '', {
        taskConfig: { verdict: false },
        artifacts: [tar('evidence.txt', 'first'), tar('evidence.txt', 'second')],
      });

      expect({ apart: ran.evidence['0']?.dir !== ran.evidence['1']?.dir, files: [ran.evidence['0']?.files, ran.evidence['1']?.files] })
        .toEqual({ apart: true, files: [{ 'evidence.txt': 'first' }, { 'evidence.txt': 'second' }] });
    } finally {
      for (const dir of made) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a row a problem names reads red in the report, with the problem, though its task reported it green', async () => {
    const ran = await run([], { include: [{ name: 'part-1', rows: ['x.mjs'] }] }, { rows: [{ name: 'x.mjs', exitCode: 0, seconds: 2 }, { name: 'w.mjs', exitCode: 0, seconds: 1 }] });
    const report = v.parse(v.looseObject({ graded: v.string(), verdicts: v.object({ rows: v.array(v.looseObject({ name: v.string(), exitCode: v.number(), problem: v.optional(v.string()) })) }) }), JSON.parse(ran.report));

    expect({ exit: ran.exit, graded: report.graded, rows: report.verdicts.rows.map((row) => [row.name, row.exitCode, row.problem ?? null]) }).toEqual({
      exit: 2, graded: 'not graded', rows: [['x.mjs', 0, null], ['w.mjs', 2, 'part-1 reported w.mjs, which its plan entry does not name']],
    });
  });

  test('a task cut off before it wrote a verdict is graded red, each row its entry names with its exit', async () => {
    const ran = await run([], { include: [{ name: 'part-1', rows: ['x.mjs', 'y.mjs'] }] }, '', { taskExit: 124 });

    expect({ exit: ran.exit, graded: !ran.stdout.includes('NOT GRADED'), reds: ['x.mjs', 'y.mjs'].map((name) => ran.stdout.includes(`RED  ${name}  (exit 124`)) })
      .toEqual({ exit: 1, graded: true, reds: [true, true] });
  });

  test('with --json, prints its progress to stderr and one result to stdout, graded as its exit says', async () => {
    const ran = await run(['--json'], { include: [{ name: 'part-1', rows: ['x.mjs'] }] }, { rows: [{ name: 'x.mjs', exitCode: 1, seconds: 2, output: 'broke' }] });
    const result = v.parse(v.looseObject({ graded: v.string(), job: v.string(), report: v.string(), rows: v.array(v.looseObject({ name: v.string(), exitCode: v.number() })) }), JSON.parse(ran.stdout));

    expect({ exit: ran.exit, graded: result.graded, job: result.job, report: result.report.endsWith('proj-tasks.json'), rows: result.rows.map((row) => [row.name, row.exitCode]) })
      .toEqual({ exit: 1, graded: 'fail', job: 'tasks', report: true, rows: [['x.mjs', 1]] });
  });

  test('a task that wrote its verdict and then exited nonzero is graded, its green rows red with its exit', async () => {
    const ran = await run([], { include: [{ name: 'part-1', rows: ['x.mjs'] }] }, { rows: [{ name: 'x.mjs', exitCode: 0, seconds: 2 }] }, { taskExit: 7 });

    expect({ exit: ran.exit, graded: !ran.stdout.includes('NOT GRADED'), red: ran.stdout.includes('RED  x.mjs  (exit 7') }).toEqual({ exit: 1, graded: true, red: true });
  });
});

describe('a CI deadline', () => {
  test('each later job gets only the remaining time, and none can start at or after the deadline', () => {
    const began = Date.now();

    try {
      setSystemTime(began);
      expect(remainingDeadline(began + 1800_000)).toBe(1800);
      setSystemTime(began + 300_000);
      expect(remainingDeadline(began + 1800_000)).toBe(1500);
      setSystemTime(began + 1800_000);
      expect(remainingDeadline(began + 1800_000)).toBe(null);
    } finally {
      setSystemTime();
    }
  });
});

describe('asking the runner', () => {
  test('asks a read again past a gateway error or the Worker\'s own 500, and never a write', async () => {
    const original = globalThis.fetch;
    const sleep = Bun.sleep;
    const seen: string[] = [];
    let failures = 2;

    Bun.sleep = (async () => undefined);
    globalThis.fetch = fakeFetch((request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);

      if (failures > 0) {
        failures -= 1;

        // A gateway's page, then the Worker's own exception, as a Durable Object restarted under a read gives.
        return failures === 1 ? new Response('<title>502 Bad Gateway</title>', { status: 502 })
          : new Response('Worker threw exception', { status: 500 });
      }

      return Response.json({ ok: true });
    });

    try {
      const armada = new Armada({ url: 'https://armada.test', token: 't', account: 'a' });

      expect(await (await armada.call('/health')).json()).toEqual({ ok: true });
      expect(seen.splice(0)).toEqual(['GET /health', 'GET /health', 'GET /health']);
      failures = 1;
      expect(armada.post('/jobs', {})).rejects.toThrow('POST /jobs: 500');
      await Promise.resolve();
      expect(seen).toEqual(['POST /jobs']);
    } finally {
      globalThis.fetch = original;
      Bun.sleep = sleep;
    }
  });
});

describe('the webhook command', () => {
  test('add creates the GitHub hook, then stores its secret; add again updates that hook; list shows no secret; remove deletes both', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    // The deployment's configs, as its route keeps them: the list answers what the last POST stored, secret out.
    let stored: { repo: string; pullRequests: boolean; hook?: number } | null = null;

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        const body: unknown = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.json();

        calls.push({ method: request.method, path: pathname, body });

        if (request.method === 'POST' && pathname === '/webhooks/armada') {
          stored = v.parse(v.object({ repo: v.string(), pullRequests: v.boolean(), hook: v.optional(v.number()) }), body);

          return Response.json({ configured: 'armada' });
        }

        if (request.method === 'GET' && pathname === '/webhooks') {
          return Response.json({ webhooks: stored === null ? [] : [{ project: 'armada', repo: stored.repo, pullRequests: stored.pullRequests, tokenSecret: 'GITHUB_TOKEN', hook: stored.hook }] });
        }

        if (request.method === 'DELETE' && pathname === '/webhooks/armada') return Response.json({ removed: 'armada' });

        return Response.json({ error: 'no route' }, { status: 404 });
      },
    });

    const scratch = mkdtempSync(join(tmpdir(), 'armada-hook-'));

    // A stub `gh`: signed in, and a hook create or update answers id 77 while remembering every call.
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> ${scratch}/gh-calls\nif [ "$1" = "api" ]; then echo 77; fi\nexit 0\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    try {
      const env = { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't'.repeat(32), PATH: `${bin}:${process.env.PATH}` };

      const cli = async (...words: string[]) => {
        const ran = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), ...words], { env, stdout: 'pipe', stderr: 'pipe' });

        return { exit: await ran.exited, said: await new Response(ran.stdout).text() + await new Response(ran.stderr).text() };
      };

      const added = await cli('webhook', 'add', 'armada', '--repo=owner/armada', '--pull-requests');
      const again = await cli('webhook', 'add', 'armada', '--repo=owner/armada', '--pull-requests');
      const listed = await cli('webhook', 'list');
      const removed = await cli('webhook', 'remove', 'armada');
      const ghCalls = existsSync(join(scratch, 'gh-calls')) ? readFileSync(join(scratch, 'gh-calls'), 'utf8') : '';
      const posted = calls.filter(({ method, path }) => method === 'POST' && path === '/webhooks/armada').map(({ body }) => v.parse(v.object({ secret: v.string(), hook: v.number() }), body));

      expect({ added: added.exit, again: again.exit }).toEqual({ added: 0, again: 0 });
      expect(added.said).toContain('created GitHub hook 77');
      expect(again.said).toContain('updated GitHub hook 77');
      // Each add stored the secret it gave GitHub, with the hook's id, so the two never differ.
      expect(posted.map(({ hook }) => hook)).toEqual([77, 77]);
      expect(posted.every(({ secret }) => /^[0-9a-f]{48}$/u.test(secret) && ghCalls.includes(`config[secret]=${secret}`))).toBe(true);
      expect(ghCalls).toContain('repos/owner/armada/hooks/77 -X PATCH');
      expect(listed.said).toContain('armada  owner/armada');
      expect(listed.said).not.toContain('secret');
      expect(removed.said).toContain('removed armada');
      expect(removed.said).toContain('deleted GitHub hook 77');
      expect(ghCalls).toContain('repos/owner/armada/hooks/77 -X DELETE');
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('changes GitHub only for a config the deployment takes, keeps a project whose GitHub hook could not be deleted, and adds by hand where gh is not installed', async () => {
    const calls: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);

        calls.push(`${request.method} ${pathname}`);

        if (request.method === 'GET' && pathname === '/webhooks') return Response.json({ webhooks: [{ project: 'armada', repo: 'owner/armada', pullRequests: false, tokenSecret: 'GITHUB_TOKEN', hook: 77 }] });

        return Response.json({ configured: 'armada' });
      },
    });

    const scratch = mkdtempSync(join(tmpdir(), 'armada-hook-'));
    const bin = join(scratch, 'bin');

    mkdirSync(bin);
    // Signed in; every hook change GitHub refuses, and each call is kept.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> ${scratch}/gh-calls\nif [ "$1" = "auth" ]; then exit 0; fi\necho "HTTP 403" >&2\nexit 1\n`, { mode: 0o755 });

    try {
      const cli = async (path: string, ...words: string[]) => {
        const ran = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), ...words], { env: { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't'.repeat(32), PATH: path }, stdout: 'pipe', stderr: 'pipe' });

        return await ran.exited;
      };

      const withGh = bin;
      const badSecret = await cli(withGh, 'webhook', 'add', 'armada', '--repo=owner/armada', '--token-secret=github-token');
      const ghAfterBadSecret = existsSync(join(scratch, 'gh-calls')) ? readFileSync(join(scratch, 'gh-calls'), 'utf8').includes('PATCH') : false;
      const removed = await cli(withGh, 'webhook', 'remove', 'armada');
      const deletedHere = calls.includes('DELETE /webhooks/armada');
      // A remove that deleted GitHub's hook and stopped before the deployment's config: GitHub now answers 404.
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\necho "gh: Not Found (HTTP 404)" >&2\nexit 1\n`, { mode: 0o755 });
      const again = await cli(withGh, 'webhook', 'remove', 'armada');
      // No gh on the PATH, nor anything else: a new project's hook is printed to add by hand.
      const noGh = await cli('', 'webhook', 'add', 'other', '--repo=owner/other');

      expect({ badSecret, ghAfterBadSecret, removed, deletedHere, again, deletedAfter: calls.includes('DELETE /webhooks/armada'), noGh })
        .toEqual({ badSecret: 2, ghAfterBadSecret: false, removed: 2, deletedHere: false, again: 0, deletedAfter: true, noGh: 0 });
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('add without gh, or with an update gh could not make, refuses to change a hook GitHub already signs for; a new one is printed to add by hand', async () => {
    const posted: string[] = [];
    let hooked = false;

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);

        if (request.method === 'POST' && pathname === '/webhooks/armada') posted.push(pathname);

        if (request.method === 'POST' && pathname === '/webhooks/armada') return Response.json({ configured: 'armada' });

        if (request.method === 'GET' && pathname === '/webhooks') {
          return Response.json({ webhooks: hooked ? [{ project: 'armada', repo: 'owner/armada', pullRequests: false, tokenSecret: 'GITHUB_TOKEN', hook: 77 }] : [] });
        }

        return Response.json({ error: 'no route' }, { status: 404 });
      },
    });

    const scratch = mkdtempSync(join(tmpdir(), 'armada-hook-'));
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);

    try {
      const env = { ...scratchEnv(), ARMADA_URL: server.url.href, ARMADA_TOKEN: 't'.repeat(32), PATH: `${bin}:${process.env.PATH}` };

      const add = async () => {
        const ran = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'webhook', 'add', 'armada', '--repo=owner/armada'], { env, stdout: 'pipe', stderr: 'pipe' });

        return { exit: await ran.exited, said: await new Response(ran.stdout).text() + await new Response(ran.stderr).text() };
      };

      const fresh = await add();

      hooked = true;
      const refused = await add();

      expect({ exit: fresh.exit, hasUrl: fresh.said.includes('/webhooks/github/armada'), hasSecret: /secret: [0-9a-f]{48}/u.test(fresh.said), steps: fresh.said.includes('add the hook by hand') })
        .toEqual({ exit: 0, hasUrl: true, hasSecret: true, steps: true });
      expect({ exit: refused.exit, said: refused.said.includes('updating its secret needs gh signed in'), posts: posted.length }).toEqual({ exit: 2, said: true, posts: 1 });

      // Signed in, but GitHub refuses the update: the deployment keeps the secret GitHub still signs with.
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\necho "HTTP 404: Not Found" >&2\nexit 1\n');
      const unmade = await add();

      expect({ exit: unmade.exit, said: unmade.said.includes('updating GitHub hook 77 on owner/armada failed'), posts: posted.length }).toEqual({ exit: 2, said: true, posts: 1 });
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
