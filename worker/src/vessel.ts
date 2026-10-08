/**
 * ArmadaVessel: one container of a job's pool. It waits for fleet capacity, starts from the job's environment snapshot
 * (taking in the commit, the job's files and its function's bundle once), then pulls tasks from the job until the queue has
 * none left for it: launch one detached, wait on it in short blocking reads, store its output and log in R2 once, and
 * report its outcome. Its loop runs in alarms of about a minute each, so no request holds it, and its state is in
 * storage, so a restarted object takes the same task up again. A task it was told to drop (another vessel's answer
 * landed first, or the job ended) is killed with its whole session.
 *
 * A rank of a gang task waits for its gang to form, joins the gang's network (`relay.ts`) before it launches, and pipes
 * the WebSockets the other ranks' relays open to it (`fetch`), each to a connection into its container's relay.
 */
import { DurableObject } from 'cloudflare:workers';
import { BUNDLE_PATH, failureTail, INLINE_BYTES, PY_BUNDLE_PATH, type Outcome } from '../../src/protocol';
import {
  ENTRYPOINT, KEEP_MASK, MASK, MASK_VALUES, TASK, TASK_GROUP, USER_HOME, bounded, killOf, launchSlot, launchTask, maskValuesOf, mounts, must, pipeIn, receive, run, slotTask, startAndAnswer, STATE, STOPPED, taskGroup, usageFrom, usageOf, waitOn,
} from './container';
import { bundleKey, copyInto, packKey, said, taskKey, textOf, type Env } from './env';
import type { Claim, Gang } from './job';
import { GANG_DOWN, GANG_UP, LINK_ID, Piped, RELAY, RELAY_HEADER, RELAY_IN, RELAY_LOG, RELAY_PY } from './relay';

export interface VesselSpec {
  readonly jobId: string;
  readonly name: string;
  readonly snapshot: string;
  readonly instance: ContainerStartupOptions['instance'];
  readonly vcpus: number;
  readonly workdir: string;
  readonly commit: { readonly sha: string; readonly base: string; readonly packer?: number; readonly project: string; readonly history: 'full' | 'commit' } | null;
  readonly tmpfs: readonly string[];
  readonly files: Record<string, string>;
  /** A function job's bundle, by digest. */
  readonly bundle: string | null;
  /** What runs the bundle; absent on an earlier Worker's spec, which is always node. */
  readonly runtime?: 'node' | 'python';
  /** Whether a task's `{out}` is kept. */
  readonly output: boolean;
  /** A task's own bound, in seconds. */
  readonly timeout: number;
  /** The tasks this container runs at once: 1 (absent for an earlier Worker's spec) shares today's layout; more
   *  gives each slot its own namespace, overlay and cgroup. */
  readonly slots?: number;
  /** One slot's memory cap in bytes: the size's memory split evenly across the slots. */
  readonly slotMemoryBytes?: number;
}

/** A stored spec with its later fields filled: an earlier Worker's lacks `slots`, `slotMemoryBytes` and `runtime`. */
export interface SlotSpec extends VesselSpec {
  readonly runtime: 'node' | 'python';
  readonly slots: number;
  readonly slotMemoryBytes: number;
}

/** The spec `begin` stored, every later field defaulted, so a use site never re-derives them. */
export function specOf(stored: VesselSpec): SlotSpec {
  return { ...stored, runtime: stored.runtime ?? 'node', slots: stored.slots ?? 1, slotMemoryBytes: stored.slotMemoryBytes ?? 0 };
}

/** Everything that differs between a shared container's task and one slot of a slotted container: the slot's task
 *  dir (or the shared `TASK`), its cgroup, its mask file, and whether the launch is the isolated one. */
export interface SlotLayout {
  readonly dir: string;
  readonly group: string;
  readonly mask: string;
  readonly isolated: boolean;
}

export function layoutOf(spec: SlotSpec, slot: number): SlotLayout {
  if (spec.slots <= 1) return { dir: TASK, group: TASK_GROUP, mask: MASK_VALUES, isolated: false };

  return { dir: slotTask(slot), group: taskGroup(slot), mask: maskValuesOf(slot), isolated: true };
}

type State = 'waiting' | 'booting' | 'working' | 'done' | 'failed' | 'stopped';

