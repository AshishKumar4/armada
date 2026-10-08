/**
 * What runs inside a container, and the one way the Worker runs it. Every container starts on the `durable_object`
 * scheduling policy, so each start names what it starts from (the recipe's base image while preparing, an environment
 * snapshot otherwise) and its instance: no image to build, push or roll out.
 */
import { ARTIFACTS_PATH, failureTail, SIZES, type Size } from '../../src/protocol';

/** The unprivileged user every task runs as. The exec's own `user` option fails on this runtime (`internal error`), so
 *  a command drops to the user inside. */
export const AS_USER = ['setpriv', '--reuid=ci', '--regid=ci', '--init-groups', '--'];

/** The user's home: its HOME wherever it runs, or root's would be read instead. */
export const USER_HOME = '/home/ci';

/** The runner's own state in a container: the pack, the job's files, a function's bundle, the current task. */
export const STATE = '/armada';

export const TASK = `${STATE}/task`;

/** Where slot `slot` of a slotted container lives: its task dir (bound over `TASK` inside the slot's namespace), its
 *  overlays' upper and work dirs, its secrets file. Recreated at each launch, so nothing survives its last task. */
export const slotRoot = (slot: number): string => `${STATE}/slots/${String(slot)}`;

/** The slot's own task dir, as the root side reaches it; inside the slot's namespace it is `TASK` exactly. */
export const slotTask = (slot: number): string => `${slotRoot(slot)}/task`;

/** Where the values of a slotted task's secrets wait for its log's mask: each slot's own, where two slots' tasks
 *  could end together. */
export const maskValuesOf = (slot: number): string => `${slotRoot(slot)}/mask.json`;

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

/** As the user: the pack at /armada/pack into the checkout's repository (a new one while preparing), then the commit
 *  checked out on a local branch, as a GitHub runner's checkout leaves it, and clean. */
export function receive(checkout: string, history: 'full' | 'commit'): string {
  return String.raw`set -eu
sha="$1"
cd ${checkout}
[ -d .git ] || git init -q .
git index-pack --stdin < ${STATE}/pack >/dev/null
rm -f ${STATE}/pack
${history === 'commit' ? 'echo "$sha" >> .git/shallow' : ':'}
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
 *  controllers, the task's own group emptied (`endGroup`), a runner sub-group, an even memory cap for a slot, and
 *  the group handed to the user. The groups are set up here, at each launch, so a container an earlier Worker
 *  started has them. */
function groupSetup(group: string, memoryBytes?: number): string {
  return String.raw`if [ -e ${STOPPING} ]; then echo "the container is stopping since $(cat ${STOPPING})" >&2; exit 75; fi
mkdir -p ${PARENT_GROUP}
echo '${CONTROLLERS}' > ${PARENT_GROUP}/cgroup.subtree_control
${endGroup(group)}
mkdir -p ${group}/runner
echo '${CONTROLLERS}' > ${group}/cgroup.subtree_control
${memoryBytes === undefined ? '' : `echo ${String(memoryBytes)} > ${group}/memory.max
`}for owned in . cgroup.procs cgroup.threads cgroup.subtree_control runner runner/cgroup.procs runner/cgroup.threads runner/cgroup.subtree_control; do chown ci:ci "${group}/$owned"; done`;
}

/** As root, detached so the exec returns: whatever the last task left running ended, then one task as the user in its
 *  own session and a fresh `TASK_GROUP` delegated to the user, its output to the task's log, its exit code to the
 *  task's `exit`. A shell starts a background command with SIGINT and SIGQUIT ignored, and the task would inherit
 *  that; it gets their defaults back, as a GitHub runner's step has them, so a ^C it sends reaches what it runs. */
export function launchTask(workdir: string): string {
  return String.raw`set -eu
${groupSetup(TASK_GROUP)}
rm -rf ${TASK}
mkdir -p ${TASK} ${ARTIFACTS_PATH}
chown ci:ci ${TASK} ${ARTIFACTS_PATH}
cd ${workdir}
setsid env --default-signal=INT,QUIT sh -c 'echo $$ > ${TASK_GROUP}/runner/cgroup.procs && exec "$@"' launch ${AS_USER.join(' ')} sh -c 'echo $$ > ${TASK}/pid; "$@" > ${TASK}/log 2>&1; echo $? > ${TASK}/exit' armada "$@" </dev/null >/dev/null 2>&1 &`;
}

/** `launchTask` for one slot of a slotted container: the same task, inside a private mount namespace where the
 *  slot's task dir is bound over `TASK`, each tmpfs path is fresh, and the checkout and the user's home are overlays
 *  whose writes land under the slot's root — so no slot reads another's files or writes the real checkout, slot 0
 *  included. The `cd` is inside the namespace or it would pin the checkout below the overlay. Its cgroup caps at
 *  `memoryBytes`, the container's memory split evenly across slots. Network is shared: two tasks binding one fixed
 *  port collide. */
export function launchSlot(workdir: string, slot: number, memoryBytes: number, tmpfs: readonly string[]): string {
  const root = slotRoot(slot);
  const dir = slotTask(slot);
  const group = taskGroup(slot);
  const fresh = tmpfs.map((path) => `mount -t tmpfs -o mode=1777,size=6g tmpfs ${path}`).join('\n');

  return String.raw`set -eu
${groupSetup(group, memoryBytes)}
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

/** `group`'s task's cgroup after it exited: its peak memory in bytes, then its CPU time in microseconds. */
export const usageOf = (group: string): string => String.raw`cat ${group}/memory.peak; sed -n 's/^usage_usec //p' ${group}/cpu.stat`;

export const USAGE = usageOf(TASK_GROUP);

/** `USAGE`'s answer, or nothing for a group already gone. */
export function usageFrom(stdout: string): { peakMemory?: number; cpuSeconds?: number } {
  const [memory, cpu] = stdout.trim().split('\n').map(Number);

  return memory !== undefined && cpu !== undefined && Number.isFinite(memory) && Number.isFinite(cpu) ? { peakMemory: memory, cpuSeconds: cpu / 1e6 } : {};
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
 *  with `***`, longest first, streamed in 1 MiB reads that carry a secret's length less one byte across each boundary,
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
let carry = Buffer.alloc(0);
for (;;) {
  const read = fs.readSync(input, chunk, 0, chunk.length, null);
  let text = Buffer.concat([carry, chunk.subarray(0, read)]);
  for (const secret of secrets) {
    const parts = [];
    let from = 0;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, from)) {
      parts.push(text.subarray(from, at), mask);
      from = at + secret.length;
    }
    parts.push(text.subarray(from));
    text = Buffer.concat(parts);
  }
  if (read === 0) {
    fs.writeSync(output, text);
    break;
  }
  const cut = Math.max(0, text.length - keep);
  fs.writeSync(output, text.subarray(0, cut));
  carry = text.subarray(cut);
}
fs.closeSync(input);
fs.closeSync(output);
fs.renameSync(file + '.masked', file);
fs.rmSync(kept, { force: true });`;

/** Ends the task in `dir` and everything it started: its session a TERM, then 2 s later a KILL, then its whole
 *  `group`. */
export const killOf = (dir: string, group: string): string => String.raw`set -eu
pid="$(cat ${dir}/pid 2>/dev/null || true)"
if [ -n "$pid" ]; then
  kill -TERM -- "-$pid" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-$pid" 2>/dev/null || true
