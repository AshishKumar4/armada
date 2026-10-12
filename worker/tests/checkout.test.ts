/**
 * A container's checkout on real git: a run's pack (`shallowOf`, `packOf`) received as the container receives it
 * (`receive`), its boundary marked shallow (#34). It writes the pack where a container does, under `STATE`, so it runs as
 * root (`ci/privileged.sh`); elsewhere it is skipped, and says so.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packOf, shallowOf } from '../../src/git';
import { receive, STATE } from '../src/container';

const root = process.getuid?.() === 0;

if (!root) console.log('checkout.test: skipped: it writes the pack under /armada, as root, as a container does');

const scratch = mkdtempSync(join(tmpdir(), 'armada-checkout-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };

/** `git <args>` in `cwd`: its stdout, trimmed, and whether it exited 0. */
function git(cwd: string, ...args: string[]) {
  const ran = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });

  return { out: ran.stdout.toString().trim(), ok: ran.exitCode === 0 };
}

/** A repository at `dir` with a merge on top: c1, then c2 and a side commit merged. Its merge's sha. */
function merged(dir: string): string {
  git(scratch, 'init', '-q', dir);
  writeFileSync(join(dir, 'f'), 'one\n');
  git(dir, 'add', 'f');
  git(dir, 'commit', '-qm', 'c1');
  git(dir, 'checkout', '-qb', 'side');
  writeFileSync(join(dir, 'g'), 'side\n');
  git(dir, 'add', 'g');
  git(dir, 'commit', '-qm', 's');
  git(dir, 'checkout', '-q', '-');
  writeFileSync(join(dir, 'f'), 'two\n');
  git(dir, 'commit', '-qam', 'c2');
  git(dir, 'merge', '-q', '--no-ff', 'side', '-m', 'merge');

  return git(dir, 'rev-parse', 'HEAD').out;
}

/** `sha`'s pack against `base`, from `repo`, received into the checkout `into` as a container receives it. */
async function received(repo: string, into: string, sha: string, base: string): Promise<boolean> {
  writeFileSync(`${STATE}/pack`, new Uint8Array(await packOf(repo, sha, base, 'full').arrayBuffer()));

  return Bun.spawnSync(['/bin/sh', '-c', receive(into), 'receive', sha, ...shallowOf(repo, sha, 'full')], { cwd: into, env, stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
}

describe.skipIf(!root)('a checkout from a shallow clone (#34)', () => {
  test('marks the clone\'s boundary shallow, so git walks its history, and an environment from it takes a later full pack from the root', async () => {
    const origin = join(scratch, 'origin');
    const merge = merged(origin);

    git(scratch, 'clone', '-q', '--depth', '1', `file://${origin}`, 'clone');
    const clone = join(scratch, 'clone');
    const checkout = join(scratch, 'checkout');

    Bun.spawnSync(['mkdir', '-p', checkout, STATE]);
    const took = await received(clone, checkout, merge, 'root');
    const walked = [git(checkout, 'log', '--oneline').ok, git(checkout, 'rev-list', '--count', 'HEAD').out];

    // A later commit, from a full clone: packed from the root, as the registry answers for a shallow environment.
    writeFileSync(join(origin, 'h'), 'later\n');
    git(origin, 'add', 'h');
    git(origin, 'commit', '-qm', 'later');
    const later = git(origin, 'rev-parse', 'HEAD').out;
    const again = await received(origin, checkout, later, 'root');

    expect({ took, walked, again, count: git(checkout, 'rev-list', '--count', 'HEAD').out, clean: git(checkout, 'status', '--porcelain').out })
      .toEqual({ took: true, walked: [true, '1'], again: true, count: '5', clean: '' });
  });
});