/** How a task ended: its exit code, and `timeout` when the vessel killed it at its limit. */
interface Ending {
  readonly exitCode: number;
  readonly reason?: 'timeout';
}

/** The task running, kept without its environment, which only its launch needed: a job's env may carry a credential. */
interface Current {
  readonly claim: Omit<Claim, 'env'>;
  readonly startedAt: number;
}

const SLOT_RETRY_MS = 5_000;

/** A start that has not answered in this long is a lost vessel; a snapshot new to a machine has taken 92 s. */
const START_MS = 240_000;

const EXEC_MS = 90_000;

/** One alarm's share of the loop; the next alarm takes it up at once. */
const SLICE_MS = 50_000;

/** One blocking wait on a running task. */
const WAIT_SECONDS = 20;

/** Waits in a row whose exec the platform lost before the container counts as lost: a wait only reads whether the
 *  task ended, so one lost connection says nothing of the task, which runs on. */
const LOST_WAITS = 3;

/** Longer than a job may take, so only the job's end stops the container. */
const INACTIVITY_MS = 6 * 60 * 60_000;

/** Lines of a task's log kept with its outcome; the whole log is in R2. */
const TAIL_LINES = 40;

/** The most of a log's end the tail is read from, so a log of one huge line costs its outcome only this. */
export const TAIL_BYTES = 16 * 1024;

/** The last `TAIL_LINES` lines of the log in `dir`, read from its last `TAIL_BYTES` bytes at most. */
export const tailOf = (dir: string): string => `tail -c ${String(TAIL_BYTES)} ${dir}/log 2>/dev/null | tail -n ${String(TAIL_LINES)} || true`;

export class ArmadaVessel extends DurableObject<Env> {
  /** When this object started: one started after its task launched was restarted under it. */
  private readonly born = Date.now();

  /** Whether this object watches its container's end (`watch`). */
  /** Why the container ended, watched once this object runs it. */
  private watching: Promise<void> | null = null;

  /** Each relay WebSocket's pipe into the container, which holds nothing of its link (`Piped`). */
  private readonly pipes = new Map<WebSocket, Piped>();

  async begin(spec: VesselSpec): Promise<void> {
    await this.ctx.storage.put({ spec, state: 'waiting' satisfies State, requested: Date.now() });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** The job ended or gave this vessel up: whatever it runs stops, and its capacity returns. */
  async stop(): Promise<void> {
    const spec = await this.ctx.storage.get<VesselSpec>('spec');

    await this.ctx.storage.put('state', 'stopped' satisfies State);
    // A claim an earlier Worker stored kept its env: a stopped vessel takes up no task again.
    await this.ctx.storage.delete('current');
    await this.ctx.storage.delete([...(await this.ctx.storage.list<Current>({ prefix: 'slot:' })).keys()]);
    await this.ctx.storage.deleteAlarm();
    // Stopping is the job's last word: a container that will not stop ends at its inactivity timeout.
    await Promise.allSettled([this.ctx.container?.destroy()]);

    if (spec !== undefined) await this.fleet().release(this.holder(spec));
  }

  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<VesselSpec>('spec');
    const state = await this.ctx.storage.get<State>('state');

    if (stored === undefined || (state !== 'waiting' && state !== 'booting' && state !== 'working')) return;
    const spec = specOf(stored);
    const job = this.env.JOB.getByName(spec.jobId);

    try {
      if (state === 'waiting') {
        if (!(await this.fleet().acquire(this.holder(spec), spec.vcpus))) {
          await job.waiting(spec.name);
          await this.ctx.storage.setAlarm(Date.now() + SLOT_RETRY_MS);

          return;
        }

        await this.ctx.storage.put({ state: 'booting' satisfies State, requested: Date.now() });
      }

      if ((await this.ctx.storage.get<State>('state')) === 'booting') await this.boot(spec);

      if (await this.work(spec)) await this.ctx.storage.setAlarm(Date.now());
    } catch (cause) {
      if ((await this.ctx.storage.get<State>('state')) === 'stopped') return;
      await this.ctx.storage.put('state', 'failed' satisfies State);
      await this.ctx.storage.delete('current');
      await this.ctx.storage.delete([...(await this.ctx.storage.list<Current>({ prefix: 'slot:' })).keys()]);
      console.error(JSON.stringify({ vessel: this.holder(spec), state, error: said({ cause }) }));
      await Promise.allSettled([this.ctx.container?.destroy()]);
      await this.fleet().release(this.holder(spec));
      await job.vesselFailed(spec.name, said({ cause }));
    }
  }

