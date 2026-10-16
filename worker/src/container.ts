/**
 * What runs inside a container, and the one way the Worker runs it. Every container starts on the `durable_object`
 * scheduling policy, so each start names what it starts from (the recipe's base image while preparing, an environment
 * snapshot otherwise) and its instance: no image to build, push or roll out.
 */
import { ARTIFACTS_PATH, cpuLabel, detach, failureTail, hostLabel, SIZES, type Cpu, type Host, type Outcome, type Size } from '../../src/protocol';
import { said } from './env';

/** The unprivileged user every task runs as. The exec's own `user` option fails on this runtime (`internal error`), so
 *  a command drops to the user inside. */
export const AS_USER = ['setpriv', '--reuid=ci', '--regid=ci', '--init-groups', '--'];

/** The user's home: its HOME wherever it runs, or root's would be read instead. */
export const USER_HOME = '/home/ci';

/** The runner's own state in a container: the pack, the job's files, a function's bundle, the current task. */
export const STATE = '/armada';

/** One exec's longest run, for every container driver (vessel, preparer). */
export const EXEC_MS = 90_000;

/** One alarm's share of a driver's loop; the next alarm takes it up at once. */
export const SLICE_MS = 50_000;

/** One blocking wait on a running task or phase. */
export const WAIT_SECONDS = 20;

/** Longer than a job may take, so only the job's end stops a container; one whose stop failed ends this long after its
 *  last exec. */
export const INACTIVITY_MS = 6 * 60 * 60_000;

export const TASK = `${STATE}/task`;

/** Where slot `slot` of a slotted container lives: its task dir (bound over `TASK` inside the slot's namespace), its
 *  overlays' upper and work dirs, its secrets file. Recreated at each launch, so nothing survives its last task. */
export const slotRoot = (slot: number): string => `${STATE}/slots/${String(slot)}`;

/** The slot's own task dir, as the root side reaches it; inside the slot's namespace it is `TASK` exactly. */
export const slotTask = (slot: number): string => `${slotRoot(slot)}/task`;

/** Where the values of a slotted task's secrets wait for its log's mask: each slot's own, where two slots' tasks
 *  could end together. */
export const maskValuesOf = (slot: number): string => `${slotRoot(slot)}/mask.json`;

/** Where slot `slot`'s next task's argv and environment wait for its launch (`launchArgv`), outside the dirs the
 *  launch recreates. */
export const argvOf = (slot: number): string => `${STATE}/argv/${String(slot)}`;

/** A launch's script that takes its task's argv and environment from `path`, removes it, and goes on as `script`: the
 *  argv set as the positional parameters `script` reads and the environment exported, as `positional` wrote them there.
 *  An exec's own arguments and environment ride in its request, which the runtime fails as an `internal error` past
 *  about 128 KiB in one string or 1 MB in all, and an item's `ARMADA_ITEM` alone can be that large; a file `pipeIn`
 *  writes takes any size. */
export const launchArgv = (path: string, script: string): string => `. ${path}\nrm -f ${path}\n${script}`;

/** A word single-quoted for the shell: a quote inside it closed, escaped and reopened, so every byte reaches the
 *  command unchanged. */
const quoted = (word: string): string => `'${word.replaceAll("'", String.raw`'\''`)}'`;

/** `argv` as the shell line that makes it the positional parameters, and `env` as the lines that export it. */
export function positional(argv: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const exported = Object.entries(env).map(([name, value]) => `export ${name}=${quoted(value)}\n`).join('');

  return `set -- ${argv.map(quoted).join(' ')}\n${exported}`;
}

/** Where the container's main process marks that the platform asked the container to stop (`hold`). */
export const STOPPING = `${STATE}/stopping`;

/** When the platform asked the container to stop, or nothing while it runs on. */
export const STOPPED = String.raw`if [ -e ${STOPPING} ]; then cat ${STOPPING}; fi`;

/** Where a preparation's phase runs: its log and its exit code. */
export const phaseDir = (phase: string): string => `${STATE}/phases/${phase}`;

const PARENT_GROUP = '/sys/fs/cgroup/armada';

/** The cgroup a task runs in, delegated to the user, so a task can give what it starts groups and limits of its own
 *  (a test runner's per-file memory). The task itself is in its `runner` child: a group whose children have
 *  controllers holds no process. Everything in it ends with the task, daemons it detached with `setsid` included. */
