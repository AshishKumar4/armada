import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { packBase, packOf } from '../src/ci';
import { matches, parseConfig } from '../src/config';
import { grade, rowName, taskName, underExit, type TaskAnswer } from '../src/grade';
import { environmentKey, failureTail, fill, itemValues, medians, recordSamples, weightOf, type Recipe } from '../src/protocol';
import { Armada, PACK_PART } from '../src/sdk';

describe('a task\'s command', () => {
  test('fills from the item: a string as itself, an object\'s scalar keys, its JSON as {item}', () => {
    const object = { row: 'bun test a.test.ts', weight: 12.5, nested: { no: true } };

    expect({
      text: fill('echo {item} {index}', itemValues('hello', 3)),
      object: fill('ladder --ci-row={row} --weight={weight}', itemValues(object, 0)),
      json: fill('{item}', itemValues(object, 0)),
    }).toEqual({ text: 'echo hello 3', object: 'ladder --ci-row=bun test a.test.ts --weight=12.5', json: JSON.stringify(object) });
  });

  test('a placeholder the task does not have is refused, never left empty', () => {
    expect(() => fill('--part={part}', itemValues({ row: 'x' }, 0))).toThrow('{part}');
  });

  test('an item weighs its numeric `weight`, and anything else nothing', () => {
    expect([weightOf({ weight: 301 }), weightOf({ weight: '9' }), weightOf('a'), weightOf(null), weightOf([1])]).toEqual([301, 0, 0, 0, 0]);
  });
});

describe('a failed step', () => {
  test('says its error last and whole, however much its stdout printed before it', () => {
    const apt = 'Setting up ruby (1:3.3+b1) ...\n'.repeat(500);

    expect(failureTail(apt, 'setup.sh: 14: locale-gen: not found\n').endsWith('Setting up ruby (1:3.3+b1) ...\nsetup.sh: 14: locale-gen: not found\n')).toBe(true);
    expect(failureTail(apt, 'x'.repeat(5000))).toBe('x'.repeat(3000));
    expect(failureTail('ok\n', '')).toBe('ok\n');
  });
});

