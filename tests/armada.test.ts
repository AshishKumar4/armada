import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packBase, packOf } from '../src/ci';
import { matches, parseConfig } from '../src/config';
import { grade, rowName, taskName, underExit, type TaskAnswer } from '../src/grade';
import { environmentKey, fill, itemValues, medians, recordSamples, weightOf, type Recipe } from '../src/protocol';
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
      expect(seen.splice(0)).toEqual(['HEAD root', 'PUT root']);
      expect(await armada.uploadPack('dew', 'b'.repeat(40), 'root', () => new Blob([new Uint8Array(2 * PACK_PART + 5)]))).toBe(2 * PACK_PART + 5);
      expect(seen).toEqual(['HEAD root', 'POST root?uploads', 'PUT root?upload=u1&part=1', 'PUT root?upload=u1&part=2', 'PUT root?upload=u1&part=3', 'POST root?upload=u1']);
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
