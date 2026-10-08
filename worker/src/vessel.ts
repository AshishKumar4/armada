/**
 * ArmadaVessel: one container of a job's pool. It waits for fleet capacity, starts from the job's environment snapshot
 * (taking in the commit, the job's files and its function's bundle once), then pulls tasks from the job until the queue has
 * none left for it: launch one detached, wait on it in short blocking reads, store its output and log in R2 once, and
 * report its outcome. Its loop runs in alarms of about a minute each, so no request holds it, and its state is in
 * storage, so a restarted object takes the same task up again. A task it was told to drop (another vessel's answer
 * landed first, or the job ended) is killed with its whole session.
 *
 * A rank of a gang task waits for its gang to form, joins the gang's network (`relay.ts`) before it launches, and takes
 * the WebSockets the other ranks' relays open to it (`fetch`), each a connection into its container's relay.
 */
import { DurableObject } from 'cloudflare:workers';
import { ANSWER_PATH, ARTIFACTS_PATH, BUNDLE_PATH, failureTail, INLINE_BYTES, OUT_PATH, type Outcome } from '../../src/protocol';
import {
  ENTRYPOINT, KEEP_MASK, KILL, MASK, MASK_VALUES, TASK, USAGE, WAIT, bounded, launchTask, mounts, must, pipeIn, receive, run, startAndAnswer, STATE, STOPPED, usageFrom,
} from './container';
import { bundleKey, copyInto, packKey, said, taskKey, textOf, type Env } from './env';
import type { Claim, Gang } from './job';
import { GANG_DOWN, GANG_UP, RELAY, RELAY_HEADER, RELAY_IN, RELAY_PY } from './relay';

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
  /** Whether a task's `{out}` is kept. */
  readonly output: boolean;
  /** A task's own bound, in seconds. */
  readonly timeout: number;
}

