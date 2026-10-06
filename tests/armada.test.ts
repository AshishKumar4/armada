import { describe, expect, test } from 'bun:test';
import { matches, parseConfig } from '../src/config';
import { grade, taskName, type TaskAnswer } from '../src/grade';
import { environmentKey, fill, itemValues, medians, recordSamples, weightOf, type Recipe } from '../src/protocol';

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