export const TASK_GROUP = `${PARENT_GROUP}/task`;

/** Slot `slot`'s `TASK_GROUP`: a slotted container gives each slot its own, memory capped at the slot's share, so an
 *  over-using slot is OOM-killed inside its own group. */
export const taskGroup = (slot: number): string => `${PARENT_GROUP}/task-${String(slot)}`;

/** Controllers a task's groups get: CPU and memory to read and to cap, pids to bound. */
const CONTROLLERS = '+cpu +memory +pids';

/** As root: ends everything in `group`, a task's, the user's nested groups included, and removes them. */
const endGroup = (group: string): string => String.raw`if [ -d ${group} ]; then
  echo 1 > ${group}/cgroup.kill
  n=0
  while grep -q '^populated 1' ${group}/cgroup.events; do
    n=$((n + 1)); [ "$n" -lt 100 ] || { echo "${group} would not empty" >&2; exit 1; }
    sleep 0.05
  done
  find ${group} -depth -type d -exec rmdir {} +
fi`;

/** git as a GitHub runner has it: Debian trixie's 2.47 prints no `path=` records for `rev-list --objects -z`. Built
 *  from kernel.org's release, pinned by digest. */
const GIT = { version: '2.53.0', sha256: '5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653' };

/**
 * The runner's layer on any Debian or Ubuntu base, as root, before the recipe's own setup: the user and the
 * directories; tini, which reaps what a task's daemons orphan; setpriv, to drop to the user; node, for functions; and
 * the tools a GitHub runner has that a stock container lacks and suites reach for (git as the runner has it, iproute2,
 * strace, procps, zip, a compiler); and iptables and python3, which a gang's relay runs on (`relay.ts`). Every recipe
 * inherits it, and `DRIVER` keys it.
 */
export function runnerLayer(workdir: string): string {
  return String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
hostname localhost || true
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl tini util-linux procps psmisc lsof iproute2 iptables strace \
  zip unzip xz-utils file jq sqlite3 python3 tzdata build-essential \
  libcurl4-openssl-dev libexpat1-dev libssl-dev zlib1g-dev libpcre2-dev
command -v node >/dev/null || apt-get install -y -qq --no-install-recommends nodejs
curl -fsSL -o /tmp/git.tar.xz https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT.version}.tar.xz
echo "${GIT.sha256}  /tmp/git.tar.xz" | sha256sum -c -
tar -xJf /tmp/git.tar.xz -C /tmp
make -C /tmp/git-${GIT.version} -j"$(nproc)" prefix=/usr/local NO_GETTEXT=1 NO_TCLTK=1 USE_LIBPCRE2=1 all install >/dev/null
rm -rf /tmp/git.tar.xz /tmp/git-${GIT.version}
id ci >/dev/null 2>&1 || useradd -m -s /bin/bash ci
mkdir -p ${workdir} ${STATE}/files
chown -R ci:ci /home/ci ${STATE}
apt-get clean
rm -rf /var/lib/apt/lists/*`;
}

/** As root, once a container has its checkout: the state dir owned by root, as `runnerLayer` leaves it the user's so
 *  the user's checkout can remove the pack. A task runs as the user, and must not replace what root reads there: the
 *  argv a launch sources as root, the mask file. */
export const OWN_STATE = `chown root:root ${STATE} && chmod 755 ${STATE}`;

/** As the user: the pack at /armada/pack into the checkout's repository (a new one while preparing), then its boundary,
 *  the arguments after the commit, marked shallow, and of what was marked before only the commits still lacking a
 *  parent, which a later pack may have brought: so git walks exactly what the repository holds (#34). Then the commit
 *  checked out on a local branch, as a GitHub runner's checkout leaves it, and clean. */
