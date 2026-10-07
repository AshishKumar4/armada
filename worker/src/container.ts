/**
 * What runs inside a container, and the one way the Worker runs it. Every container starts on the `durable_object`
 * scheduling policy, so each start names what it starts from (the recipe's base image while preparing, an environment
 * snapshot otherwise) and its instance: no image to build, push or roll out, and a container starts the way a Kinu
 * devbox wakes (Kinu DEVBOX-DECISIONS D50, D72; 0.3 to 2.3 s measured from a warm snapshot, 2026-10-06).
 */
import { failureTail } from '../../src/protocol';

/** The unprivileged user every task runs as. The exec's own `user` option fails on this runtime (`internal error`,
 *  measured 2026-10-06), so a command drops to the user inside. */
export const AS_USER = ['setpriv', '--reuid=ci', '--regid=ci', '--init-groups', '--'];

/** The runner's own state in a container: the pack, the job's files, the handler, the current task. */
export const STATE = '/armada';

export const TASK = `${STATE}/task`;

const PARENT_GROUP = '/sys/fs/cgroup/armada';

/** The cgroup a task runs in, delegated to the user, so a task can give what it starts groups and limits of its own
 *  (a test runner's per-file memory). The task itself is in its `runner` child: a group whose children have
 *  controllers holds no process. Everything in it ends with the task, daemons it detached with `setsid` included. */
export const TASK_GROUP = `${PARENT_GROUP}/task`;

/** Controllers a task's groups get: CPU and memory to read and to cap, pids to bound. */
const CONTROLLERS = '+cpu +memory +pids';

/** As root: ends everything in the task's group, the user's nested groups included, and removes them. */
const END_GROUP = String.raw`if [ -d ${TASK_GROUP} ]; then
  echo 1 > ${TASK_GROUP}/cgroup.kill
  n=0
  while grep -q '^populated 1' ${TASK_GROUP}/cgroup.events; do
    n=$((n + 1)); [ "$n" -lt 100 ] || { echo "${TASK_GROUP} would not empty" >&2; exit 1; }
    sleep 0.05
  done
  find ${TASK_GROUP} -depth -type d -exec rmdir {} +
fi`;

/** git as a GitHub runner has it: Debian trixie's 2.47 prints no `path=` records for `rev-list --objects -z`. Built
 *  from kernel.org's release, pinned by digest. */
const GIT = { version: '2.53.0', sha256: '5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653' };

/**
 * The runner's layer on any Debian or Ubuntu base, as root, before the recipe's own setup: the user and the
 * directories; tini, which reaps what a task's daemons orphan; setpriv, to drop to the user; node, for handlers; and
 * the tools a GitHub runner has that a stock container lacks and suites reach for (git as the runner has it, iproute2,
 * strace, procps, zip, a compiler). Every recipe inherits it, and `DRIVER` keys it.
 */
