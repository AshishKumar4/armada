import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, type JobSpec } from '../../src/protocol';
import { CPU_INFO } from '../src/container';
import { ArmadaFleet } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import { ArmadaVessel } from '../src/vessel';
import { container, namespace, readyRegistry, state, world, type Answer, type Stored } from './harness';

afterEach(() => { setSystemTime(); });

/** What a live container's exec says: a wait exits 0, the readiness probe is ready, and a `stat` or `head` finds
 *  nothing. */
function answered(argv: readonly string[]) {
  const exitCode = argv[0] === 'stat' || argv[0] === 'head' ? 1 : 0;

  if (argv[3] === 'wait') return { exitCode, stdout: '0\n' };

  return { exitCode, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
}

/** Real jobs, vessels, and fleet; only the container and the RPC transport are fake. A transport can lose the
 *  reply after a claim was committed, just as a Durable Object reset can cut the caller off at that boundary. */
async function running({
  count = 3, pool = 2, hedge = 0, retries, answer,
  loseClaim = false,
}: {
  readonly count?: number;
  readonly pool?: number;
  readonly hedge?: number;
  readonly retries?: JobSpec['retries'];
  readonly answer?: (name: string) => Answer;
  readonly loseClaim?: boolean;
} = {}) {
  const claimed = Promise.withResolvers<void>();
  let dropped = false;
  const vessels = new Map<string, { vessel: ArmadaVessel; readonly stored: Stored }>();
  const launches: string[] = [];
  const stored = state();

  const env = world({
    ENVIRONMENTS: readyRegistry(),
    FLEET: namespace(() => fleet),
    JOB: namespace(() => ({
      booted: open.booted.bind(open),
      moved: open.moved.bind(open),
      claim: async (name: string, slot: number) => {
        const claim = await open.claim(name, slot);

        if (loseClaim && name === 'v1' && !dropped && claim !== null && !('waitMs' in claim)) {
          dropped = true;
          claimed.resolve();

          return await new Promise<never>(() => undefined);
        }

        return claim;
      },
      still: open.still.bind(open),
      started: open.started.bind(open),
      stopped: open.stopped.bind(open),
      accept: open.accept.bind(open),
      complete: open.complete.bind(open),
      retired: open.retired.bind(open),
      vesselFailed: open.vesselFailed.bind(open),
    })),
    VESSEL: namespace((holder) => {
      let held = vessels.get(holder);

      if (held === undefined) {
        const name = holder.slice(holder.lastIndexOf('/') + 1);
        const respond = answer?.(name) ?? answered;

        const machine = container((argv, options) => {
          if (argv[3] === 'launch') launches.push(name);

          return respond(argv, options);
        });

        const kept = state(machine);

        held = { vessel: new ArmadaVessel(kept.ctx, env), stored: kept };
        vessels.set(holder, held);
      }

      return held.vessel;
    }),
  });

  const fleet = new ArmadaFleet(state().ctx, env);
  const open = new ArmadaJob(stored.ctx, env);

  await open.create('stranded', v.parse(JobSpecSchema, {
    recipe: {}, items: Array.from({ length: count }, (_, index) => ({ item: { name: `task-${String(index)}`, weight: count - index }, argv: ['true'] })),
    run: { kind: 'command' }, mode: 'fast', pool, hedge, timeout: 600, deadline: 1800, retries,
  }));
  await open.alarm();

  const vessel = (name: string) => {
    const held = vessels.get(`stranded/${name}`);

    if (held === undefined) throw new Error(`no vessel ${name}`);

    return held;
  };

  const restart = (name: string) => {
    const held = vessel(name);

    held.vessel = new ArmadaVessel(held.stored.ctx, env);

    return held.vessel;
  };

  return { open, stored, fleet, vessels, launches, claimed: claimed.promise, vessel, restart };
}

describe('a task whose vessel loses its claim reply (#45)', () => {
  test('is recovered after the other vessels drain the queue and retire, without idle replacement churn', async () => {
    const start = Date.now();

    setSystemTime(start);
    const run = await running({ loseClaim: true });

    // The job has assigned task 0, but the original vessel object never receives the answer or persists a Current.
    await Promise.race([run.vessel('v1').vessel.alarm(), run.claimed]);
    expect(await run.open.taskStatus(0)).toMatchObject({ status: { state: 'running', attempt: 1 } });
    expect(await run.vessel('v1').stored.ctx.storage.get('slot:0')).toBeUndefined();

    // Every other task runs, and the surviving vessel retires. The reset object resumes its real worker alarm.
    await run.vessel('v2').vessel.alarm();
    expect((await run.open.events(0)).events).toHaveLength(2);
    await run.restart('v1').alarm();

    // Drive the real watchdog and replacement workers up to the job deadline. On the deployed worker, every new
    // vessel retires empty while task 0 remains assigned to done v1; the deadline then emits attempt 0 / no vessel.
    for (let tick = 1; tick <= 120 && !(await run.open.events(0)).done; tick += 1) {
      setSystemTime(start + tick * 15_000);
      await run.open.alarm();

      for (const held of run.vessels.values()) await held.vessel.alarm();
    }

    expect({
      tasks: (await run.open.status())?.tasks,
      events: (await run.open.events(0)).events.map(({ outcome }) => [outcome.index, outcome.kind, outcome.attempt]),
    }).toEqual({
      tasks: { total: 3, queued: 0, running: 0, exited: 3, red: 0, failed: 0 },
      events: [[1, 'exited', 1], [2, 'exited', 1], [0, 'exited', 2]],
    });
    expect(run.vessels.size).toBeLessThanOrEqual(3);
  });

  test('does not silently allocate a second task to the same slot when the reset object asks again', async () => {
    const run = await running({ loseClaim: true });

    await Promise.race([run.vessel('v1').vessel.alarm(), run.claimed]);
    await run.restart('v1').alarm();

    // The old slot's ownership is ambiguous. Its container must be stopped and its tasks recovered, not reused.
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v1')?.state).toBe('failed');
    expect(run.launches).not.toContain('v1');
    expect(await run.open.taskStatus(0)).toMatchObject({ status: { state: 'queued', attempt: 1, running: [] } });
  });

  test('releases a held green when the lost claim belonged to its other copy, without losing the answered copy', async () => {
    const run = await running({ loseClaim: true, count: 1, hedge: 1 });

    await Promise.race([run.vessel('v1').vessel.alarm(), run.claimed]);
    await run.vessel('v2').vessel.alarm();
    expect((await run.open.events(0)).events).toHaveLength(0);
    // v2 has answered and may retire; only the copy whose reply was lost is unfinished.
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v2')?.state).toBe('done');
    await run.restart('v1').alarm();

    expect(await run.open.events(0)).toMatchObject({
      done: true, events: [{ outcome: { index: 0, kind: 'exited', vessel: 'v2', attempt: 1 } }],
    });
  });

  test('also recovers a reset after launch but before Current was persisted, without replaying the ambiguous launch', async () => {
    const launched = Promise.withResolvers<void>();
    let dropped = false;

    const run = await running({
      answer: (name) => async (argv) => {
        if (name === 'v1' && argv[3] === 'launch' && !dropped) {
          dropped = true;
          launched.resolve();

          return await new Promise<never>(() => undefined);
        }

        return answered(argv);
      },
    });

    await Promise.race([run.vessel('v1').vessel.alarm(), launched.promise]);
    expect(await run.vessel('v1').stored.ctx.storage.get('slot:0')).toBeUndefined();
    await run.restart('v1').alarm();
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v1')?.state).toBe('failed');
    expect(run.launches.filter((name) => name === 'v1')).toHaveLength(1);
    expect(await run.open.taskStatus(0)).toMatchObject({ status: { state: 'queued', attempt: 1, running: [] } });
  });

  test('repairs a persisted orphan left on a retired vessel by an earlier worker', async () => {
    const run = await running({ count: 1, pool: 1, loseClaim: true });

    await Promise.race([run.vessel('v1').vessel.alarm(), run.claimed]);
    // Snapshot of the old worker's real retirement: its container is gone, but its task still says running.
    run.stored.ctx.storage.sql.exec(`UPDATE vessels SET state = 'done' WHERE name = 'v1'`);
    run.stored.ctx.storage.sql.exec(`DELETE FROM runs WHERE vessel = 'v1'`);
    await run.open.alarm();
    await run.vessel('v2').vessel.alarm();

    expect(await run.open.events(0)).toMatchObject({
      done: true, events: [{ outcome: { index: 0, kind: 'exited', attempt: 2 } }],
    });
  });
});

describe('a task whose vessel is actually lost or silent (#45 controls)', () => {
  test('requeues an unacknowledged running claim when its worker really goes silent', async () => {
    const start = Date.now();

    setSystemTime(start);
    const run = await running({ count: 2, loseClaim: true });

    await Promise.race([run.vessel('v1').vessel.alarm(), run.claimed]);
    await run.vessel('v2').vessel.alarm();
    setSystemTime(start + 4 * 60_000 + 1);
    await run.open.alarm();
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v1')).toMatchObject({
      state: 'failed', error: 'not heard from for 240 s while working',
    });
    await run.vessel('v3').vessel.alarm();

    expect(await run.open.events(0)).toMatchObject({
      done: true, events: [{ outcome: { index: 1, kind: 'exited' } }, { outcome: { index: 0, kind: 'exited', attempt: 2 } }],
    });
  });

  test('requeues a running loss after its peers retire, then replaces a silent booting replacement', async () => {
    const start = Date.now();
    const waiting = Promise.withResolvers<void>();
    const lost = Promise.withResolvers<void>();
    const booting = Promise.withResolvers<void>();

    setSystemTime(start);

    const run = await running({
      count: 2,
      answer: (name) => async (argv) => {
        if (name === 'v1' && argv[3] === 'wait') {
          waiting.resolve();
          await lost.promise;

          throw new Error('Network connection lost.');
        }

        if (name === 'v3' && argv[2] === CPU_INFO) {
          booting.resolve();

          return await new Promise<never>(() => undefined);
        }

        return answered(argv);
      },
    });

    const losing = run.vessel('v1').vessel.alarm();

    await Promise.race([losing, waiting.promise]);
    await run.vessel('v2').vessel.alarm();
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v2')?.state).toBe('done');
    lost.resolve();
    await losing;
    expect(await run.open.taskStatus(0)).toMatchObject({ status: { state: 'queued', attempt: 1 } });
    await Promise.race([run.vessel('v3').vessel.alarm(), booting.promise]);

    for (let tick = 1; tick <= 32; tick += 1) {
      setSystemTime(start + tick * 15_000);
      await run.open.alarm();
    }

    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v3')?.state).toBe('booting');
    setSystemTime(start + 8 * 60_000 + 1);
    await run.open.alarm();
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v3')).toMatchObject({
      state: 'failed', error: 'not heard from for 480 s while booting',
    });
    await run.vessel('v4').vessel.alarm();

    expect(await run.open.events(0)).toMatchObject({
      done: true, events: [{ outcome: { index: 1, kind: 'exited' } }, { outcome: { index: 0, kind: 'exited', attempt: 2 } }],
    });
  });

  test('keeps a backoff task recoverable when its last worker disappears after all peers retire', async () => {
    const start = Date.now();
    const waiting = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();

    setSystemTime(start);

    const run = await running({
      count: 2, retries: { attempts: 2, backoffSeconds: 300, exitCodes: [75], errors: [] },
      answer: (name) => async (argv) => {
        if (name === 'v1' && argv[3] === 'wait') {
          waiting.resolve();
          await finish.promise;

          return { exitCode: 0, stdout: '75\n' };
        }

        return answered(argv);
      },
    });

    const failing = run.vessel('v1').vessel.alarm();

    await Promise.race([failing, waiting.promise]);
    await run.vessel('v2').vessel.alarm();
    finish.resolve();
    await failing;
    expect((await run.open.status())?.tasks).toMatchObject({ queued: 1, exited: 1 });

    // No more v1 alarms: the job's own watchdog must recover its last lane while not_before is still in the future.
    setSystemTime(start + 4 * 60_000 + 1);
    await run.open.alarm();
    await run.vessel('v3').vessel.alarm();
    expect((await run.open.status())?.tasks.queued).toBe(1);
    setSystemTime(start + 300_001);
    await run.vessel('v3').vessel.alarm();

    expect(await run.open.events(0)).toMatchObject({
      done: true, events: [{ outcome: { index: 1, kind: 'exited' } }, { outcome: { index: 0, kind: 'exited', attempt: 2 } }],
    });
  });
});