export function receive(checkout: string): string {
  return String.raw`set -eu
sha="$1"
shift
cd ${checkout}
[ -d .git ] || git init -q .
git index-pack --stdin < ${STATE}/pack >/dev/null
rm -f ${STATE}/pack
for boundary in "$@"; do echo "$boundary" >> .git/shallow; done
if [ -f .git/shallow ]; then
  sort -u .git/shallow | while read -r commit; do
    git cat-file -p "$commit" | sed -n 's/^parent //p' | while read -r parent; do
      git cat-file -e "$parent" 2>/dev/null || { echo "$commit"; break; }
    done
  done > .git/shallow.held
  if [ -s .git/shallow.held ]; then mv .git/shallow.held .git/shallow; else rm -f .git/shallow.held .git/shallow; fi
fi
git checkout -q -f -B armada "$sha"
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then printf 'the checkout of %s is not clean:\n%s\n' "$sha" "$dirty" >&2; exit 1; fi`;
}

/** As root, once per container: fresh tmpfs at each path (a container's own disk may report no free inodes), and
 *  `/proc` whole. The runtime masks parts of it as Docker does (`/proc/sys`, `/proc/kcore`, …), and the kernel then
 *  refuses a new proc mount in a user namespace, so `bwrap --proc` fails here where a GitHub runner's VM allows it. */
export function mounts(tmpfs: readonly string[]): string {
  return `set -eu\nfor dir in ${tmpfs.join(' ')}; do mkdir -p "$dir"; mount -t tmpfs -o mode=1777,size=6g tmpfs "$dir"; done
for masked in $(cut -d' ' -f5 /proc/self/mountinfo | grep '^/proc/' | sort -r); do umount -l "$masked"; done`;
}

/** The launch preamble both shapes share: refuse a container the platform is stopping, the parent cgroup and its
 *  controllers, its CPUs, the task's own group emptied (`endGroup`), a runner sub-group, an even memory cap for a
 *  slot, and the group handed to the user. The groups are set up here, at each launch, so a container an earlier
 *  Worker started has them.
 *
 *  A container shows more CPUs than its vCPUs: a medium one shows 8 and runs 4 CPUs' worth, so a task that sizes its
 *  threads by what it sees gets a third or more of its time taken back by the host, and no more work done (8 threads
 *  of BLAS 12% slower than 4, 44% of their CPU stolen; 2026-10-13). Every task runs on as many CPUs as the container
 *  has vCPUs, so what counts CPUs (nproc, OpenMP, BLAS, XLA) counts those. */
function groupSetup(group: string, { cpus, memoryBytes, tasksMemoryBytes }: { readonly cpus: number; readonly memoryBytes?: number; readonly tasksMemoryBytes?: number }): string {
  return String.raw`if [ -e ${STOPPING} ]; then echo "the container is stopping since $(cat ${STOPPING})" >&2; exit 75; fi
mkdir -p ${PARENT_GROUP}
echo '${CONTROLLERS}' > ${PARENT_GROUP}/cgroup.subtree_control
[ ! -e ${PARENT_GROUP}/cpuset.cpus ] || if [ ${String(cpus)} -lt "$(nproc --all)" ]; then echo 0-${String(cpus - 1)}; else echo; fi > ${PARENT_GROUP}/cpuset.cpus
${tasksMemoryBytes === undefined ? '' : `echo ${String(tasksMemoryBytes)} > ${PARENT_GROUP}/memory.max
[ ! -e ${PARENT_GROUP}/memory.swap.max ] || echo 0 > ${PARENT_GROUP}/memory.swap.max
`}${endGroup(group)}
mkdir -p ${group}/runner
echo '${CONTROLLERS}' > ${group}/cgroup.subtree_control
${memoryBytes === undefined ? '' : `echo ${String(memoryBytes)} > ${group}/memory.max
`}for owned in . cgroup.procs cgroup.threads cgroup.subtree_control runner runner/cgroup.procs runner/cgroup.threads runner/cgroup.subtree_control; do chown ci:ci "${group}/$owned"; done`;
}

/** As root, detached so the exec returns: whatever the last task left running ended, then one task as the user in its
 *  own session and a fresh `TASK_GROUP` delegated to the user, its output to the task's log, its exit code to the
 *  task's `exit`. A shell starts a background command with SIGINT and SIGQUIT ignored, and the task would inherit
 *  that; it gets their defaults back, as a GitHub runner's step has them, so a ^C it sends reaches what it runs. */