  private holder(spec: VesselSpec): string {
    return `${spec.jobId}/${spec.name}`;
  }

  private fleet() {
    return this.env.FLEET.getByName('all');
  }

  private container(): Container {
    if (this.ctx.container === undefined) throw new Error('ArmadaVessel has no container binding');

    return this.ctx.container;
  }

  private async boot(spec: VesselSpec): Promise<void> {
    const container = this.container();
    const requested = (await this.ctx.storage.get<number>('requested')) ?? Date.now();

    await startAndAnswer(container, { containerSnapshot: { id: spec.snapshot }, instance: spec.instance, enableInternet: true, entrypoint: ENTRYPOINT }, START_MS, INACTIVITY_MS);
    const bootMs = Date.now() - requested;

    await must(container, 'the tmpfs mounts', ['/bin/sh', '-c', mounts(spec.tmpfs)], { ms: EXEC_MS });

    if (spec.commit !== null) {
      const pack = await this.env.ARTIFACTS.get(packKey(spec.commit.project, spec.commit.sha, spec.commit.base, spec.commit.packer));

      if (pack === null) throw new Error(`the pack of ${spec.commit.sha} is not in R2`);
      await pipeIn(container, pack.body, `${STATE}/pack`);
      // As the user under its own home, or git warns it cannot read root's, pushing its real error down.
      await must(container, 'the checkout', ['/bin/sh', '-c', receive(spec.workdir, spec.commit.history), 'receive', spec.commit.sha], { asUser: true, env: { HOME: USER_HOME }, cwd: spec.workdir, ms: EXEC_MS });
    }

    for (const [name, text] of Object.entries(spec.files)) await pipeIn(container, text, `${STATE}/files/${name}`);

    if (spec.bundle !== null) {
      const bundle = await this.env.ARTIFACTS.get(bundleKey(spec.bundle));

      if (bundle === null) throw new Error(`the bundle ${spec.bundle} is not in R2`);
      await pipeIn(container, bundle.body, spec.runtime === 'python' ? PY_BUNDLE_PATH : BUNDLE_PATH);
    }

    await this.ctx.storage.put('state', 'working' satisfies State);
    await this.env.JOB.getByName(spec.jobId).booted(spec.name, bootMs);
  }

  /** Runs the loop for a slice; true while there is more to do, false once the vessel retired. */
  /** Keeps why the container ended, if it ends while this object runs: the runtime says so only through `monitor()`. */
  private watch(container: Container): void {
    this.watching ??= this.monitor(container);
  }

  private async monitor(container: Container): Promise<void> {
    let how = 'exited';

    try {
      await container.monitor();
    } catch (cause) {
      how = `ended: ${said({ cause })}`;
    }

    await this.ctx.storage.put('ended', `${how} at ${new Date().toISOString()}`);
  }

  /** What a lost container's error says of it: how it ended, if this object saw, and whether this object was
   *  restarted under the task. */
  private async lostAt(current: Current): Promise<string> {
    const ended = (await this.ctx.storage.get<string>('ended')) ?? 'ended unseen by this object';
    const restarted = this.born > current.startedAt ? `restarted ${String(Math.round((this.born - current.startedAt) / 1000))} s into the task` : 'up since before the task';

    return `the container ${ended}; this object ${restarted}`;
  }

  /** The task running in `slot`: `slot:<n>` now, a `current` an earlier Worker left read as slot 0, whose dir is
   *  `TASK` because its vessel is not slotted. Each slot's own key: concurrent slot loops never lose each other's
   *  update. */
  private async current(slot: number): Promise<Current | undefined> {
    const kept = await this.ctx.storage.get<Current>(`slot:${String(slot)}`);

    if (kept !== undefined) return kept;

    if (slot !== 0) return undefined;
    const legacy = await this.ctx.storage.get<Current>('current');

    if (legacy === undefined) return undefined;
    await this.ctx.storage.delete('current');
    await this.putCurrent(0, legacy);

    return legacy;
  }

  private async putCurrent(slot: number, current: Current): Promise<void> {
    await this.ctx.storage.put(`slot:${String(slot)}`, current);
  }