describe('a task whose container ended before its launch', () => {
  test('is queued again and runs to its answer on another vessel', async () => {
    const start = Date.now();

    setSystemTime(start);

    // v1's container passes its stop check and is gone by the task's launch, as the platform's loss of a container
    // between two execs leaves it.
    const run = await running({
      count: 2,
      answer: (name) => (argv) => name === 'v1' && argv[3] === 'launch' ? new Error('exec() cannot be called on a container that is not running.') : answered(argv),
    });

    await run.vessel('v1').vessel.alarm();
    expect((await run.open.status())?.vessels.find(({ name }) => name === 'v1')?.state).toBe('failed');
    expect(await run.open.taskStatus(0)).toMatchObject({ status: { state: 'queued', attempt: 1 } });

    for (let tick = 1; tick <= 40 && !(await run.open.events(0)).done; tick += 1) {
      setSystemTime(start + tick * 15_000);
      await run.open.alarm();

      for (const held of run.vessels.values()) await held.vessel.alarm();
    }

    expect({
      launches: run.launches.filter((name) => name === 'v1'),
      events: (await run.open.events(0)).events.map(({ outcome }) => [outcome.index, outcome.kind, outcome.attempt]).sort((a, b) => Number(a[0]) - Number(b[0])),
    }).toEqual({ launches: ['v1'], events: [[0, 'exited', 2], [1, 'exited', 1]] });
  });
});
