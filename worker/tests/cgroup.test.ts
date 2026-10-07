/**
 * A task's cgroup, on a real cgroup v2 hierarchy: what `mounts`, `launchTask`, `WAIT` and `KILL` run in a container, run
 * here as root on a host with armada's runner layer (the `ci` user, setpriv). Elsewhere it is skipped, and says so; run
 * it as a recipe's setup to prove it on the platform.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KILL, launchTask, mounts, TASK, TASK_GROUP, WAIT } from '../src/container';

const host = process.getuid?.() === 0 && Bun.spawnSync(['id', 'ci']).exitCode === 0 && readFileSync('/proc/self/mounts', 'utf8').includes(' /sys/fs/cgroup cgroup2 ');

if (!host) console.log('cgroup.test: skipped: it runs as root beside armada\'s runner layer, on cgroup v2');

const workdir = mkdtempSync(join(tmpdir(), 'armada-cgroup-'));

chmodSync(workdir, 0o755);

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const sh = (script: string, ...args: string[]) => Bun.spawnSync(['/bin/sh', '-c', script, 'armada', ...args], { cwd: workdir, env: { PATH: process.env['PATH'] ?? '', ARMADA_CGROUP: TASK_GROUP }, stdout: 'pipe', stderr: 'pipe' });

/** One task, launched and waited for: its exit code and its log. */
function task(...argv: string[]): { readonly exit: string; readonly log: string } {
  expect(sh(launchTask(workdir), ...argv).exitCode).toBe(0);
  const exit = sh(WAIT, '20').stdout.toString().trim();

  return { exit, log: readFileSync(`${TASK}/log`, 'utf8') };
}

const alive = (command: string) => Bun.spawnSync(['pgrep', '-fx', command]).exitCode === 0;

describe.skipIf(!host)('a task\'s cgroup', () => {
  test('is the user\'s to nest in, and everything a task leaves running ends when the next task launches', () => {
    expect(sh(mounts([])).exitCode).toBe(0);
    const first = task('sh', '-c', `mkdir "$ARMADA_CGROUP/case"
echo 64M > "$ARMADA_CGROUP/case/memory.max"
sh -c 'echo $$ > "$ARMADA_CGROUP/case/cgroup.procs" && exec setsid sleep 601' >/dev/null 2>&1 < /dev/null &
setsid sleep 602 >/dev/null 2>&1 < /dev/null &
id -u; cat /proc/self/cgroup "$ARMADA_CGROUP/case/memory.max"`);

    expect({ exit: first.exit, log: first.log.trim().split('\n'), left: [alive('sleep 601'), alive('sleep 602')] })
      .toEqual({ exit: '0', log: [Bun.spawnSync(['id', '-u', 'ci']).stdout.toString().trim(), '0::/armada/task/runner', String(64 * 1024 * 1024)], left: [true, true] });
    const second = task('sh', '-c', 'cat /proc/self/cgroup');

    expect({ exit: second.exit, log: second.log.trim(), left: [alive('sleep 601'), alive('sleep 602')], nested: existsSync(`${TASK_GROUP}/case`) })
      .toEqual({ exit: '0', log: '0::/armada/task/runner', left: [false, false], nested: false });
  });

  test('a killed task ends with all it started', () => {
    expect(sh(launchTask(workdir), 'sh', '-c', 'setsid sleep 603 >/dev/null 2>&1 < /dev/null & sleep 604').exitCode).toBe(0);
    expect(sh(WAIT, '1').stdout.toString().trim()).toBe('');
    expect(sh(KILL).exitCode).toBe(0);
    expect({ left: [alive('sleep 603'), alive('sleep 604')], group: existsSync(TASK_GROUP) }).toEqual({ left: [false, false], group: false });
  });
});