  private async dropCurrent(slot: number): Promise<void> {
    await this.ctx.storage.delete(`slot:${String(slot)}`);
  }

  /** Every task this vessel runs, by slot: for the gang token `fetch` answers and a lost container's word. */
  private async currents(): Promise<Map<number, Current>> {
    const slots = new Map<number, Current>();
    const legacy = await this.ctx.storage.get<Current>('current');

    for (const [key, current] of await this.ctx.storage.list<Current>({ prefix: 'slot:' })) slots.set(Number(key.slice('slot:'.length)), current);

    if (legacy !== undefined) slots.set(0, legacy);

    return slots;
  }

  /** One slot's slice: pull a task while free, block on `waitOn` while one runs, finish it, repeat — all slots' loops
   *  run beside each other, so one slot's store never idles another's launch. A null claim ends this loop retired; a
   *  `waitMs` parks only this slot; a fatal error fails the vessel once through `abort`. */
  private async slotLoop(spec: SlotSpec, slot: number, until: number, abort: { failed: boolean }): Promise<'reslice' | 'retired' | number> {
    const container = this.container();
    const job = this.env.JOB.getByName(spec.jobId);
    const { dir, group } = layoutOf(spec, slot);
    let lost = 0;

    while (Date.now() < until && !abort.failed) {
      let current = await this.current(slot);

      if (current === undefined) {
        // A container the platform is stopping takes no new task: the vessel fails, and the job replaces it.
        const stopping = (await must(container, 'the stop check', ['/bin/sh', '-c', STOPPED], { ms: EXEC_MS })).stdout.trim();

        if (stopping !== '') throw new Error(`the platform asked the container to stop at ${stopping}`);
        const claim = await job.claim(spec.name, slot);

        if (claim === null) return 'retired';

        // The tasks left wait out a retry's backoff: this slot waits with them; the others run on.
        if ('waitMs' in claim) return claim.waitMs;
        // Its env stays out of storage: a job's env may carry a credential, which only the launch needs.
        const { env: _env, ...kept } = claim;

        await this.launch(spec, container, claim, slot);
        current = { claim: kept, startedAt: Date.now() };
        await this.putCurrent(slot, current);
      }

      const seconds = Math.max(1, Math.min(WAIT_SECONDS, Math.floor((until - Date.now()) / 1000)));
      const [waited] = await Promise.allSettled([run(container, ['/bin/sh', '-c', waitOn(dir), 'wait', String(seconds)], { ms: (seconds + 30) * 1000 })]);

      if (waited.status === 'rejected') {
        lost += 1;

        if (lost < LOST_WAITS) continue;
        throw new Error(`the wait failed to run (${await this.lostAt(current)})`, { cause: waited.reason });
      }

      lost = 0;

      if (waited.value.exitCode !== 0) throw new Error(`the wait exited ${String(waited.value.exitCode)}: ${failureTail(waited.value.stdout, waited.value.stderr)}`);
      const exit = waited.value.stdout.trim();

      if (exit !== '') {
        await this.finish(spec, slot, current, { exitCode: Number(exit) });
        continue;
      }

      if (Date.now() - current.startedAt > spec.timeout * 1000) {
        await must(container, 'the kill', ['/bin/sh', '-c', killOf(dir, group)], { ms: EXEC_MS });
        await this.finish(spec, slot, current, { exitCode: 124, reason: 'timeout' });
        continue;
      }

      if (!(await job.still(spec.name, current.claim.index))) {
        await must(container, 'the kill', ['/bin/sh', '-c', killOf(dir, group)], { ms: EXEC_MS });

        if (current.claim.gang !== undefined) await this.keepLog(spec, slot, current);
        await this.dropCurrent(slot);
        // A copy stopped for its twin's answer, which waits until this one can no longer end red.
        await job.stopped(spec.name, current.claim.index);
      }
    }

    return 'reslice';
  }

