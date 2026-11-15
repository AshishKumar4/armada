/**
 * A commit's repository, as armada reads and packs it: the commit a target names, the paths that key its environment,
 * and its pack for a container, against the environment's commit or from the root, with the shallow boundary its
 * checkout marks (#34).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as v from 'valibot';
import type { Config, Environment } from './config';
import type { Manifest } from './protocol';

/** This process's environment without GIT_DIR and its like, which a hook that runs armada sets for its own repo. */
const GIT_ENV = Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => !name.startsWith('GIT_') && v.is(v.string(), value) ? [[name, value]] : []));

/** Git in `cwd`'s repository. */
export function git(cwd: string, args: readonly string[], stdin?: Uint8Array): Buffer {
  const ran = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV, stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString().trim()}`);

  return ran.stdout;
}

export interface Checkout {
  readonly sha: string;
  /** A repository holding it, to read and pack it from. */
  readonly repo: string;
}

/** The commit a target names; a worktree must be committed, since the commit is what is proved. */
export function resolveCommit(target: string): Checkout {
  if (existsSync(target) && statSync(target).isDirectory()) {
    const dirty = git(target, ['status', '--porcelain']).toString().trim();

    if (dirty !== '') throw new Error(`${target} has uncommitted changes; armada proves a commit, so commit them first:\n${dirty}`);

    return { sha: git(target, ['rev-parse', 'HEAD']).toString().trim(), repo: target };
  }

  return { sha: git(process.cwd(), ['rev-parse', '--verify', `${target}^{commit}`]).toString().trim(), repo: process.cwd() };
}

/** The commit's paths that key `environment`: its `key` globs and its two recipe scripts. Records are NUL-ended, so
 *  a path git would otherwise quote (non-ASCII, a tab or a newline in it) is read as it is. */
export function manifestOf(repo: string, sha: string, environment: Environment): Manifest {
  const globs = [...environment.key, environment.setup ?? '', environment.install ?? ''].filter((glob) => glob !== '').map((glob) => new Bun.Glob(glob));

  return git(repo, ['ls-tree', '-r', '-z', '--full-tree', sha]).toString().split('\0').flatMap((record) => {
    const tab = record.indexOf('\t');
    const path = record.slice(tab + 1);
    const id = record.slice(0, tab).split(' ')[2] ?? '';

    return tab !== -1 && globs.some((glob) => glob.match(path)) ? [{ path, id }] : [];
  });
}

/** What the commit is packed against: the environment's commit, where this repository has it. A shallow clone (a CI
 *  runner's checkout) does not, and a pack from the root carries the whole commit. */
export function packBase(repo: string, environment: string): string {
  return environment !== 'root' && Bun.spawnSync(['git', 'cat-file', '-e', `${environment}^{commit}`], { cwd: repo, env: GIT_ENV }).exitCode === 0 ? environment : 'root';
}

/** The commits a pack of `sha` holds whose parents it does not (#34): the commit itself for a `commit` history, which
 *  packs its tree alone; else, from a shallow clone, the clone's own boundary below it, where its history stops. */
export function shallowOf(repo: string, sha: string, history: Config['history']): string[] {
  if (history === 'commit') return [sha];

  if (git(repo, ['rev-parse', '--is-shallow-repository']).toString().trim() !== 'true') return [];
  const lines = (text: string) => text.split('\n').filter((line) => line !== '');
  const reachable = new Set(lines(git(repo, ['rev-list', sha]).toString()));

  return lines(readFileSync(resolve(repo, git(repo, ['rev-parse', '--git-path', 'shallow']).toString().trim()), 'utf8')).filter((line) => reachable.has(line));
}

/** What one git packing takes at most: its delta windows (two threads of 256 MiB) and delta cache (64 MiB) bounded,
 *  so with its object table about 1 GiB, whatever the commit. */
export const GIT_BOUNDS = ['-c', 'pack.threads=2', '-c', 'pack.windowMemory=256m', '-c', 'pack.deltaCacheSize=64m'];

/** The commit from the root (with its history, or alone), or what it adds to the environment's commit, packed into
 *  `file` by git bounded in memory (`GIT_BOUNDS`), its output streamed to the file. A `commit` checkout holds the
 *  environment commit's tree and nothing of its history, so the pack is every object of the commit's tree that tree
 *  lacks: `--not <base>` would also leave out what the commit shares with an ancestor of the base, which the checkout
 *  never received. With history, git walks the revisions itself (`--revs`), no object list read here. */
export async function packTo(repo: string, sha: string, base: string, history: Config['history'], file: string): Promise<void> {
  if (history !== 'commit') {
    await packed(repo, ['--revs'], `${sha}\n${base === 'root' ? '' : `^${base}\n`}`, file);

    return;
  }

  const listed = (...args: string[]) => git(repo, ['rev-list', '--objects', ...args]).toString().split('\n').filter((line) => line !== '');
  const id = (line: string) => line.split(' ')[0] ?? '';
  const held = new Set(base === 'root' ? [] : listed('--no-walk', base).map(id));

  await packed(repo, [], listed('--no-walk', sha).filter((line) => !held.has(id(line))).map((line) => `${line}\n`).join(''), file);
}

/** `git pack-objects` in `repo`, bounded (`GIT_BOUNDS`), reading `input` (object names, or revisions with `--revs`),
 *  writing the pack to `file`. */
export async function packed(repo: string, options: readonly string[], input: string, file: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const out = openSync(file, 'w', 0o600);

  try {
    const packing = Bun.spawn(['git', ...GIT_BOUNDS, 'pack-objects', ...options, '--stdout', '-q'], { cwd: repo, env: GIT_ENV, stdin: new Blob([input]), stdout: out, stderr: 'pipe' });
    const [exit, said] = await Promise.all([packing.exited, new Response(packing.stderr).text()]);

    if (exit !== 0) throw new Error(`git pack-objects ${options.join(' ')}: ${said.trim()}`);
  } finally {
    closeSync(out);
  }
}