export function launchTask(workdir: string, cpus: number): string {
  return String.raw`set -eu
${groupSetup(TASK_GROUP, { cpus })}
rm -rf ${TASK}
mkdir -p ${TASK} ${ARTIFACTS_PATH}
chown ci:ci ${TASK} ${ARTIFACTS_PATH}
cd ${workdir}
setsid env --default-signal=INT,QUIT sh -c 'echo $$ > ${TASK_GROUP}/runner/cgroup.procs && exec "$@"' launch ${AS_USER.join(' ')} sh -c 'echo $$ > ${TASK}/pid; "$@" > ${TASK}/log 2>&1; echo $? > ${TASK}/exit' armada "$@" </dev/null >/dev/null 2>&1 &`;
}

/** `launchTask` for one slot of a slotted or packing container: the same task, inside a private mount namespace where
 *  the slot's task dir is bound over `TASK`, each tmpfs path is fresh, and the checkout and the user's home are
 *  overlays whose writes land under the slot's root — so no slot reads another's files or writes the real checkout,
 *  slot 0 included. The `cd` is inside the namespace or it would pin the checkout below the overlay. Its cgroup caps at
 *  `memoryBytes`: the container's memory split evenly across fixed slots, or, packing, what every task holds together,
 *  which also caps the group over all of them (`tasksMemoryBytes`), in memory alone: with no swap past it, a task past
 *  its estimate is killed and runs again alone, rather than every task slowed by swapping. Network is shared: two tasks binding one fixed
 *  port collide. */
export function launchSlot(workdir: string, slot: number, limits: { readonly cpus: number; readonly memoryBytes: number; readonly tasksMemoryBytes?: number }, tmpfs: readonly string[]): string {
  const root = slotRoot(slot);
  const dir = slotTask(slot);
  const group = taskGroup(slot);
  const fresh = tmpfs.map((path) => `mount -t tmpfs -o mode=1777,size=6g tmpfs ${path}`).join('\n');

  return String.raw`set -eu
${groupSetup(group, limits)}
rm -rf ${root}
mkdir -p ${dir} ${dir}/artifacts ${root}/upper ${root}/work ${root}/home-upper ${root}/home-work
chown -R ci:ci ${root}
setsid env --default-signal=INT,QUIT sh -c 'echo $$ > ${group}/runner/cgroup.procs
"$@" 2>${root}/launch.err || true
[ -f ${dir}/exit ] || { cat ${root}/launch.err > ${dir}/log 2>/dev/null; echo 70 > ${dir}/exit; }' launch unshare --mount --propagation private sh -c '
set -eu
mkdir -p ${TASK}
mount --bind ${dir} ${TASK}
${fresh}
mount -t overlay overlay -o userxattr,lowerdir=${workdir},upperdir=${root}/upper,workdir=${root}/work ${workdir}
mount -t overlay overlay -o userxattr,lowerdir=${USER_HOME},upperdir=${root}/home-upper,workdir=${root}/home-work ${USER_HOME}
mount -t tmpfs -o mode=0755,size=1m tmpfs ${STATE}/slots
cd ${workdir}
exec "$@"' ns ${AS_USER.join(' ')} sh -c 'echo $$ > ${TASK}/pid; "$@" > ${TASK}/log 2>&1; echo $? > ${TASK}/exit' armada "$@" </dev/null >/dev/null 2>&1 &`;
}

/** As root: a task ended in `group`, and its answer was read: all it left running ends, and all it wrote under `root`,
 *  its task dir and a slot's overlays, is gone. What it held is free before its job counts it free, and the container's
 *  main process holds for it no longer (`hold`). */
export const clearTask = (group: string, root: string): string => String.raw`set -eu
${endGroup(group)}
rm -rf ${root}`;

/** Waits up to `$1` seconds for what runs in `dir` (a task, a preparation's phase), then prints its exit code, or
 *  nothing while it runs. */
export function waitOn(dir: string): string {
  return String.raw`end=$(( $(date +%s) + $1 ))
while [ ! -f ${dir}/exit ] && [ "$(date +%s)" -lt "$end" ]; do sleep 0.05; done
cat ${dir}/exit 2>/dev/null || true`;
}

export const WAIT = waitOn(TASK);

/** As root, detached so the exec returns: phase `$1` of a preparation, its command the rest, once per container
 *  however often it is asked (the directory claims it), its output to the phase's log and its exit code to its `exit`. */
