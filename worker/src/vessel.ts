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
import { boundaryOf, BUNDLE_PATH, detach, failureTail, INLINE_BYTES, JOB_DEADLINE_SECONDS, PY_BUNDLE_PATH, type Commit, type Outcome } from '../../src/protocol';
import {
  AccountFull, clearTask, ENTRYPOINT, EXEC_MS, INACTIVITY_MS, KEEP_MASK, SLICE_MS, WAIT_SECONDS, MASK, MASK_VALUES, OWN_STATE, TASK, TASK_GROUP, USER_HOME, argvOf, bounded, killOf, launchArgv, launchSlot, launchTask, maskValuesOf, MissingSnapshot, mounts, must, pipeIn, positional, receive, run, slotRoot, slotTask, startAndAnswer, STATE, STOPPED, taskGroup, usageFrom, usageOf, waitOn,
} from './container';
import { bundleKey, equal, packKey, runKey, said, SINGLE, textOf, type Env } from './env';
import { CAPACITY_RETRY_MS, grantOf, letGo } from './fleet';
import type { Claim, Gang } from './job';
import { GANG_DOWN, GANG_UP, LINK_ID, Piped, RELAY, RELAY_HEADER, RELAY_IN, RELAY_LOG, RELAY_PY } from './relay';

export interface VesselSpec {
  readonly jobId: string;
  readonly name: string;
  readonly snapshot: string;
  readonly instance: ContainerStartupOptions['instance'];
  readonly vcpus: number;
  readonly workdir: string;
  readonly commit: (Commit & { readonly project: string; readonly history: 'full' | 'commit' }) | null;
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
  /** One slot's memory cap in bytes: the size's memory split evenly across the slots, or, packing, what its tasks
   *  hold together. */
  readonly slotMemoryBytes?: number;
  /** It takes as many tasks as their estimates fit (`ArmadaJob`'s packing), each in a slot of its own, and caps what
   *  they hold together at `slotMemoryBytes`. Absent for an earlier Worker's spec, which packs none. */
  readonly pack?: boolean;
  /** The vCPUs its job holds at once to run its widest gang: the fleet grants this container only if all of them fit,
   *  so two jobs' gangs never each hold part of what both need. Absent for an earlier Worker's spec, which reserves
   *  its own. */
  readonly reserve?: number;
  /** When its job's deadline ends it, so the fleet holds its vCPUs no longer than it may run. Absent for an earlier
   *  Worker's spec, whose jobs ended at six hours. */
  readonly deadlineAt?: number;
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
  if (spec.slots <= 1 && spec.pack !== true) return { dir: TASK, group: TASK_GROUP, mask: MASK_VALUES, isolated: false };

  return { dir: slotTask(slot), group: taskGroup(slot), mask: maskValuesOf(slot), isolated: true };
}

export type State = 'waiting' | 'booting' | 'working' | 'done' | 'failed' | 'stopped';

/** How a task ended: its exit code, and `timeout` when the vessel killed it at its limit. */
export interface Ending {
  readonly exitCode: number;
  readonly reason?: 'timeout';
}

/** The task running, kept without its environment, which only its launch needed: a job's env may carry a credential. */
export interface Current {
  readonly claim: Omit<Claim, 'env'>;
  readonly startedAt: number;
  /** How it ended, once it did; the outcome its job is told, once its answer is read and stored, or null where its job
   *  keeps another answer; whether its job no longer wants it; and, for a stop, that what it keeps of the task is read.
   *  Each is kept before the next step, so an object restarted on the way takes its finish or its stop up from its last
   *  (`finish`, `stopTask`). Once its files are read, only the clear, which may be made again, and its job's word are
   *  left: a restart reads nothing a clear took. */
  readonly ending?: Ending;
  readonly outcome?: Outcome | null;
  readonly stopping?: true;
  readonly read?: true;
}

/** How one slot's loop ended its slice: the slice ran out, the job had no task for it, or how long to wait for one. */
type SlotEnd = 'reslice' | 'retired' | number;

/** A slice of a vessel's slot loops: when it ends, the flag the first failed loop sets, and what a loop calls when it
 *  started a task (a packing vessel then opens one more slot to ask). */
interface Slice {
  readonly until: number;
  readonly abort: { failed: boolean };
  readonly started: () => void;
}