export function runnerLayer(workdir: string): string {
  return String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
hostname localhost || true
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl tini util-linux procps psmisc lsof iproute2 strace \
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

/** As root, detached so the exec returns: whatever the last task left running ended, then one task as the user in its
 *  own session and a fresh `TASK_GROUP` delegated to the user, its output to the task's log, its exit code to the
 *  task's `exit`. A shell starts a background command with SIGINT and SIGQUIT ignored, and the task would inherit
 *  that; it gets their defaults back, as a GitHub runner's step has them, so a ^C it sends reaches what it runs. The
 *  groups are set up here, at each launch, so a container an earlier Worker started has them. */
export function launchTask(workdir: string): string {
  return String.raw`set -eu
mkdir -p ${PARENT_GROUP}
echo '${CONTROLLERS}' > ${PARENT_GROUP}/cgroup.subtree_control
${END_GROUP}
mkdir -p ${TASK_GROUP}/runner
echo '${CONTROLLERS}' > ${TASK_GROUP}/cgroup.subtree_control
for owned in . cgroup.procs cgroup.threads cgroup.subtree_control runner runner/cgroup.procs runner/cgroup.threads runner/cgroup.subtree_control; do chown ci:ci "${TASK_GROUP}/$owned"; done
rm -rf ${TASK}
mkdir -p ${TASK}
chown ci:ci ${TASK}
cd ${workdir}
setsid env --default-signal=INT,QUIT sh -c 'echo $$ > ${TASK_GROUP}/runner/cgroup.procs && exec "$@"' launch ${AS_USER.join(' ')} sh -c 'echo $$ > ${TASK}/pid; "$@" > ${TASK}/log 2>&1; echo $? > ${TASK}/exit' armada "$@" </dev/null >/dev/null 2>&1 &`;
}

/** Waits up to `$1` seconds for the task, then prints its exit code, or nothing while it runs. */
export const WAIT = String.raw`end=$(( $(date +%s) + $1 ))
while [ ! -f ${TASK}/exit ] && [ "$(date +%s)" -lt "$end" ]; do sleep 0.05; done
cat ${TASK}/exit 2>/dev/null || true`;

/** Ends the task and everything it started: its session a TERM, then 2 s later a KILL, then its whole group. */
export const KILL = String.raw`set -eu
pid="$(cat ${TASK}/pid 2>/dev/null || true)"
if [ -n "$pid" ]; then
  kill -TERM -- "-$pid" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-$pid" 2>/dev/null || true
fi
${END_GROUP}`;

/** A handler: a function's source, called with the item, its value written to `{out}`. */
export function handlerModule(source: string): string {
  return `import { writeFileSync } from 'node:fs';
const handler = (${source});
const value = await handler(JSON.parse(process.env.ARMADA_ITEM));
writeFileSync(process.env.ARMADA_OUT, JSON.stringify(value === undefined ? null : value));
`;
}

/** A snapshot's container runs under tini, which reaps orphans as PID 1. */
export const ENTRYPOINT = ['tini', '--', 'sleep', 'infinity'];

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

/** `argv` in the container, as root or as the user, and its whole output. */
export async function run(container: Container, argv: readonly string[], options: Exec): Promise<Ran> {
  const { ms, asUser = false, ...exec } = options;
  const child = await container.exec(asUser ? [...AS_USER, ...argv] : [...argv], { ...exec, signal: AbortSignal.timeout(ms) });
  const out = await child.output();
  const decoder = new TextDecoder();

  return { exitCode: out.exitCode, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
}

/** `run`, refused on a non-zero exit with the tail of what it said, and named on any other failure. */
export async function must(container: Container, doing: string, argv: readonly string[], options: Exec): Promise<Ran> {
  const [settled] = await Promise.allSettled([run(container, argv, options)]);

  if (settled.status === 'rejected') throw new Error(`${doing} failed to run`, { cause: settled.reason });
  const ran = settled.value;

  if (ran.exitCode !== 0) throw new Error(`${doing} exited ${String(ran.exitCode)}: ${failureTail(ran.stdout, ran.stderr)}`);

  return ran;
}

/** `body` written to `path` for the user, piped as Kinu's devbox golden pipes its tools: an exec's `stdin` given a
 *  stream fails on large bodies (`internal error`, 2026-10-06), the pipe does not. */
export async function pipeIn(container: Container, body: ReadableStream | string, path: string): Promise<void> {
  const writer = await container.exec(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1" && chown ci:ci "$1"', 'pipe-in', path], { stdin: 'pipe' });

  if (writer.stdin === null) throw new Error(`writing ${path}: the exec took no stdin`);
  const source = typeof body === 'string' ? new Blob([body]).stream() : body;

  await source.pipeTo(writer.stdin);
  const written = await writer.output();

  if (written.exitCode !== 0) throw new Error(`writing ${path} exited ${String(written.exitCode)}: ${new TextDecoder().decode(written.stderr).slice(-600)}`);
}

/** A container started anew: one an earlier attempt left running, which `running` may not report yet, goes first. */
export async function startFresh(container: Container, options: ContainerStartupOptions): Promise<void> {
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
      // A restored snapshot's hostname does not resolve until it is set (Dew 6ec7406a5).
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