describe('an environment', () => {
  test('is keyed by the recipe\'s own text and the driver, so a fixed script is a new environment', async () => {
    const recipe: Recipe = { base: 'cloudflare/debian-trixie', setup: 'apt-get install -y git', install: '', smoke: '', instance: 'standard-4' };
    const repo = { project: 'kinu', checkout: '/home/ci/work/kinu/kinu', history: 'full' as const, manifest: [{ path: 'bun.lock', id: 'a'.repeat(40) }, { path: 'package.json', id: 'b'.repeat(40) }] };
    const key = await environmentKey(recipe);
    const keys = {
      fixed: await environmentKey({ ...recipe, setup: 'apt-get install -y git strace' }),
      rebased: await environmentKey({ ...recipe, base: 'cloudflare/debian-trixie@sha256:' + 'c'.repeat(64) }),
      repo: await environmentKey({ ...recipe, repo }),
      reordered: await environmentKey({ ...recipe, repo: { ...repo, manifest: [...repo.manifest].reverse() } }),
      relocked: await environmentKey({ ...recipe, repo: { ...repo, manifest: [{ path: 'bun.lock', id: 'd'.repeat(40) }, ...repo.manifest.slice(1)] } }),
    };

    expect({ fixed: keys.fixed === key, rebased: keys.rebased === key, repo: keys.repo === key, reordered: keys.reordered === keys.repo, relocked: keys.relocked === keys.repo })
      .toEqual({ fixed: false, rebased: false, repo: false, reordered: true, relocked: false });
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
    const base = { name: 'kinu', environment: { setup: 'ci/setup.sh' }, plan: { command: ['plan'] }, task: { command: ['run', '{row}'] } };
    const config = parseConfig(JSON.stringify(base));

    expect({ base: config.environment.base, history: config.history, pool: config.pool, verdict: config.task.verdict, idempotent: config.task.idempotent })
      .toEqual({ base: 'cloudflare/debian-trixie', history: 'full', pool: 40, verdict: true, idempotent: false });
    expect(() => parseConfig(JSON.stringify({ ...base, environment: { setup: '../outside.sh' } }))).toThrow('a path inside the commit');
  });

  test('a base the runtime cannot start by name is refused before anything starts, by `run` and by `map --env`', async () => {
    const base = { name: 'nimbus', environment: {}, plan: { command: ['plan'] }, task: { command: ['run'] } };

    expect(parseConfig(JSON.stringify(base)).environment.base).toBe('cloudflare/debian-trixie');
    expect(() => parseConfig(JSON.stringify({ ...base, environment: { base: 'ubuntu:26.04' } }))).toThrow('Cloudflare-managed image');
    const scratch = mkdtempSync(join(tmpdir(), 'armada-base-'));
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch: (request) => { requests.push(new URL(request.url).pathname); return Response.json({ id: 'j1' }); } });

    try {
      writeFileSync(join(scratch, 'recipe.json'), JSON.stringify({ base: 'ubuntu:26.04@sha256:' + 'f'.repeat(64) }));
      const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'map', `--env=${join(scratch, 'recipe.json')}`, '--times=1', '--', 'true'], {
        env: { ...process.env, ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      expect({ exit: await cli.exited, said: (await new Response(cli.stderr).text()).includes('Cloudflare-managed image'), requests }).toEqual({ exit: 2, said: true, requests: [] });
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('key globs match within a segment with * and across segments with **', () => {
    const globs = ['bun.lock', 'packages/*/package.json', 'patches/**'];
    const paths = ['bun.lock', 'packages/core/package.json', 'packages/core/src/package.json', 'patches/a.patch', 'patches/deep/b.patch', 'package.json'];

    expect(paths.filter((path) => globs.some((glob) => matches(glob, path)))).toEqual(['bun.lock', 'packages/core/package.json', 'patches/a.patch', 'patches/deep/b.patch']);
  });
});

describe('grading a CI run', () => {
  const row = (name: string, exitCode = 0, timings?: Record<string, number>) => ({ name, exitCode, seconds: 1, output: `${name} said this`, ...timings === undefined ? {} : { timings } });

  test('a task is named by its configured key, else `name`, else its first string value, else its position', () => {
    expect([taskName({ row: 'a b', name: 'x' }, 'name', 0), taskName({ part: 'source-1' }, undefined, 1), taskName({ weight: 2 }, undefined, 2)]).toEqual(['x', 'source-1', 'task-3']);
  });

  test('every named row reported once by its task, a red one listed: graded, with the red', () => {
    const answers: TaskAnswer[] = [
      { name: 'a', entry: { rows: ['one', { name: 'two', files: ['x.test.ts', 'y.test.ts'] }] }, rows: [row('one'), row('two', 1, { 'x.test.ts': 2, 'y.test.ts': 3 })] },
      { name: 'b', entry: {}, rows: [{ run: 'bun scripts/three.ts', exitCode: 0, seconds: 0, output: '' }] },
    ];
    const graded = grade(answers);

    expect({ problems: graded.problems, rows: graded.rows.length, reds: graded.reds.map((each) => each.name) }).toEqual({ problems: [], rows: 3, reds: ['two'] });
  });

  test('a task that exits nonzero fails every row it reported green; one it reported red keeps its own exit', () => {
    const exited = underExit([row('one'), row('two', 1), { ...row('three', 1), output: '' }], { exitCode: 7, tail: 'Segmentation fault' }, 'a');

    expect(exited.map((each) => [rowName(each), each.exitCode, each.output])).toEqual([
      ['one', 7, 'the task exited 7 after reporting this row green\nSegmentation fault'],
      ['two', 1, 'two said this'],
      ['three', 1, 'Segmentation fault'],
    ]);
    expect(grade([{ name: 'a', entry: {}, rows: exited }]).reds.map(rowName)).toEqual(['one', 'two', 'three']);
    expect(underExit([row('one')], { exitCode: 0, tail: '' }, 'a')).toEqual([row('one')]);
  });

  test('a task that exits nonzero having reported no row is a red row of its own', () => {
    const exited = underExit([], { exitCode: 7, tail: 'Segmentation fault' }, 'a');

    expect(exited.map((each) => [rowName(each), each.exitCode, each.output])).toEqual([
      ['a', 7, 'the task exited 7 and reported no row\nSegmentation fault'],
    ]);
    expect(grade([{ name: 'a', entry: {}, rows: exited }])).toMatchObject({ problems: [], reds: exited });
    expect(underExit([], { exitCode: 0, tail: '' }, 'a')).toEqual([]);
  });

  test('a missing verdict, a missing or extra row, a row twice, and an untimed file are each named, and none is green', () => {
    const graded = grade([
      { name: 'a', entry: { rows: ['one', 'two', { name: 'split', files: ['x.test.ts', 'y.test.ts'] }] }, rows: [row('one'), row('stray'), row('split', 0, { 'x.test.ts': 1 })] },
      { name: 'b', entry: {}, rows: [row('one')] },
      { name: 'c', entry: { rows: ['four'] }, rows: null },
    ]);

    expect(graded.problems).toEqual([
      'a has no verdict for two; missing is not green',
      'a: split timed 1 of its 2 files',
      'a reported stray, which its plan entry does not name',
      'one was reported by both a and b',
      'c wrote no verdict',
    ]);
  });
});

describe('uploading a pack', () => {
  test('one no larger than a part goes in one PUT; a larger one in equal parts, then completes', async () => {
    const seen: string[] = [];
    const sent: number[] = [];
    const original = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';

      seen.push(`${method} ${url.pathname.split('/').slice(-1)[0] ?? ''}${url.search}`);
      if (init?.body instanceof Uint8Array) sent.push(init.body.length);
      if (method === 'HEAD') return new Response(null, { status: 404 });
      if (url.searchParams.has('uploads')) return Response.json({ upload: 'u1' });
      if (url.searchParams.has('part')) return Response.json({ partNumber: Number(url.searchParams.get('part')), etag: `e${url.searchParams.get('part') ?? ''}` });

      return Response.json({ stored: 'key' });
    }) as typeof fetch;

    try {
      const armada = new Armada({ url: 'https://armada.test', token: 't', account: 'a' });

      expect(await armada.uploadPack('dew', 'a'.repeat(40), 'root', () => new Blob([new Uint8Array(PACK_PART)]))).toBe(PACK_PART);
      expect(seen.splice(0)).toEqual(['HEAD root?packer=2', 'PUT root?packer=2']);
      expect(await armada.uploadPack('dew', 'b'.repeat(40), 'root', () => new Blob([new Uint8Array(2 * PACK_PART + 5)]))).toBe(2 * PACK_PART + 5);
      expect(seen).toEqual([
        'HEAD root?packer=2', 'POST root?packer=2&uploads', 'PUT root?packer=2&upload=u1&part=1', 'PUT root?packer=2&upload=u1&part=2',
        'PUT root?packer=2&upload=u1&part=3', 'POST root?packer=2&upload=u1',
      ]);
      expect(sent).toEqual([PACK_PART, PACK_PART, 5]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('packing a commit', () => {
  test('a clone without the environment\'s commit packs from the root, and that pack checks out where the environment is', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-pack-'));
    const git = (cwd: string, ...args: string[]): string => {
      const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });

      if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

      return ran.stdout.toString().trim();
    };

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

        expect(Bun.spawnSync(['git', 'index-pack', '--stdin'], { cwd: checkout, stdin: pack, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
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
    const git = (cwd: string, ...args: string[]): string => {
      const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

      if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

      return ran.stdout.toString().trim();
    };
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
      // A commit on the fork point, as a lane's overlay (`git commit-tree -p <fork>`) makes one: its `apps` is the fork's.
      git(origin, 'checkout', '-q', fork);
      const head = commit('overlay', { 'c.txt': 'c\n' });

      git(scratch, 'init', '-q', checkout);
      // The environment's own commit run again packs nothing, and the overlay's pack carries what the checkout lacks.
      for (const [sha, base] of [[environment, 'root'], [environment, environment], [head, environment]] as const) {
        const pack = new Uint8Array(await packOf(origin, sha, base, 'commit').arrayBuffer());

        expect(Bun.spawnSync(['git', 'index-pack', '--stdin'], { cwd: checkout, stdin: pack, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
        appendFileSync(join(checkout, '.git', 'shallow'), `${sha}\n`);
        git(checkout, 'checkout', '-q', '-f', '-B', 'armada', sha);
      }

      expect({ head: git(checkout, 'rev-parse', 'HEAD'), a: git(checkout, 'show', 'HEAD:apps/a.txt'), status: git(checkout, 'status', '--porcelain') }).toEqual({ head, a: 'one', status: '' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
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
        env: { ...process.env, ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      await polling;
      cli.kill('SIGINT');
      expect({ exit: await cli.exited, cancelled: seen.includes('POST /jobs/j1/cancel') }).toEqual({ exit: 2, cancelled: true });
    } finally {
      await server.stop(true);
    }
  });
});

describe('armada run', () => {
  /** `armada run HEAD …` in a one-commit repository, against a runner that answers the plan and the one task with
   *  these outputs: what the CLI printed, how it exited, and what it asked of the runner. */
  async function run(args: readonly string[], plan: unknown, verdict: unknown) {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-run-'));
    const repo = join(scratch, 'repo');
    const git = (...words: string[]) => expect(Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...words], { cwd: repo }).exitCode).toBe(0);
    const commands: string[][] = [];
    const seen: string[] = [];
    const outcome = { index: 0, kind: 'exited', exitCode: 0, seconds: 1, vessel: 'v1', attempt: 1, tail: '', output: true };
    const status = (id: string) => ({
      id, label: '', phase: 'done', key: 'k'.repeat(64), createdAt: 0, startedAt: 0, finishedAt: 1,
      tasks: { total: 1, queued: 0, running: 0, exited: 1, red: 0, failed: 0 }, vessels: [], problems: [], environment: null,
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);

        seen.push(`${request.method} ${pathname.split('/').slice(0, 3).join('/')}`);
        if (pathname === '/environments/resolve') return Response.json({ key: 'k'.repeat(64), base: 'root' });
        if (pathname === '/timings/proj' && request.method === 'GET') return Response.json({ rows: {}, files: {} });
        if (pathname === '/jobs') {
          commands.push(v.parse(v.object({ run: v.object({ command: v.array(v.string()) }) }), await request.json()).run.command);

          return Response.json({ id: commands.length === 1 ? 'plan' : 'tasks' });
        }
        if (pathname.endsWith('/events')) return Response.json({ events: [{ seq: 1, outcome }], done: true });
        if (pathname === '/jobs/plan/tasks/0/output') return new Response(JSON.stringify(plan));
        if (pathname === '/jobs/tasks/tasks/0/output') return new Response(JSON.stringify(verdict));
        if (pathname.startsWith('/jobs/')) return Response.json(status(pathname.split('/')[2] ?? ''));

        return request.method === 'HEAD' ? new Response(null) : Response.json({ ok: true });
      },
    });

    try {
      mkdirSync(repo);
      git('init', '-q');
      writeFileSync(join(repo, '.armada.json'), JSON.stringify({ name: 'proj', environment: {}, plan: { command: ['plan'] }, task: { command: ['task', '{out}'] } }));
      git('add', '.');
      git('commit', '-qm', 'one');
      const cli = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'HEAD', ...args], {
        cwd: repo, env: { ...process.env, HOME: scratch, ARMADA_URL: server.url.href, ARMADA_TOKEN: 't' }, stdout: 'pipe', stderr: 'pipe',
      });

      return { exit: await cli.exited, stdout: await new Response(cli.stdout).text(), commands, seen };
    } finally {
      await server.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  test('words after -- reach the plan, and a narrowed run stores no verdict but records its timings', async () => {
    const ran = await run(['--', '--tier', 'fast'], { include: [{ name: 'a', rows: ['x'] }] }, { rows: [{ name: 'x', exitCode: 0, seconds: 2 }] });

    expect({ exit: ran.exit, plan: ran.commands[0]?.slice(-3), verdicts: ran.seen.filter((each) => each.startsWith('PUT /verdicts')), timings: ran.seen.includes('POST /timings/proj') })
      .toEqual({ exit: 0, plan: ['plan', '--tier', 'fast'], verdicts: [], timings: true });
  });

  test('a task that exits 0 with a red row among its rows is named RED as it lands, with the row', async () => {
    const ran = await run([], { include: [{ name: 'part-1', rows: ['x.mjs', 'y.mjs'] }] }, {
      rows: [{ name: 'x.mjs', exitCode: 0, seconds: 2 }, { name: 'y.mjs', exitCode: 1, seconds: 1, output: 'AssertionError: y broke' }],
    });
    const line = ran.stdout.split('\n').find((each) => each.includes('part-1'));

    expect({ exit: ran.exit, line: line?.replace(/^\s*\d+:\d+\s+/u, ''), told: ran.stdout.includes('AssertionError: y broke') })
      .toEqual({ exit: 1, line: 'part-1         RED: 1 of 2 rows (y.mjs) in 0:01 on v1', told: true });
  });
});