export const LAUNCH_PHASE = String.raw`set -eu
dir="${STATE}/phases/$1"
shift
mkdir -p ${STATE}/phases
mkdir "$dir" 2>/dev/null || exit 0
setsid sh -c '"$@" > "$0/log" 2>&1; echo $? > "$0/exit"' "$dir" "$@" </dev/null >/dev/null 2>&1 &`;

/** `group`'s task's cgroup after it exited: its peak memory in bytes, its CPU time in microseconds, and how many of its
 *  processes the kernel killed for memory; then, for a task in a slot of its own, the bytes its writes left on the
 *  container's disk under the slot's `root` (its overlays and its task dir). */
export const usageOf = (group: string, root?: string): string =>
  String.raw`cat ${group}/memory.peak; sed -n 's/^usage_usec //p' ${group}/cpu.stat; sed -n 's/^oom_kill //p' ${group}/memory.events${root === undefined ? '' : `; du -sxb ${root} | cut -f1`}`;

/** `usageOf`'s answer, or nothing for a group already gone. An answer from before the kills and the disk were read
 *  carries neither. */
export function usageFrom(stdout: string): Pick<Outcome, 'peakMemory' | 'cpuSeconds' | 'oomKilled' | 'diskBytes'> {
  const [memory, cpu, killed, disk] = stdout.trim().split('\n').map(Number);

  if (memory === undefined || cpu === undefined || !Number.isFinite(memory) || !Number.isFinite(cpu)) return {};

  return { peakMemory: memory, cpuSeconds: cpu / 1e6, oomKilled: killed !== undefined && killed > 0 ? true : undefined, diskBytes: disk !== undefined && Number.isFinite(disk) ? disk : undefined };
}

/** The shortest secret masked: a shorter one would hide ordinary text. */
export const MASKED_BYTES = 4;

/** Where the values of the task's secrets wait for its log's mask: as root, and only root reads it, so the task cannot
 *  change what is masked. */
export const MASK_VALUES = `${STATE}/mask.json`;

/** A node program, run as root before the task starts, that writes the values of the secrets `ARMADA_MASK` names to
 *  the file it is given, readable by root alone: the log is masked with the values the task got, whatever the
 *  deployment's secrets hold by the time it ends. */
export const KEEP_MASK = String.raw`const fs = require('fs');
const names = (process.env.ARMADA_MASK || '').split(' ').filter(Boolean);
fs.writeFileSync(process.argv[1], JSON.stringify(names.map((name) => process.env[name] || '')), { mode: 0o600 });`;

/** A node program that replaces, in the log it is given first, every value in the `KEEP_MASK` file it is given second
 *  with `***`, overlapping ones as one span, streamed in 1 MiB reads that carry a secret's length less one byte across each boundary,
 *  then deletes that file. */
export const MASK = String.raw`const fs = require('fs');
const [file, kept] = process.argv.slice(1);
const values = fs.existsSync(kept) ? JSON.parse(fs.readFileSync(kept, 'utf8')) : [];
const secrets = values.map((value) => Buffer.from(value))
  .filter((secret) => secret.length >= ${String(MASKED_BYTES)}).sort((left, right) => right.length - left.length);
const keep = Math.max(0, ...secrets.map((secret) => secret.length - 1));
const mask = Buffer.from('***');
const input = fs.openSync(file, 'r');
const output = fs.openSync(file + '.masked', 'w');
const chunk = Buffer.alloc(1 << 20);
// The raw bytes not yet resolved: any secret starting in them may end in the next read.
let carry = Buffer.alloc(0);
for (;;) {
  const read = fs.readSync(input, chunk, 0, chunk.length, null);
  const text = Buffer.concat([carry, chunk.subarray(0, read)]);
  // A secret starting before the limit ends within this read; one starting past it waits for the next.
  let limit = read === 0 ? text.length : Math.max(0, text.length - keep);
  const next = secrets.map((secret) => text.indexOf(secret));
  const parts = [];
  let at = 0;
  while (at < limit) {
    // The leftmost match, the longest of those starting there: the secrets are longest first.
    let found = -1;
    let hit = 0;
    for (const [index, secret] of secrets.entries()) {
      if (next[index] !== -1 && next[index] < at) next[index] = text.indexOf(secret, at);
      if (next[index] !== -1 && next[index] < limit && (found === -1 || next[index] < found)) {
        found = next[index];
        hit = secret.length;
      }
    }
    if (found === -1) break;
    // Every match that starts inside the masked span widens it, so overlapping secrets mask as one span and none of
    // them shows past another's end.
    let end = found + hit;
    for (let widened = true; widened;) {
      widened = false;
      for (const secret of secrets) {
        for (let from = text.indexOf(secret, found); from !== -1 && from < end; from = text.indexOf(secret, from + 1)) {
          if (from + secret.length > end) {
            end = from + secret.length;
            widened = true;
          }
        }
      }
    }
    // A span reaching past what this read resolves may widen again in the next one: it waits for it whole.
    if (read !== 0 && end > limit) {
      limit = found;
      break;
    }
    parts.push(text.subarray(at, found), mask);
    at = end;
  }
  if (at < limit) {
    parts.push(text.subarray(at, limit));
    at = limit;
  }
  fs.writeSync(output, Buffer.concat(parts));
  if (read === 0) break;
  carry = text.subarray(at);
}
fs.closeSync(input);
fs.closeSync(output);
fs.renameSync(file + '.masked', file);
fs.rmSync(kept, { force: true });`;