  private async work(spec: SlotSpec): Promise<boolean> {
    const container = this.container();
    const slots = spec.slots;

    this.watch(container);
    const until = Date.now() + SLICE_MS;
    const abort = { failed: false };

    // The first loop to fail sets the flag, which stops the others at their next step; once every loop has stopped,
    // that failure fails the vessel once, through the alarm's catch, with no loop still claiming for it.
    const loops = Array.from({ length: slots }, async (_, slot) => {
      try {
        return await this.slotLoop(spec, slot, until, abort);
      } catch (cause) {
        abort.failed = true;

        throw cause;
      }
    });

    const settled = await Promise.allSettled(loops);
    const failed = settled.find((each) => each.status === 'rejected');

    if (failed !== undefined) throw failed.reason;
    const ended = settled.flatMap((each) => each.status === 'fulfilled' ? [each.value] : []);

    if (ended.every((each) => each === 'retired')) return await this.retire(spec);

    if (ended.every((each) => each !== 'reslice')) {
      const at = Math.min(...ended.filter((each) => each !== 'retired'));

      if (Number.isFinite(at)) {
        await this.ctx.storage.setAlarm(Date.now() + at);

        return false;

      }
    }

    return true;
  }

  /** One claim launched into `slot`: the values its secrets started with kept for the log's mask, its gang's
   *  network joined (a plain task leaves any), the launch detached. A slotted launch recreates the slot's root where
   *  the file lives, so the keeping goes last there; a plain one keeps today's order. */
  private async launch(spec: SlotSpec, container: Container, claim: Claim, slot: number): Promise<void> {
    const layout = layoutOf(spec, slot);

    const keep = async () => {
      // The values the task gets are the ones its log is masked with, kept as root in the container: a secret set
      // again or deleted while the task runs changes neither.
      if (claim.secrets.length > 0) {
        await must(container, 'keeping the secrets to mask', ['node', '-e', KEEP_MASK, layout.mask], { env: { ...claim.env, ARMADA_MASK: claim.secrets.join(' ') }, ms: EXEC_MS });
      }
    };

    // A slotted launch recreates the slot's root inside its namespace, so the keeping goes last there.
    if (!layout.isolated) await keep();
    await this.network(container, claim.gang);

    if (layout.isolated) {
      // Its own cgroup too, so a task's group reads and caps reach the slot's, not the single task group.
      await must(container, 'the launch', ['/bin/sh', '-c', launchSlot(spec.workdir, slot, spec.slotMemoryBytes, spec.tmpfs), 'launch', ...claim.argv], { env: { ...claim.env, ARMADA_CGROUP: layout.group }, ms: EXEC_MS });
      await keep();
    } else {
      await must(container, 'the launch', ['/bin/sh', '-c', launchTask(spec.workdir), 'launch', ...claim.argv], { env: claim.env, ms: EXEC_MS });
    }
  }

  /** The container on `gang`'s network as its rank, or off any gang's for a task that is none's. */
  private async network(container: Container, gang: Gang | undefined): Promise<void> {
    const ganged = await this.ctx.storage.get<boolean>('ganged');

    if (gang === undefined) {
      if (ganged === true) await must(container, 'leaving the gang', ['/bin/sh', '-c', GANG_DOWN], { ms: EXEC_MS });
      await this.ctx.storage.delete('ganged');

      return;
    }

    if (ganged === undefined) await pipeIn(container, RELAY_PY, RELAY);
    await must(container, 'joining the gang', ['/bin/sh', '-c', GANG_UP, 'gang', String(gang.rank), String(gang.vessels.length), gang.origin, gang.job, gang.token,
      ...gang.vessels], { ms: EXEC_MS });
    await this.ctx.storage.put('ganged', true);
  }

