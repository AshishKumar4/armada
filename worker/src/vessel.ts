/**
 * ArmadaVessel: one container of a job's pool. It waits for fleet capacity, starts from the job's environment snapshot
 * (taking in the commit, the job's files and its handler once), then pulls tasks from the job until the queue has
 * none left for it: launch one detached, wait on it in short blocking reads, store its output and log in R2 once, and
 * report its outcome. Its loop runs in alarms of about a minute each, so no request holds it, and its state is in
 * storage, so a restarted object takes the same task up again. A task it was told to drop (another vessel's answer
 * landed first, or the job ended) is killed with its whole session.
 */
import { DurableObject } from 'cloudflare:workers';
import { failureTail, type Outcome } from '../../src/protocol';
import {
  ENTRYPOINT, KILL, TASK, WAIT, handlerModule, launchTask, mounts, must, pipeIn, receive, run, startAndAnswer, STATE,
} from './container';
import { packKey, said, taskKey, type Env } from './env';
import type { Claim } from './job';

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
  readonly handler: string | null;
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

export class ArmadaVessel extends DurableObject<Env> {
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

    if (spec.handler !== null) await pipeIn(container, handlerModule(spec.handler), `${STATE}/handler.mjs`);
    await this.ctx.storage.put('state', 'working' satisfies State);
    await this.env.JOB.getByName(spec.jobId).booted(spec.name, bootMs);
  }

  /** Runs the loop for a slice; true while there is more to do, false once the vessel retired. */
  private async work(spec: VesselSpec): Promise<boolean> {
    const container = this.container();
    const job = this.env.JOB.getByName(spec.jobId);
    const until = Date.now() + SLICE_MS;
    let lost = 0;

    while (Date.now() < until) {
      const current = await this.ctx.storage.get<Current>('current');

      if (current === undefined) {
        const claim = await job.claim(spec.name);

        if (claim === null) return await this.retire(spec);
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
        throw new Error('the wait failed to run', { cause: waited.reason });
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
        await this.finish(spec, current, 124);
        continue;
      }

      if (!(await job.still(spec.name, current.claim.index))) {
        await must(container, 'the kill', ['/bin/sh', '-c', KILL], { ms: EXEC_MS });
        await this.ctx.storage.delete('current');
      }
    }

    return true;
  }

  /** The task's answer, if it is the one kept: its log and output into R2, then its outcome to the job. */
  private async finish(spec: VesselSpec, current: Current, exitCode: number): Promise<void> {
    const container = this.container();
    const { index, attempt } = current.claim;
    const job = this.env.JOB.getByName(spec.jobId);

    await this.ctx.storage.delete('current');

    if (!(await job.accept(spec.name, index))) return;
    const seconds = (Date.now() - current.startedAt) / 1000;
    const log = await (await container.exec(['/bin/sh', '-c', `gzip -c ${TASK}/log 2>/dev/null || true`], { signal: AbortSignal.timeout(EXEC_MS) })).output();
    const tail = await run(container, ['/bin/sh', '-c', `tail -n ${String(TAIL_LINES)} ${TASK}/log 2>/dev/null || true`], { ms: EXEC_MS });

    await this.env.ARTIFACTS.put(taskKey(spec.jobId, index, 'log'), log.stdout, { httpMetadata: { contentType: 'text/plain; charset=utf-8', contentEncoding: 'gzip' } });
    let output = false;

    if (spec.output || spec.handler !== null) {
      // Raw bytes: an output file may be an image or an archive, which a text decode would corrupt.
      const out = await (await container.exec(['cat', `${TASK}/out`], { signal: AbortSignal.timeout(EXEC_MS) })).output();

      if (out.exitCode === 0) {
        await this.env.ARTIFACTS.put(taskKey(spec.jobId, index, 'output'), out.stdout);
        output = true;
      }
    }

    const outcome: Outcome = { index, kind: 'exited', exitCode, seconds, vessel: spec.name, attempt, tail: tail.stdout, output };

    await job.complete(spec.name, outcome, seconds * 1000);
  }

  private async retire(spec: VesselSpec): Promise<false> {
    await this.ctx.storage.put('state', 'done' satisfies State);
    await Promise.allSettled([this.container().destroy()]);
    await this.fleet().release(this.holder(spec));
    await this.env.JOB.getByName(spec.jobId).retired(spec.name);

    return false;
  }
}
