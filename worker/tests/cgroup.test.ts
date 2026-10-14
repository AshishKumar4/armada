/**
 * A task's cgroup, on a real cgroup v2 hierarchy: what `launchTask`, `WAIT` and `killOf` run in a container, run here as
 * root on a host with armada's runner layer (the `ci` user, setpriv), starting with no armada group at all, as in a
 * container an earlier Worker started. Elsewhere it is skipped, and says so; run
 * it as a recipe's setup to prove it on the platform.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTask, killOf, launchSlot, launchTask, slotRoot, slotTask, STATE, TASK, TASK_GROUP, taskGroup, usageFrom, usageOf, WAIT, waitOn } from '../src/container';

const host = process.getuid?.() === 0 && Bun.spawnSync(['id', 'ci']).exitCode === 0 && readFileSync('/proc/self/mounts', 'utf8').includes(' /sys/fs/cgroup cgroup2 ');

if (!host) console.log('cgroup.test: skipped: it runs as root beside armada\'s runner layer, on cgroup v2');

const workdir = mkdtempSync(join(tmpdir(), 'armada-cgroup-'));

chmodSync(workdir, 0o755);

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const sh = (script: string, ...args: string[]) => Bun.spawnSync(['/bin/sh', '-c', script, 'armada', ...args], { cwd: workdir, env: { PATH: process.env['PATH'] ?? '', ARMADA_CGROUP: TASK_GROUP }, stdout: 'pipe', stderr: 'pipe' });

/** This host's CPUs: a container of as many vCPUs runs its tasks on all of them. */
const ALL = availableParallelism();

/** One task, launched and waited for in a container of `cpus` vCPUs: its exit code and its log. */
function task(...argv: string[]) {
  return taskOn(ALL, ...argv);
}

function taskOn(cpus: number, ...argv: string[]) {
  expect(sh(launchTask(workdir, cpus), ...argv).exitCode).toBe(0);
  const exit = sh(WAIT, '20').stdout.toString().trim();

  return { exit, log: readFileSync(`${TASK}/log`, 'utf8') };
}

const alive = (command: string) => Bun.spawnSync(['pgrep', '-fx', command]).exitCode === 0;