  /** A relay's WebSocket from another rank of this vessel's gang, which presents the gang's token, piped to a new
   *  connection into this container's relay under the link's id (`id`), which connects `port` on this rank's address
   *  or, with `resume`, carries on the link it holds. */
  override async fetch(request: Request): Promise<Response> {
    const token = [...(await this.currents()).values()].map((current) => current.claim.gang?.token).find((gang) => gang !== undefined);
    const expected = new TextEncoder().encode(token ?? '');
    const supplied = new TextEncoder().encode(request.headers.get(RELAY_HEADER) ?? '');

    if (token === undefined || expected.length !== supplied.length || !crypto.subtle.timingSafeEqual(expected, supplied)) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    const port = Number(url.searchParams.get('port'));
    const id = url.searchParams.get('id') ?? '';

    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !LINK_ID.test(id) || request.headers.get('upgrade') !== 'websocket') {
      return new Response('a relay is a WebSocket to a port, under a link id', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    if (client === undefined || server === undefined) throw new Error('a WebSocketPair has two ends');
    this.ctx.acceptWebSocket(server);
    const socket = this.container().getTcpPort(RELAY_IN).connect(`localhost:${String(RELAY_IN)}`);

    const piped = new Piped(server, socket.writable.getWriter(), `${id} ${String(port)} ${url.searchParams.has('resume') ? '1' : '0'}`,
      (event, detail) => { console.log(JSON.stringify({ event, path: url.pathname, id, port, ...detail })); });

    this.pipes.set(server, piped);
    piped.start(socket.readable);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const piped = this.pipes.get(socket);

    // A WebSocket this object no longer pipes (it was reset): its relay opens another.
    if (piped === undefined) return socket.close(1011, 'no pipe');
    await piped.message(message);
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    await this.pipes.get(socket)?.closed(code, reason);
    this.pipes.delete(socket);
  }

  override async webSocketError(...[socket, error]: Parameters<NonNullable<DurableObject['webSocketError']>>): Promise<void> {
    await this.pipes.get(socket)?.closed(1006, `failed: ${said({ cause: error })}`);
    this.pipes.delete(socket);
  }

  /** The task's answer, if it is the one kept: its log and output into R2, then its outcome to the job. */
  private async finish(spec: SlotSpec, slot: number, current: Current, { exitCode, reason }: Ending): Promise<void> {
    const container = this.container();
    const { dir, group } = layoutOf(spec, slot);
    const { index, attempt } = current.claim;
    const rank = current.claim.gang?.rank ?? 0;
    const job = this.env.JOB.getByName(spec.jobId);

    await this.dropCurrent(slot);

    // Every rank of a gang keeps its log: the cause of a gang's failure is often in another rank's.
    if (current.claim.gang !== undefined) await this.keepLog(spec, slot, current);

    if (!(await job.accept(spec.name, index, exitCode))) return;
    const seconds = (Date.now() - current.startedAt) / 1000;

    if (current.claim.gang === undefined) await this.keepLog(spec, slot, current);
    const tail = await run(container, ['/bin/sh', '-c', tailOf(dir)], { ms: EXEC_MS });
    // What it used is a measurement, never a reason to lose the task.
    const usage = usageFrom(await this.optional(container, 'usage', ['/bin/sh', '-c', usageOf(group)]) ?? '');

    await must(container, 'packing the artifacts', ['/bin/sh', '-c', `if [ -n "$(find ${dir}/artifacts -mindepth 1 -print -quit 2>/dev/null)" ]; then tar -czf ${dir}/artifacts.tar.gz -C ${dir}/artifacts .; fi`], { ms: EXEC_MS });
    // Raw bytes: an output file may be an image or an archive, which a text decode would corrupt.
    const out = spec.output || spec.bundle !== null ? await this.store(`${dir}/out`, taskKey(spec.jobId, index, 'output', rank), {}) : null;
    const value = out === null || out.small === null ? undefined : textOf(out.small);
    // A gang's artifacts are its rank 0's; an empty directory stores nothing.
    const packed = rank === 0 ? await this.store(`${dir}/artifacts.tar.gz`, taskKey(spec.jobId, index, 'artifacts'), { contentType: 'application/gzip' }) : null;
    // A pushed task's runner says whether its out file is the body's envelope or its command's answer.
    const marker = spec.bundle === null ? '' : (await this.optional(container, 'answer', ['head', '-c', '256', `${dir}/answer`]) ?? '').trim();
    const [kind = '', error] = marker.split('\n');
    const answer = kind === 'value' || kind === 'command' ? kind : undefined;

    const outcome: Outcome = {
      index, kind: 'exited', reason, exitCode, seconds, vessel: spec.name, attempt, slot, tail: tail.stdout, output: out !== null, value, answer, artifacts: packed === null ? undefined : true, error, ...usage,
    };

    if (exitCode === 0 && out !== null && current.claim.cache !== undefined) await this.keepInCache(taskKey(spec.jobId, index, 'output'), current.claim.cache, answer);

    await job.complete(spec.name, outcome, seconds * 1000);
  }

  /** A green answer's output into the job's cache, before its outcome is reported, so a later item like it finds it.
   *  A cache that cannot be written costs only a later rerun: the task's answer stands. */
  private async keepInCache(output: string, cache: { readonly key: string; readonly expires: number }, answer: string | undefined): Promise<void> {
    try {
      const stored = await this.env.ARTIFACTS.get(output);

      if (stored === null) return;
      await copyInto(this.env.ARTIFACTS, cache.key, stored, { expires: String(cache.expires), answer: answer ?? '' });
    } catch (cause) {
      console.error(JSON.stringify({ output, cache: cache.key, error: said({ cause }) }));
    }
  }

  /** What a command printed, or null, said in the log, when it could not run: for what a task's outcome reads but
   *  never fails over, its usage and its answer's marker. */
  private async optional(container: Container, what: string, argv: readonly string[]): Promise<string | null> {
    try {
      return (await run(container, [...argv], { ms: EXEC_MS })).stdout;
    } catch (cause) {
      console.error(JSON.stringify({ reading: what, argv, error: said({ cause }) }));

      return null;
    }
  }

  /** The task's log, its secrets masked, into R2 as its rank's; a gang rank's ends with the relay's own, how each of its
   *  links dropped or ended. Gangs only run with one slot, so `dir` is TASK for them. */
  private async keepLog(spec: SlotSpec, slot: number, current: Current): Promise<void> {
    const { dir, mask } = layoutOf(spec, slot);

    await this.mask(current.claim.secrets, mask, `${dir}/log`);

    if (current.claim.gang !== undefined) {
      await must(this.container(), 'appending the relay\'s log', ['/bin/sh', '-c', `{ echo; echo '--- the relay'; tail -c 65536 ${RELAY_LOG}; } >> ${dir}/log 2>/dev/null || :`], { ms: EXEC_MS });
    }

    await must(this.container(), 'packing the log', ['/bin/sh', '-c', `gzip -c ${dir}/log > ${dir}/log.gz 2>/dev/null || : > ${dir}/log.gz`], { ms: EXEC_MS });
    await this.store(`${dir}/log.gz`, taskKey(spec.jobId, current.claim.index, 'log', current.claim.gang?.rank ?? 0),
      { contentType: 'text/plain; charset=utf-8', contentEncoding: 'gzip' });
  }

  /** The values the task started with, replaced in its log before any of it is read. The deployment's secrets are not
   *  read again: one set anew or deleted meanwhile would leave the value the task had unmasked. */
  private async mask(names: readonly string[] | undefined, kept: string, log: string): Promise<void> {
    if (names === undefined || names.length === 0) return;
    await must(this.container(), 'masking the secrets', ['node', '-e', MASK, log, kept], { ms: EXEC_MS });
  }

  /**
   * A file in the container into R2 under `key`, streamed at any size: R2 takes a stream of a length it knows, so the
   * file's size is read first. Null when there is no such file; else the file's bytes when it is small enough to ride
   * in the task's outcome.
   */
  private async store(path: string, key: string, httpMetadata: R2HTTPMetadata): Promise<{ readonly small: ArrayBuffer | null } | null> {
    const container = this.container();
    const sized = await run(container, ['stat', '-c', '%s', path], { ms: EXEC_MS });

    if (sized.exitCode !== 0) return null;
    const size = Number(sized.stdout.trim());

    if (size <= INLINE_BYTES) {
      return await bounded(EXEC_MS, async (signal) => {
        const read = await (await container.exec(['cat', path], { signal })).output();

        await this.env.ARTIFACTS.put(key, read.stdout, { httpMetadata });

        return { small: read.stdout };
      });
    }

    const reading = await container.exec(['cat', path], { stdout: 'pipe', stderr: 'ignore' });

    if (reading.stdout === null) throw new Error(`reading ${path}: the exec gave no stdout`);
    const known = new FixedLengthStream(size);

    await Promise.all([reading.stdout.pipeTo(known.writable), this.env.ARTIFACTS.put(key, known.readable, { httpMetadata })]);
    const exitCode = await reading.exitCode;

    if (exitCode !== 0) throw new Error(`reading ${path} exited ${String(exitCode)}`);

    return { small: null };
  }

  private async retire(spec: VesselSpec): Promise<false> {
    await this.ctx.storage.put('state', 'done' satisfies State);
    await Promise.allSettled([this.container().destroy()]);
    await this.fleet().release(this.holder(spec));
    await this.env.JOB.getByName(spec.jobId).retired(spec.name);

    return false;
  }
}