fi
${endGroup(group)}`;

export const KILL = killOf(TASK, TASK_GROUP);

/** A size's instance type, as a start takes it. */
export const instanceOf = (size: Size): ContainerStartupOptions['instance'] => SIZES[size].instance;

/** What a container's main process runs under tini, which reaps orphans as PID 1. The platform stops an instance (a
 *  rollout, a host's maintenance) by sending its main process SIGTERM, then SIGKILL 15 minutes later, and a bare
 *  `sleep` would end at the SIGTERM and take the running task with it. This marks the container stopping
 *  (`STOPPING`), so its vessel claims nothing more, holds while the task under `state` runs, up to `graceSeconds`,
 *  then `lingerSeconds` for the vessel to read the answer, and exits. The containers Dew's CI lost mid-task were not
 *  stopped this way: none was marked stopping first. */
export function hold(state: string, graceSeconds: number, lingerSeconds: number): string {
  return String.raw`trap 'stop=1' TERM
stop=
while [ -z "$stop" ]; do sleep 5 & wait $!; done
date -u +%Y-%m-%dT%H:%M:%SZ > ${state}/stopping
end=$(( $(date +%s) + ${String(graceSeconds)} ))
while :; do
  running=
  for dir in ${state}/task ${state}/slots/*/task; do
    [ -f "$dir/pid" ] && [ ! -f "$dir/exit" ] && running=1
  done
  [ -z "$running" ] || [ "$(date +%s)" -ge "$end" ] && break
  sleep 1
done
sleep ${String(lingerSeconds)}`;
}

/** A container's main process: `hold` under tini, a minute short of the platform's SIGKILL. */
export const ENTRYPOINT = ['tini', '--', '/bin/sh', '-c', hold(STATE, 14 * 60, 30)];

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
 *  it as it was. */
export async function pipeIn(container: Container, body: ReadableStream | string, path: string): Promise<void> {
  const writer = await container.exec(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && part="$(mktemp "$1.XXXXXX")" && cat > "$part" && chmod 644 "$part" && chown ci:ci "$part" && mv -f "$part" "$1"', 'pipe-in', path], { stdin: 'pipe' });

  if (writer.stdin === null) throw new Error(`writing ${path}: the exec took no stdin`);
  const source = typeof body === 'string' ? new Blob([body]).stream() : body;

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

/** The container's first answer, started with `options`. An exec, or `setInactivityTimeout`, right after a start can be
 *  refused as not started or not running yet, and a start can end before it answers: each is waited out, starting
 *  again where the container is gone, up to `ms`. */
export async function startAndAnswer(container: Container, options: ContainerStartupOptions, ms: number, inactivityMs: number): Promise<void> {
  const deadline = Date.now() + ms;
  // Why a start ended, when it did: the runtime says so only through `monitor()`.
  let ended = '';
  const watch = () => {
    container.monitor().then(() => { ended = 'the container exited'; }, (cause: unknown) => { ended = String(cause); });
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
    const refused = first.reason instanceof Error ? `${first.reason.message} ${String(first.reason.cause)}` : String(first.reason);

    if (!/has not been started|is not running/u.test(refused) || Date.now() > deadline) {
      throw ended === '' ? first.reason : new Error(`the container's start ended: ${ended}`, { cause: first.reason });
    }

    await scheduler.wait(1_000);

    // A container still starting is not running either; only one whose start ended is started again.
    if (ended !== '') {
      ended = '';
      await startFresh(container, options);
      watch();
    }
  }
}