/** Ends the task in `dir` and everything it started: its session a TERM, a KILL once it has had 2 s to end, then its
 *  whole `group`. No `--` before a group: dash's `kill`, the image's /bin/sh, refuses it as "Illegal number". */
export const killOf = (dir: string, group: string): string => String.raw`set -eu
pid="$(cat ${dir}/pid 2>/dev/null || true)"
if [ -n "$pid" ]; then
  kill -TERM "-$pid" 2>/dev/null || true
  n=0
  while kill -0 "-$pid" 2>/dev/null && [ "$n" -lt 40 ]; do n=$((n + 1)); sleep 0.05; done
  kill -KILL "-$pid" 2>/dev/null || true
fi
${endGroup(group)}`;

/** A size's instance type, as a start takes it. */
export const instanceOf = (size: Size): ContainerStartupOptions['instance'] => SIZES[size].instance;

/** What a container's main process runs under tini, which reaps orphans as PID 1. The platform stops an instance (a
 *  rollout, a host's maintenance) by sending its main process SIGTERM, then SIGKILL 15 minutes later, and a bare
 *  `sleep` would end at the SIGTERM and take the running task with it. This marks the container stopping
 *  (`STOPPING`), so its vessel claims nothing more, holds while a task under `state` runs or its answer is unread (its
 *  vessel clears it once read, `clearTask`), up to `graceSeconds`, and exits. The containers Dew's CI lost mid-task
 *  were not stopped this way: none was marked stopping first. */
export function hold(state: string, graceSeconds: number): string {
  return String.raw`trap 'stop=1' TERM
stop=
while [ -z "$stop" ]; do sleep 5 & wait $!; done
date -u +%Y-%m-%dT%H:%M:%SZ > ${state}/stopping
end=$(( $(date +%s) + ${String(graceSeconds)} ))
while :; do
  held=
  for dir in ${state}/task ${state}/slots/*/task; do
    [ -f "$dir/pid" ] && held=1
  done
  [ -z "$held" ] || [ "$(date +%s)" -ge "$end" ] && break
  sleep 1
done`;
}

/** A container's main process: `hold` under tini, a minute short of the platform's SIGKILL. */
export const ENTRYPOINT = ['tini', '--', '/bin/sh', '-c', hold(STATE, 14 * 60)];

export interface Exec extends Omit<ContainerExecOptions, 'user' | 'signal'> {
  /** An exec can wait on a container that never answers. */
  readonly ms: number;
  readonly asUser?: boolean;
}

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `body` with an abort signal armed for `ms`, disarmed once `body` settles. `AbortSignal.timeout` is never disarmed:
 *  its timer aborts the exec even after the exec answered, and the platform logs that abort as an error on whatever
 *  event the object is in then. */