describe.skipIf(!host)('a task\'s cgroup', () => {
  test('is the user\'s to nest in, and everything a task leaves running ends when the next task launches', () => {
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

  test('runs on as many CPUs as its container has vCPUs, where the container shows more, so what counts CPUs counts those', () => {
    const one = taskOn(1, 'nproc');
    const all = taskOn(ALL, 'nproc');

    expect({ one: one.log.trim(), all: all.log.trim() }).toEqual({ one: '1', all: String(ALL) });
  });

  test('a task starts with SIGINT and SIGQUIT at their defaults, so a ^C it sends ends what it reaches', () => {
    const interrupted = task('sh', '-c', 'grep SigIgn /proc/self/status; kill -INT $$; echo survived');

    expect({ exit: interrupted.exit, log: interrupted.log.trim() }).toEqual({ exit: '130', log: 'SigIgn:\t0000000000000000' });
  });

  test('a killed task ends with all it started, as soon as its session goes at the TERM', () => {
    expect(sh(launchTask(workdir, ALL), 'sh', '-c', 'setsid sleep 603 >/dev/null 2>&1 < /dev/null & sleep 604').exitCode).toBe(0);
    expect(sh(WAIT, '1').stdout.toString().trim()).toBe('');
    const began = Date.now();

    expect(sh(killOf(TASK, TASK_GROUP)).exitCode).toBe(0);
    expect({ left: [alive('sleep 603'), alive('sleep 604')], group: existsSync(TASK_GROUP), soon: Date.now() - began < 1_000 }).toEqual({ left: [false, false], group: false, soon: true });
  });

  test('a killed task hears the TERM, so its own handler runs before the KILL', () => {
    expect(sh(launchTask(workdir, ALL), 'sh', '-c', 'trap "echo heard; exit 0" TERM; sleep 605 & wait').exitCode).toBe(0);
    expect(sh(WAIT, '1').stdout.toString().trim()).toBe('');
    expect(sh(killOf(TASK, TASK_GROUP)).exitCode).toBe(0);
    expect(readFileSync(`${TASK}/log`, 'utf8').trim()).toBe('heard');
  });
});

describe.skipIf(!host)('a slotted task', () => {
  test('runs as the user in its own mounts and capped group, sees its own task dir, and leaves the checkout as it was', () => {
    const before = Bun.spawnSync(['ls', workdir]).stdout.toString();
    const script = launchSlot(workdir, 2, { cpus: ALL, memoryBytes: 64 * 1024 * 1024 }, ['/dev/shm']);

    expect(sh(script, 'sh', '-c', `id -u; cat /proc/self/cgroup; cat ${TASK_GROUP}-2/memory.max; touch here /dev/shm/scratch; ls ${TASK}; ls ${STATE}/slots | wc -l`).exitCode).toBe(0);
    const exit = sh(waitOn(slotTask(2)), '20').stdout.toString().trim();
    const log = readFileSync(`${slotTask(2)}/log`, 'utf8').trim().split('\n');

    expect({ exit, log, checkout: Bun.spawnSync(['ls', workdir]).stdout.toString(), tmp: existsSync('/dev/shm/scratch') })
      .toEqual({ exit: '0', log: [Bun.spawnSync(['id', '-u', 'ci']).stdout.toString().trim(), '0::/armada/task-2/runner', String(64 * 1024 * 1024), 'artifacts', 'log', 'pid', '0'], checkout: before, tmp: false });
  });
});

describe.skipIf(!host)('packed tasks', () => {
  test('share one memory cap over them all, past which the kernel kills a task, never the container, and its usage says so', () => {
    const cap = 96 * 1024 * 1024;
    // Each holds dd's 80 MiB buffer until its timeout ends it (124): two of them pass the cap.
    const hold = ['timeout', '4', 'dd', 'if=/dev/zero', 'of=/dev/null', 'bs=80M'];

    try {
      for (const slot of [0, 1]) {
        expect(sh(launchSlot(workdir, slot, { cpus: ALL, memoryBytes: cap, tasksMemoryBytes: cap }, []), ...hold).exitCode).toBe(0);
        Bun.sleepSync(1500);
      }

      const exits = [0, 1].map((slot) => sh(waitOn(slotTask(slot)), '20').stdout.toString().trim());
      const usage = [0, 1].map((slot) => usageFrom(sh(usageOf(taskGroup(slot), slotRoot(slot))).stdout.toString()));
      const parent = readFileSync(`${taskGroup(0)}/../memory.max`, 'utf8').trim();
      // How often the slot reached its own cap.
      const ownOom = (slot: number) => /^oom (\d+)$/mu.exec(readFileSync(`${taskGroup(slot)}/memory.events`, 'utf8'))?.[1];

      // Whichever the kernel chose: each task killed or ended at its timeout, its own usage saying which, both measured
      // on disk, and only the cap over them all reached. The kernel may kill both: it can choose again before the first
      // one's memory is uncharged (1 run in 6 to 10 under load, 2026-10-14).
      const ended = [0, 1].map((slot) => [exits[slot], usage[slot]?.oomKilled ?? false, (usage[slot]?.diskBytes ?? -1) >= 0, ownOom(slot)]);
      const killed = ['137', true, true, '0'];
      const timedOut = ['124', false, true, '0'];

      expect(parent).toBe(String(cap));
      expect(ended.toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))).toBeOneOf([[timedOut, killed], [killed, killed]]);
    } finally {
      for (const slot of [0, 1]) sh(killOf(slotTask(slot), taskGroup(slot)));
      sh(`echo max > ${taskGroup(0)}/../memory.max; [ ! -e ${taskGroup(0)}/../memory.swap.max ] || echo max > ${taskGroup(0)}/../memory.swap.max`);
    }
    // Each task holds its memory for 4 s, one after another starts.
  }, 30_000);

  test('a cleared slot keeps nothing its task left: no process it detached, no file it wrote, no group', () => {
    const slot = 2;

    expect(sh(launchSlot(workdir, slot, { cpus: ALL, memoryBytes: 64 * 1024 * 1024 }, []), 'sh', '-c', 'setsid sleep 300 & echo x > left').exitCode).toBe(0);
    expect(sh(waitOn(slotTask(slot)), '20').stdout.toString().trim()).toBe('0');
    const before = [alive('sleep 300'), existsSync(`${slotRoot(slot)}/upper/left`)];

    expect(sh(clearTask(taskGroup(slot), slotRoot(slot))).exitCode).toBe(0);
    expect({ before, after: [alive('sleep 300'), existsSync(slotRoot(slot)), existsSync(taskGroup(slot))] }).toEqual({ before: [true, true], after: [false, false, false] });
  }, 30_000);
});