type State = 'waiting' | 'booting' | 'working' | 'done' | 'failed' | 'stopped';

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
  private watching = false;

  /** Each relay WebSocket's connection into the container, by the socket. */
  private readonly relays = new Map<WebSocket, WritableStreamDefaultWriter<Uint8Array>>();

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
    await this.ctx.storage.deleteAlarm();
    // Stopping is the job's last word: a container that will not stop ends at its inactivity timeout.
    await Promise.allSettled([this.ctx.container?.destroy()]);

    if (spec !== undefined) await this.fleet().release(this.holder(spec));
  }

  override async alarm(): Promise<void> {
    const spec = await this.ctx.storage.get<VesselSpec>('spec');
    const state = await this.ctx.storage.get<State>('state');

    if (spec === undefined || (state !== 'waiting' && state !== 'booting' && state !== 'working')) return;
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
      console.error(JSON.stringify({ vessel: this.holder(spec), state, error: said(cause) }));
      await Promise.allSettled([this.ctx.container?.destroy()]);
      await this.fleet().release(this.holder(spec));
      await job.vesselFailed(spec.name, said(cause));
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
      await must(container, 'the checkout', ['/bin/sh', '-c', receive(spec.workdir, spec.commit.history), 'receive', spec.commit.sha], { asUser: true, cwd: spec.workdir, ms: EXEC_MS });
    }

    for (const [name, text] of Object.entries(spec.files)) await pipeIn(container, text, `${STATE}/files/${name}`);

    if (spec.bundle !== null) {
      const bundle = await this.env.ARTIFACTS.get(bundleKey(spec.bundle));

      if (bundle === null) throw new Error(`the bundle ${spec.bundle} is not in R2`);
      await pipeIn(container, bundle.body, BUNDLE_PATH);
    }
    await this.ctx.storage.put('state', 'working' satisfies State);
    await this.env.JOB.getByName(spec.jobId).booted(spec.name, bootMs);
  }

  /** Runs the loop for a slice; true while there is more to do, false once the vessel retired. */
  /** Keeps why the container ended, if it ends while this object runs: the runtime says so only through `monitor()`. */
  private watch(container: Container): void {
    if (this.watching) return;
    this.watching = true;
    const ended = (how: string) => { void this.ctx.storage.put('ended', `${how} at ${new Date().toISOString()}`); };

    container.monitor().then(() => { ended('exited'); }, (cause: unknown) => { ended(`ended: ${said(cause)}`); });
  }

  /** What a lost container's error says of it: how it ended, if this object saw, and whether this object was
   *  restarted under the task. */
  private async lostAt(current: Current): Promise<string> {
    const ended = (await this.ctx.storage.get<string>('ended')) ?? 'ended unseen by this object';
    const restarted = this.born > current.startedAt ? `restarted ${String(Math.round((this.born - current.startedAt) / 1000))} s into the task` : 'up since before the task';

    return `the container ${ended}; this object ${restarted}`;
  }

  private async work(spec: VesselSpec): Promise<boolean> {
    const container = this.container();
    const job = this.env.JOB.getByName(spec.jobId);

    this.watch(container);
    const until = Date.now() + SLICE_MS;
    let lost = 0;

    while (Date.now() < until) {
      const current = await this.ctx.storage.get<Current>('current');

      if (current === undefined) {
        // A container the platform is stopping takes no new task: the vessel fails, and the job replaces it.
        const stopping = (await must(container, 'the stop check', ['/bin/sh', '-c', STOPPED], { ms: EXEC_MS })).stdout.trim();

        if (stopping !== '') throw new Error(`the platform asked the container to stop at ${stopping}`);
        const claim = await job.claim(spec.name);

        if (claim === null) return await this.retire(spec);

        // The tasks left wait out a retry's backoff: the container waits with them.
        if ('waitMs' in claim) {
          await this.ctx.storage.setAlarm(Date.now() + claim.waitMs);

          return false;
        }
        // The values the task gets are the ones its log is masked with, kept as root in the container: a secret set
        // again or deleted while the task runs changes neither.
        if (claim.secrets.length > 0) {
          await must(container, 'keeping the secrets to mask', ['node', '-e', KEEP_MASK, MASK_VALUES], { env: { ...claim.env, ARMADA_MASK: claim.secrets.join(' ') }, ms: EXEC_MS });
        }
        await this.network(container, claim.gang);
        await must(container, 'the launch', ['/bin/sh', '-c', launchTask(spec.workdir), 'launch', ...claim.argv], { env: claim.env, ms: EXEC_MS });
        const { env, ...kept } = claim;

        await this.ctx.storage.put('current', { claim: kept, startedAt: Date.now() } satisfies Current);
        continue;
      }

      const seconds = Math.max(1, Math.min(WAIT_SECONDS, Math.floor((until - Date.now()) / 1000)));
      const [waited] = await Promise.allSettled([run(container, ['/bin/sh', '-c', WAIT, 'wait', String(seconds)], { ms: (seconds + 30) * 1000 })]);

      if (waited.status === 'rejected') {
        lost += 1;

        if (lost < LOST_WAITS) continue;
        throw new Error(`the wait failed to run (${await this.lostAt(current)})`, { cause: waited.reason });
      }
      lost = 0;

      if (waited.value.exitCode !== 0) throw new Error(`the wait exited ${String(waited.value.exitCode)}: ${failureTail(waited.value.stdout, waited.value.stderr)}`);
      const exit = waited.value.stdout.trim();

      if (exit !== '') {
        await this.finish(spec, current, Number(exit));
        continue;
      }

      if (Date.now() - current.startedAt > spec.timeout * 1000) {
        await must(container, 'the kill', ['/bin/sh', '-c', KILL], { ms: EXEC_MS });
        await this.finish(spec, current, 124, 'timeout');
        continue;
      }

      if (!(await job.still(spec.name, current.claim.index))) {
        await must(container, 'the kill', ['/bin/sh', '-c', KILL], { ms: EXEC_MS });
        await this.ctx.storage.delete('current');
      }
    }

    return true;
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

  /** A relay's WebSocket from another rank of this vessel's gang, which presents the gang's token: a connection into
   *  this container's relay, which connects `port` on this rank's address. */
  override async fetch(request: Request): Promise<Response> {
    const token = (await this.ctx.storage.get<Current>('current'))?.claim.gang?.token;
    const expected = new TextEncoder().encode(token ?? '');
    const supplied = new TextEncoder().encode(request.headers.get(RELAY_HEADER) ?? '');

    if (token === undefined || expected.length !== supplied.length || !crypto.subtle.timingSafeEqual(expected, supplied)) return new Response('forbidden', { status: 403 });
    const port = Number(new URL(request.url).searchParams.get('port'));

    if (!Number.isInteger(port) || port < 1 || port > 65_535 || request.headers.get('upgrade') !== 'websocket') return new Response('a relay is a WebSocket to a port', { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());

    if (client === undefined || server === undefined) throw new Error('a WebSocketPair has two ends');
    this.ctx.acceptWebSocket(server);
    const socket = this.container().getTcpPort(RELAY_IN).connect(`localhost:${String(RELAY_IN)}`);
    const writer = socket.writable.getWriter();

    this.relays.set(server, writer);
    await writer.write(new TextEncoder().encode(`${String(port)}\n`));
    void (async () => {
      const reader = socket.readable.getReader();

      for (let read = await reader.read(); !read.done; read = await reader.read()) server.send(read.value);
      server.close(1000, 'closed');
    })().catch(() => { server.close(1011, 'the connection failed'); });

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const writer = this.relays.get(socket);

    if (writer === undefined) return socket.close(1011, 'no connection');
    await writer.write(typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message));
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.relays.get(socket)?.close().catch(() => undefined);
    this.relays.delete(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  /** The task's answer, if it is the one kept: its log and output into R2, then its outcome to the job. */
  private async finish(spec: VesselSpec, current: Current, exitCode: number, reason?: 'timeout'): Promise<void> {
    const container = this.container();
    const { index, attempt } = current.claim;
    const rank = current.claim.gang?.rank ?? 0;
    const job = this.env.JOB.getByName(spec.jobId);

    await this.ctx.storage.delete('current');

    if (!(await job.accept(spec.name, index))) return;
    const seconds = (Date.now() - current.startedAt) / 1000;

    await this.mask(current.claim.secrets);
    const tail = await run(container, ['/bin/sh', '-c', tailOf(TASK)], { ms: EXEC_MS });
    // What it used is a measurement, never a reason to lose the task.
    const usage = usageFrom(await run(container, ['/bin/sh', '-c', USAGE], { ms: EXEC_MS }).then((ran) => ran.stdout, () => ''));

    await must(container, 'packing the log', ['/bin/sh', '-c', `gzip -c ${TASK}/log > ${TASK}/log.gz 2>/dev/null || : > ${TASK}/log.gz
if [ -n "$(find ${ARTIFACTS_PATH} -mindepth 1 -print -quit 2>/dev/null)" ]; then tar -czf ${TASK}/artifacts.tar.gz -C ${ARTIFACTS_PATH} .; fi`], { ms: EXEC_MS });
    await this.store(`${TASK}/log.gz`, taskKey(spec.jobId, index, 'log', rank), { contentType: 'text/plain; charset=utf-8', contentEncoding: 'gzip' });
    // Raw bytes: an output file may be an image or an archive, which a text decode would corrupt.
    const out = spec.output || spec.bundle !== null ? await this.store(OUT_PATH, taskKey(spec.jobId, index, 'output', rank), {}) : null;
    const value = out === null || out.small === null ? undefined : textOf(out.small);
    // A gang's artifacts are its rank 0's; an empty directory stores nothing.
    const packed = rank === 0 ? await this.store(`${TASK}/artifacts.tar.gz`, taskKey(spec.jobId, index, 'artifacts'), { contentType: 'application/gzip' }) : null;
    // A pushed task's runner says whether its out file is the body's envelope or its command's answer.
    const said = spec.bundle === null ? '' : (await run(container, ['head', '-c', '256', ANSWER_PATH], { ms: EXEC_MS }).then((ran) => ran.stdout.trim(), () => ''));
    const [kind = '', error] = said.split('\n');
    const answer = kind === 'value' || kind === 'command' ? kind : undefined;
    const outcome: Outcome = {
      index, kind: 'exited', reason, exitCode, seconds, vessel: spec.name, attempt, tail: tail.stdout, output: out !== null, value, answer, ...packed === null ? {} : { artifacts: true }, ...error === undefined ? {} : { error }, ...usage,
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
      await copyInto(this.env.ARTIFACTS, cache.key, stored, stored.size <= INLINE_BYTES ? await stored.arrayBuffer() : null, { expires: String(cache.expires), answer: answer ?? '' });
    } catch (cause) {
      console.error(JSON.stringify({ output, cache: cache.key, error: said(cause) }));
    }
  }

  /** The values the task started with, replaced in its log before any of it is read. The deployment's secrets are not
   *  read again: one set anew or deleted meanwhile would leave the value the task had unmasked. */
  private async mask(names: readonly string[] | undefined): Promise<void> {
    if (names === undefined || names.length === 0) return;
    await must(this.container(), 'masking the secrets', ['node', '-e', MASK, `${TASK}/log`, MASK_VALUES], { ms: EXEC_MS });
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