/** The most tasks a packing container runs at once, as the most slots a fixed one has. */
const PACKED_SLOTS = 16;

/** Where slot `slot`'s running task is kept. */
const slotKey = (slot: number): string => `slot:${String(slot)}`;


/** A start that has not answered in this long is a lost vessel; a snapshot new to a machine has taken 92 s. */
const START_MS = 240_000;

/** A name `export` takes: the task's variables named so reach it through its launch file (`positional`). */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Waits in a row whose exec the platform lost before the container counts as lost: a wait only reads whether the
 *  task ended, so one lost connection says nothing of the task, which runs on. */
const LOST_WAITS = 3;

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
  private watching = false;

  /** Each relay WebSocket's pipe into the container, which holds nothing of its link (`Piped`). */
  private readonly pipes = new Map<WebSocket, Piped>();

  async begin(spec: VesselSpec): Promise<void> {
    await this.ctx.storage.put({ spec, state: 'waiting' satisfies State, requested: Date.now() });
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** The job ended or gave this vessel up: whatever it runs stops, and its capacity returns. Whether its container is
   *  gone (`end`). */
  async stop(): Promise<boolean> {
    const gone = await this.end('stopped', await this.ctx.storage.get<VesselSpec>('spec'));

    await this.ctx.storage.deleteAlarm();

    return gone;
  }

  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<VesselSpec>('spec');
    const state = await this.ctx.storage.get<State>('state');

    if (stored === undefined || (state !== 'waiting' && state !== 'booting' && state !== 'working')) return;
    const spec = specOf(stored);
    const job = this.env.JOB.getByName(spec.jobId);

    try {
      if (state === 'waiting') {
        const fleet = this.env.FLEET.getByName(SINGLE);

        // One whose job runs no gang wider than it may borrow past the fleet's cap: it asks before each new task.
        const grant = grantOf(await fleet.acquire(this.holder(spec), spec.vcpus, {
          reserve: spec.reserve, borrows: (spec.reserve ?? spec.vcpus) <= spec.vcpus, deadlineAt: spec.deadlineAt ?? Date.now() + JOB_DEADLINE_SECONDS * 1000,
        }));

        if (grant === null) {
          await job.moved(spec.name, 'waiting');
          await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RETRY_MS);

          return;
        }

        // The fleet's answer let other calls in: a vessel stopped meanwhile gives back what it was just granted.
        if ((await this.ctx.storage.get<State>('state')) !== 'waiting') return await fleet.release(this.holder(spec));
        await this.ctx.storage.put({ state: 'booting' satisfies State, granted: Date.now(), borrowed: grant === 'borrowed' });
        await job.moved(spec.name, 'booting');
      }

      if (state !== 'working') await this.boot(spec);

      if (await this.work(spec)) await this.ctx.storage.setAlarm(Date.now());
    } catch (cause) {
      if ((await this.ctx.storage.get<State>('state')) === 'stopped') return;

      if (cause instanceof AccountFull) return await this.waitForRoom(spec);
      console.error(JSON.stringify({ vessel: this.holder(spec), state, error: said({ cause }) }));
      const gone = await this.end('failed', spec);

      await job.vesselFailed(spec.name, said({ cause }), { gone, missing: cause instanceof MissingSnapshot ? cause.snapshot : undefined });
    }
  }

  /** The account had no room for the container: its fleet's hold goes back, and it waits for room again, as for its
   *  fleet's. Its boot counts the wait from its request to its next grant (`Boot.waitMs`), so the start it gave up is
   *  no start of its own. */
  private async waitForRoom(spec: VesselSpec): Promise<void> {
    await this.ctx.storage.delete('restarts');
    await this.ctx.storage.put('state', 'waiting' satisfies State);
    await letGo(this.ctx, this.env, { holder: this.holder(spec), inactivityMs: INACTIVITY_MS });

    // Letting go let other calls in: a vessel stopped meanwhile stays stopped.
    if ((await this.ctx.storage.get<State>('state')) !== 'waiting') return;
    await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RETRY_MS);
    await this.env.JOB.getByName(spec.jobId).moved(spec.name, 'waiting');
  }

  /** The vessel ended as `state`: it takes up no task again, its container goes, and its capacity returns once the
   *  container is gone. Whether it is: one that will not stop ends at its inactivity timeout, and until then its tasks
   *  may run and its capacity stays held. */
  private async end(state: 'stopped' | 'failed' | 'done', spec: VesselSpec | undefined): Promise<boolean> {
    await this.ctx.storage.put('state', state);
    await this.ctx.storage.delete([...(await this.ctx.storage.list<Current>({ prefix: 'slot:' })).keys()]);

    return await letGo(this.ctx, this.env, { holder: spec === undefined ? undefined : this.holder(spec), inactivityMs: INACTIVITY_MS });
  }

  private holder(spec: VesselSpec): string {
    return `${spec.jobId}/${spec.name}`;
  }

  private container(): Container {
    if (this.ctx.container === undefined) throw new Error('ArmadaVessel has no container binding');

    return this.ctx.container;
  }

  /** The container started from the job's snapshot and given what its tasks need, each phase timed (`Boot`, #32). One
   *  granted under an earlier Worker, which kept no grant of its own, waited 0. Each start made again is kept as it is
   *  made, so a boot this object takes up again after it restarted mid-start tells the starts made before, and its own. */
  private async boot(spec: VesselSpec): Promise<void> {
    const container = this.container();
    const requested = (await this.ctx.storage.get<number>('requested')) ?? Date.now();
    const granted = (await this.ctx.storage.get<number>('granted')) ?? requested;
    const before = await this.ctx.storage.get<string[]>('restarts');
    const restarts = before === undefined ? [] : [...before, 'this vessel restarted during the start'];

    const restarted = async (why: string): Promise<void> => {
      restarts.push(why);
      await this.ctx.storage.put('restarts', restarts);
    };

    await this.ctx.storage.put('restarts', restarts);
    await startAndAnswer(container, { containerSnapshot: { id: spec.snapshot }, instance: spec.instance, enableInternet: true, entrypoint: ENTRYPOINT }, { ms: START_MS, inactivityMs: INACTIVITY_MS, restarted });
    const answered = Date.now();

    await must(container, 'the tmpfs mounts', ['/bin/sh', '-c', mounts(spec.tmpfs)], { ms: EXEC_MS });

    if (spec.commit !== null) {
      const pack = await this.env.ARTIFACTS.get(await packKey(spec.commit.project, spec.commit));

      if (pack === null) throw new Error(`the pack of ${spec.commit.sha} is not in R2`);
      await pipeIn(container, pack.body, `${STATE}/pack`);
      // As the user under its own home, or git warns it cannot read root's, pushing its real error down.
      const argv = ['/bin/sh', '-c', receive(spec.workdir), 'receive', spec.commit.sha, ...boundaryOf(spec.commit, spec.commit.history)];

      await must(container, 'the checkout', argv, { asUser: true, env: { HOME: USER_HOME }, cwd: spec.workdir, ms: EXEC_MS });
    }

    await must(container, 'owning the state', ['/bin/sh', '-c', OWN_STATE], { ms: EXEC_MS });

    for (const [name, text] of Object.entries(spec.files)) await pipeIn(container, text, `${STATE}/files/${name}`);

    if (spec.bundle !== null) {
      const bundle = await this.env.ARTIFACTS.get(bundleKey(spec.bundle));

      if (bundle === null) throw new Error(`the bundle ${spec.bundle} is not in R2`);
      await pipeIn(container, bundle.body, spec.runtime === 'python' ? PY_BUNDLE_PATH : BUNDLE_PATH);
    }

    await this.ctx.storage.put('state', 'working' satisfies State);
    await this.ctx.storage.delete('restarts');
    await this.env.JOB.getByName(spec.jobId).booted(spec.name, answered - granted, { waitMs: granted - requested, startMs: answered - granted, restarts, setupMs: Date.now() - answered });
  }

  /** Keeps why the container ended, if it ends while this object runs: the runtime says so only through `monitor()`. */
  private watch(container: Container): void {
    if (this.watching) return;
    this.watching = true;
    detach(this.monitor(container), (error) => { console.error(JSON.stringify({ watching: said({ cause: error }) })); });
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

  /** Every task this vessel runs, for the gang token `fetch` answers. Each slot's task under its own key (`slotKey`):
   *  concurrent slot loops never lose each other's update. */
  private async currents(): Promise<Current[]> {
    return [...(await this.ctx.storage.list<Current>({ prefix: 'slot:' })).values()];
  }

  /** One slot's slice: pull a task while free, block on `waitOn` while one runs, finish it, repeat — all slots' loops
   *  run beside each other, so one slot's store never idles another's launch. A null claim ends this loop retired; a
   *  `waitMs` parks only this slot; a fatal error fails the vessel once through `abort`. */
  private async slotLoop(spec: SlotSpec, slot: number, { until, abort, started }: Slice): Promise<SlotEnd> {
    const container = this.container();
    const job = this.env.JOB.getByName(spec.jobId);
    const { dir, group } = layoutOf(spec, slot);
    let lost = 0;

    while (Date.now() < until && !abort.failed) {
      let current = await this.ctx.storage.get<Current>(slotKey(slot));

      if (current?.ending !== undefined) {
        await this.finish(spec, slot, current, current.ending);
        continue;
      }

      if (current?.stopping === true) {
        await this.stopTask(spec, slot, current);
        continue;
      }

      if (current === undefined) {
        // A container the platform is stopping takes no new task: the vessel fails, and the job replaces it.
        const stopping = (await must(container, 'the stop check', ['/bin/sh', '-c', STOPPED], { ms: EXEC_MS })).stdout.trim();

        if (stopping !== '') throw new Error(`the platform asked the container to stop at ${stopping}`);

        // Borrowed vCPUs the fleet recalled take no new task: the slot retires, and the vessel once all of them have.
        if ((await this.ctx.storage.get<boolean>('borrowed')) === true && !(await this.env.FLEET.getByName(SINGLE).renews(this.holder(spec)))) return 'retired';
        const claim = await job.claim(spec.name, slot);

        if (claim === null) return 'retired';

        // The tasks left wait out a retry's backoff: this slot waits with them; the others run on.
        if ('waitMs' in claim) return claim.waitMs;
        // Its env stays out of storage: a job's env may carry a credential, which only the launch needs.
        const { env: _env, ...kept } = claim;

        await this.launch(spec, container, claim, slot);
        current = { claim: kept, startedAt: Date.now() };
        await this.ctx.storage.put(slotKey(slot), current);
        started();

        if (claim.gang !== undefined && !(await job.started(spec.name, claim.index, claim.attempt))) {
          await this.stopTask(spec, slot, current);
          continue;
        }
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

      if (!(await job.still(spec.name, current.claim.index, slot, current.claim.attempt))) await this.stopTask(spec, slot, current);
    }

    return 'reslice';
  }

  /** Runs its slots' loops for a slice; true while there is more to do, false once the vessel retired or every slot
   *  waits out a backoff. A fixed vessel runs every slot's loop. A packing one runs a loop for each slot that holds a
   *  task and one more that asks for another, and a loop that starts a task opens one more, up to `PACKED_SLOTS`: a
   *  loop the job has nothing fitting for ends, and the next task started opens another to ask again. */
  private async work(spec: SlotSpec): Promise<boolean> {
    this.watch(this.container());
    const until = Date.now() + SLICE_MS;
    const abort = { failed: false };
    // Every loop opened this slice, and the slots whose loops still run: a slot ended this slice is not opened again.
    const loops: Promise<SlotEnd>[] = [];
    const used = new Set<number>();

    const open = (slot: number): void => {
      used.add(slot);
      // The first loop to fail sets the flag, which stops the others at their next step; once every loop has stopped,
      // that failure fails the vessel once, through the alarm's catch, with no loop still claiming for it.
      loops.push((async () => {
        try {
          return await this.slotLoop(spec, slot, { until, abort, started: widen });
        } catch (cause) {
          abort.failed = true;

          throw cause;
        }
      })());
    };

    const widen = (): void => {
      const free = Array.from({ length: PACKED_SLOTS }, (_, slot) => slot).find((slot) => !used.has(slot));

      if (spec.pack === true && free !== undefined) open(free);
    };

    if (spec.pack === true) {
      const held = [...(await this.ctx.storage.list<Current>({ prefix: 'slot:' })).keys()].map((key) => Number(key.slice('slot:'.length)));

      for (const slot of held) open(slot);
      widen();
    } else {
      for (let slot = 0; slot < spec.slots; slot += 1) open(slot);
    }

    // Loops open more as they go: settled again until no new one was opened meanwhile.
    let settled: PromiseSettledResult<SlotEnd>[] = [];

    while (settled.length < loops.length) settled = await Promise.allSettled(loops);
    const failed = settled.find((each) => each.status === 'rejected');

    if (failed !== undefined) throw failed.reason;
    const ended = settled.flatMap((each) => each.status === 'fulfilled' ? [each.value] : []);

    if (ended.every((each) => each === 'retired')) return await this.retire(spec);

    if (ended.includes('reslice')) return true;
    // Every slot that has not retired waits out a backoff: the next alarm is the soonest of them.
    await this.ctx.storage.setAlarm(Date.now() + Math.min(...ended.filter((each): each is number => each !== 'retired' && each !== 'reslice')));

    return false;
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

    if (!layout.isolated) await keep();
    await this.network(container, claim.gang);
    const argv = argvOf(slot);
    // A slot's task gets its slot's cgroup, so its group reads and caps reach the slot's, not the single task group.
    const env = { ...claim.env, ARMADA_CGROUP: layout.group };
    // Names a shell can export go in the file; any other stays in the exec, as before.
    const exported = Object.fromEntries(Object.entries(env).filter(([name]) => SHELL_NAME.test(name)));
    const rest = Object.fromEntries(Object.entries(env).filter(([name]) => !SHELL_NAME.test(name)));

    await pipeIn(container, positional(claim.argv, exported), argv, { secret: true });

    if (layout.isolated) {
      const limits = { memoryBytes: spec.slotMemoryBytes, tasksMemoryBytes: spec.pack === true ? spec.slotMemoryBytes : undefined };

      await must(container, 'the launch', ['/bin/sh', '-c', launchArgv(argv, launchSlot(spec.workdir, slot, limits, spec.tmpfs)), 'launch'], { env: rest, ms: EXEC_MS });
      await keep();
    } else {
      await must(container, 'the launch', ['/bin/sh', '-c', launchArgv(argv, launchTask(spec.workdir)), 'launch'], { env: rest, ms: EXEC_MS });
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
    const token = (await this.currents()).map((current) => current.claim.gang?.token).find((gang) => gang !== undefined);

    if (token === undefined || !equal(token, request.headers.get(RELAY_HEADER) ?? '')) return new Response('forbidden', { status: 403 });
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

  /** `current`'s task stopped, its job no longer wanting it: killed, its log kept for a gang's rank, its slot cleared, and
   *  its job told, which a copy's twin waits on to report its answer. The slot keeps it until its job has it, so an
   *  object restarted on the way stops it again and tells its job, which takes the word once; a container that stopped
   *  holds nothing to kill. */
  private async stopTask(spec: SlotSpec, slot: number, current: Current): Promise<void> {
    const { dir, group } = layoutOf(spec, slot);

    if (current.read !== true) {
      await this.ctx.storage.put(slotKey(slot), { ...current, stopping: true } satisfies Current);

      if (this.ctx.container?.running === true) {
        await must(this.container(), 'the kill', ['/bin/sh', '-c', killOf(dir, group)], { ms: EXEC_MS });

        // Every rank of a gang keeps its log: the cause of a gang's failure is often in another rank's.
        if (current.claim.gang !== undefined) await this.keepLog(spec, slot, current);
      }

      await this.ctx.storage.put(slotKey(slot), { ...current, stopping: true, read: true } satisfies Current);
    }

    await this.clear(spec, slot);
    await this.env.JOB.getByName(spec.jobId).stopped(spec.name, current.claim.index, { slot, attempt: current.claim.attempt });
    await this.ctx.storage.delete(slotKey(slot));
  }

  /** The task's answer, if it is the one kept: its log and output into R2, then its outcome to the job. Each step is
   *  kept before the next, and the slot only once the job has the outcome: an object restarted on the way finishes
   *  again from its last step, and the job takes the same answer once. */
  private async finish(spec: SlotSpec, slot: number, current: Current, ending: Ending): Promise<void> {
    const ended: Current = { ...current, ending };

    if (current.ending === undefined) await this.ctx.storage.put(slotKey(slot), ended);
    const outcome = current.outcome === undefined ? await this.answer(spec, slot, ended, ending) : current.outcome;

    if (current.outcome === undefined) await this.ctx.storage.put(slotKey(slot), { ...ended, outcome } satisfies Current);
    await this.clear(spec, slot);

    if (outcome !== null) await this.env.JOB.getByName(spec.jobId).complete(spec.name, outcome, outcome.seconds * 1000);
    await this.ctx.storage.delete(slotKey(slot));
  }

  /** The outcome of `current`'s task, which ended `ending`, its log, output and artifacts stored; or null where the job
   *  keeps another answer. */
  private async answer(spec: SlotSpec, slot: number, current: Current, { exitCode, reason }: Ending): Promise<Outcome | null> {
    const container = this.container();
    const { dir, group, isolated } = layoutOf(spec, slot);
    const { index, attempt } = current.claim;
    const rank = current.claim.gang?.rank ?? 0;
    const job = this.env.JOB.getByName(spec.jobId);

    // Every rank of a gang keeps its log: the cause of a gang's failure is often in another rank's.
    if (current.claim.gang !== undefined) await this.keepLog(spec, slot, current);

    if (!(await job.accept(spec.name, index, exitCode, { slot, attempt }))) return null;
    const seconds = (Date.now() - current.startedAt) / 1000;

    if (current.claim.gang === undefined) await this.keepLog(spec, slot, current);
    const tail = await run(container, ['/bin/sh', '-c', tailOf(dir)], { ms: EXEC_MS });
    // What it used is a measurement, never a reason to lose the task.
    const usage = usageFrom(await this.optional(container, 'usage', ['/bin/sh', '-c', usageOf(group, isolated ? slotRoot(slot) : undefined)]) ?? '');

    await must(container, 'packing the artifacts', ['/bin/sh', '-c', `if [ -n "$(find ${dir}/artifacts -mindepth 1 -print -quit 2>/dev/null)" ]; then tar -czf ${dir}/artifacts.tar.gz -C ${dir}/artifacts .; fi`], { ms: EXEC_MS });
    // Raw bytes: an output file may be an image or an archive, which a text decode would corrupt.
    const kept = { vessel: spec.name, attempt };
    const out = spec.output || spec.bundle !== null ? await this.store(`${dir}/out`, runKey(spec.jobId, index, kept, 'output'), {}) : null;
    const value = out === null || out.small === null ? undefined : textOf(out.small);
    // A gang's artifacts are its rank 0's; an empty directory stores nothing.
    const packed = rank === 0 ? await this.store(`${dir}/artifacts.tar.gz`, runKey(spec.jobId, index, kept, 'artifacts'), { contentType: 'application/gzip' }) : null;
    // A pushed task's runner says whether its out file is the body's envelope or its command's answer; a runner that
    // ended before it said leaves no file. The answer is no measurement: a read the platform lost loses the run.
    const marker = spec.bundle === null ? '' : (await run(container, ['head', '-c', '256', `${dir}/answer`], { ms: EXEC_MS })).stdout.trim();
    const [kind = '', error] = marker.split('\n');
    const answer = kind === 'value' || kind === 'command' ? kind : undefined;

    return {
      index, kind: 'exited', reason, exitCode, seconds, vessel: spec.name, attempt, slot, tail: tail.stdout, output: out !== null, value, answer, artifacts: packed === null ? undefined : true, error, ...usage,
    };
  }

  /** A slot's task cleared (`clearTask`) once its answer is read, before its job counts the slot free. A container that
   *  stopped holds nothing to clear: a finish taken up after the platform stopped it completes all the same. */
  private async clear(spec: SlotSpec, slot: number): Promise<void> {
    const { group, isolated } = layoutOf(spec, slot);

    if (this.ctx.container?.running !== true) return;
    await must(this.container(), 'clearing the task', ['/bin/sh', '-c', clearTask(group, isolated ? slotRoot(slot) : TASK), 'clear'], { ms: EXEC_MS });
  }

  /** What a command printed, or null, said in the log, when it could not run: for what a task's outcome reads but
   *  never fails over, its usage. */
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
    await this.store(`${dir}/log.gz`, runKey(spec.jobId, current.claim.index, { vessel: spec.name, attempt: current.claim.attempt }, 'log'),
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
    const gone = await this.end('done', spec);

    await this.env.JOB.getByName(spec.jobId).retired(spec.name, gone);

    return false;
  }
}