export async function bounded<T>(ms: number, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(new DOMException(`the exec did not answer in ${String(ms)} ms`, 'TimeoutError')); }, ms);

  try {
    return await body(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** `argv` in the container, as root or as the user, and its whole output. */
export async function run(container: Container, argv: readonly string[], options: Exec): Promise<Ran> {
  const { ms, asUser = false, ...exec } = options;

  return await bounded(ms, async (signal) => {
    const child = await container.exec(asUser ? [...AS_USER, ...argv] : [...argv], { ...exec, signal });
    const out = await child.output();
    const decoder = new TextDecoder();

    return { exitCode: out.exitCode, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
  });
}

/** `run`, refused on a non-zero exit with the tail of what it said, and named on any other failure. */
export async function must(container: Container, doing: string, argv: readonly string[], options: Exec): Promise<Ran> {
  const [settled] = await Promise.allSettled([run(container, argv, options)]);

  if (settled.status === 'rejected') throw new Error(`${doing} failed to run`, { cause: settled.reason });
  const ran = settled.value;

  if (ran.exitCode !== 0) throw new Error(`${doing} exited ${String(ran.exitCode)}: ${failureTail(ran.stdout, ran.stderr)}`);

  return ran;
}

/** `body` written to `path` for the user, through a pipe: an exec's `stdin` given a stream fails on large bodies
 *  (`internal error`), the pipe does not. `path` is replaced whole once written, so a script already reading it reads
 *  it as it was. `secret` keeps it root's alone (mode 600), for a body only the launch reads, which holds the task's
 *  secrets. */
export async function pipeIn(container: Container, body: ReadableStream | string, path: string, { secret = false } = {}): Promise<void> {
  const owned = secret ? '' : ' && chmod 644 "$part" && chown ci:ci "$part"';
  const writer = await container.exec(['/bin/sh', '-c', `mkdir -p "$(dirname "$1")" && part="$(mktemp "$1.XXXXXX")" && cat > "$part"${owned} && mv -f "$part" "$1"`, 'pipe-in', path], { stdin: 'pipe' });

  if (writer.stdin === null) throw new Error(`writing ${path}: the exec took no stdin`);
  const source = body instanceof ReadableStream ? body : new Blob([body]).stream();

  await source.pipeTo(writer.stdin);
  const written = await writer.output();

  if (written.exitCode !== 0) throw new Error(`writing ${path} exited ${String(written.exitCode)}: ${new TextDecoder().decode(written.stderr).slice(-600)}`);
}

/** A container started anew: one an earlier attempt left running, which `running` may not report yet, goes first. */
async function startFresh(container: Container, options: ContainerStartupOptions): Promise<void> {
  if (container.running) await container.destroy();

  try {
    container.start(options);
  } catch (cause) {
    if (!(cause instanceof Error && cause.message.includes('already running'))) throw cause;
    await container.destroy();
    container.start(options);
  }
}

/** How soon a start that is not answering yet is asked again. At a second, a start was used only on the next ask:
 *  1,256 starts of Kinu's CI (armada-v2, 2026-10-10) peaked at 0.2, 0.75, 1.7 and 2.8 s, a second apart. */
const START_POLL_MS = 100;

/** A start from a snapshot the platform no longer has. Every start from it ends the same way, so the start ends at once:
 *  the environment that recorded it is prepared again (`ArmadaEnvironments.lost`). */
export class MissingSnapshot extends Error {
  constructor(readonly snapshot: string, ended: string, options: ErrorOptions) {
    super(`the container's start ended: ${ended}`, options);
  }
}

/** A start the platform refused because the account runs as many containers as its limits allow. No start succeeds
 *  until another container ends, so the start ends at once, and its starter waits for room as it does for its fleet's. */
export class AccountFull extends Error {
  constructor(ended: string, options: ErrorOptions) {
    super(`the container's start ended: ${ended}`, options);
  }
}

/** A container on a host of a CPU its job does not name (`JobSpec.cpu`): its job replaces it (#40). */
export class Misplaced extends Error {
  constructor(readonly host: Host, cpus: readonly Cpu[]) {
    super(`its host, ${hostLabel(host)}, is not the ${cpuLabel(cpus)} its job requires`);
  }
}

/** The first CPU's lines of /proc/cpuinfo, which `hostOf` reads. */
export const CPU_INFO = String.raw`sed '/^$/q' /proc/cpuinfo`;

/** The flags each x86-64 level adds to the one below it, from v2 up (the psABI's microarchitecture levels). */
const LEVELS: readonly (readonly string[])[] = [
  ['cx16', 'lahf_lm', 'popcnt', 'pni', 'sse4_1', 'sse4_2', 'ssse3'],
  ['avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe', 'xsave'],
  ['avx512f', 'avx512bw', 'avx512cd', 'avx512dq', 'avx512vl'],
];

/** The host `CPU_INFO` printed. A field it lacks reads as nothing, and a family or model as -1. */
export function hostOf(cpuinfo: string): Host {
  const field = (name: string) => new RegExp(String.raw`^${name}\s*:\s*(.*)$`, 'mu').exec(cpuinfo)?.[1]?.trim() ?? '';
  const number = (name: string) => /^\d+$/u.test(field(name)) ? Number(field(name)) : -1;
  const flags = new Set(field('flags').split(/\s+/u));
  const below = LEVELS.findIndex((added) => !added.every((flag) => flags.has(flag)));
  const reached = below === -1 ? LEVELS.length : below;

  return { vendor: field('vendor_id'), family: number('cpu family'), model: number('model'), name: field('model name'), level: reached === 0 ? 0 : reached + 1 };
}

/** How long a start may take to answer, the container's inactivity timeout once it does, and who hears of each start
 *  made again. */
interface Starting {
  readonly ms: number;
  readonly inactivityMs: number;
  readonly restarted?: (why: string) => Promise<void>;
}

/** The container's first answer, started with `options`. An exec, or `setInactivityTimeout`, right after a start can be
 *  refused as not started or not running yet, and a start can end before it answers: each is waited out, starting
 *  again where the container is gone, up to `ms`, and `restarted` told why each start before it ended. A start the
 *  platform ends because its snapshot is gone throws `MissingSnapshot`, and one it ends because the account is full,
 *  `AccountFull`. */
export async function startAndAnswer(container: Container, options: ContainerStartupOptions, { ms, inactivityMs, restarted = async () => undefined }: Starting): Promise<void> {
  const deadline = Date.now() + ms;
  const snapshot = options.containerSnapshot?.id ?? '';
  // Why a start ended, when it did: the runtime says so only through `monitor()`.
  let ended = '';

  // The platform's only word of a deleted snapshot: its monitor ends the start so (armada-v2, 2026-10-09).
  const gone = (): boolean => snapshot !== '' && ended.includes(`Snapshot "${snapshot}" was not found`);
  // And of a full account (1,429 starts on 2026-10-10 to 12).
  const full = (): boolean => ended.includes('Account resource limit exceeded');

  const watch = (): void => {
    detach(container.monitor().then(() => { ended = 'the container exited'; }), (error) => { ended = said({ cause: error }); });
  };

  await startFresh(container, options);
  watch();

  for (;;) {
    const [first] = await Promise.allSettled([(async () => {
      // A restored snapshot's hostname does not resolve until it is set.
      await must(container, 'the first exec', ['/bin/sh', '-c', 'hostname localhost; echo ready'], { ms });
      await container.setInactivityTimeout(inactivityMs);
    })()]);

    if (first.status === 'fulfilled') return;

    if (gone()) throw new MissingSnapshot(snapshot, ended, { cause: first.reason });

    if (full()) throw new AccountFull(ended, { cause: first.reason });
    const refused = first.reason instanceof Error ? `${first.reason.message} ${String(first.reason.cause)}` : String(first.reason);
    // The runtime killed the container as it came up: a restored snapshot's first exec exits 137 (146 of a suite's 208
    // containers at once on 2026-10-10). It is started again, as one whose start ended is.
    const killed = refused.startsWith('the first exec exited 137');

    if (!(killed || /has not been started|is not running/u.test(refused)) || Date.now() > deadline) {
      throw ended === '' ? first.reason : new Error(`the container's start ended: ${ended}`, { cause: first.reason });
    }

    await scheduler.wait(START_POLL_MS);

    if (full()) throw new AccountFull(ended, { cause: first.reason });

    // A container still starting is not running either; only one whose start ended, or was killed, is started again,
    // and one whose snapshot is gone never is.
    if (!gone() && (ended !== '' || killed)) {
      await restarted(killed ? 'killed as it came up (137)' : ended);
      ended = '';
      await startFresh(container, options);
      watch();
    }
  }
}
