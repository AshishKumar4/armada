import { describe, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workdirOf, type Recipe, type Size } from '../../src/protocol';
import { ArmadaEnvironments, ArmadaPreparer, type Generation } from '../src/environments';
import { ArmadaFleet } from '../src/fleet';
import { STATE } from '../src/container';
import { container, namespace, state, world, type Answer } from './harness';

const recipe: Recipe = { base: 'cloudflare/debian-trixie', setup: 'locale-gen\n', install: '', size: 'medium' };

interface Prepared {
  readonly generations: Generation[];
  readonly failures: string[];
}

/** The registry a preparer reports to, keeping what it heard. */
function registry({ generations, failures }: Prepared) {
  return namespace(() => ({
    beat: async () => undefined,
    wanted: async () => true,
    prepared: async (generation: Generation) => { generations.push(generation); },
    preparationFailed: async (_key: string, _since: number, reason: string) => { failures.push(reason); },
  }));
}

/** A preparation of `recipe` at `size` in a container `answer` answers, its alarms run until it ends (or `alarms` run
 *  out). */
async function prepare(answer: Answer, alarms = 40, size: Size = 'medium', stops = true): Promise<Prepared> {
  const generations: Generation[] = [];
  const failures: string[] = [];
  const box = container(answer);
  const destroy = box.destroy.bind(box);
  let snapshotted = false;

  const stored = state(Object.assign(box, {
    snapshotContainer: async () => {
      snapshotted = true;

      return { id: 'snapshot', size: 1 };
    },
    // `stops` false: the container will not stop once it is snapshotted.
    destroy: async () => {
      if (snapshotted && !stops) throw new Error('the container did not stop');
      await destroy();
    },
  }));

  const preparer = new ArmadaPreparer(stored.ctx, world({ ENVIRONMENTS: registry({ generations, failures }) }));

  await preparer.begin('k'.repeat(64), 0, { recipe: { ...recipe, size }, sha: null });

  for (let alarm = 0; alarm < alarms && generations.length + failures.length === 0; alarm += 1) await preparer.alarm();

  return { generations, failures };
}

/** A container where every phase's command exits 0 at once, and the waits for `phase` the platform loses `lost` times.
 *  As on the platform, an exec whose working directory the container lacks finds no command: the work directory exists
 *  once the base phase (the runner's layer) has run. */
function answering(phase: string, lost: number): Answer & { readonly launched: string[]; readonly envs: (Record<string, string> | undefined)[] } {
  const launched: string[] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  let waits = 0;
  let layered = false;

  return Object.assign((argv: readonly string[], options?: ContainerExecOptions) => {
    if (options?.cwd !== undefined && !layered) return new Error('Command `/bin/sh` was not found in the container. Check the path or install the binary.');

    if (argv[3] === 'wait' && (argv[2] ?? '').includes('/phases/base/')) layered = true;

    if (argv[3] === 'launch') {
      launched.push(argv[4] ?? '');
      envs.push(options?.env);
    }

    if (argv[3] === 'wait' && (argv[2] ?? '').includes(`/phases/${phase}/`)) {
      waits += 1;

      if (waits <= lost) return new Error('Network connection lost.');
    }

    if (argv[3] === 'wait') return { exitCode: 0, stdout: '0\n' };

    return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
  }, { launched, envs });
}

describe('a preparation\'s container', () => {
  /** A preparer of `recipe` whose phases all exit 0 at once, under `fleet`, its container's every exec told to
   *  `started`, one that will not stop once it is snapshotted when `stops` is false, and its first `refused` starts
   *  refused because the account is full. */
  function preparing(stops: boolean, fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '4' })), refused = 0) {
    const machine = answering('setup', 0);
    const started: string[] = [];
    const generations: Generation[] = [];
    const failures: string[] = [];
    let snapshotted = false;
    let full = refused;

    // The platform ends a start past the account's limit, and says why only through the container's monitor.
    const box = Object.assign(container((argv, options) => {
      started.push(argv[0] ?? '');

      if (full > 0 && (argv[2] ?? '').includes('echo ready')) {
        full -= 1;

        return new Error('The container has not been started');
      }

      return machine(argv, options);
    }), {
      monitor: async () => {
        if (full > 0) throw new Error('Account resource limit exceeded');
        await new Promise<never>(() => undefined);
      },
    });

    const destroy = box.destroy.bind(box);

    const stored = state(Object.assign(box, {
      snapshotContainer: async () => {
        snapshotted = true;

        return { id: 'snapshot', size: 1 };
      },
      destroy: async () => {
        if (snapshotted && !stops) throw new Error('the container did not stop');
        await destroy();
      },
    }));

    const preparer = new ArmadaPreparer(stored.ctx, world({ FLEET: namespace(() => fleet), ENVIRONMENTS: registry({ generations, failures }) }));

    const run = async () => {
      for (let alarm = 0; alarm < 40 && generations.length === 0; alarm += 1) await preparer.alarm();
    };

    return { fleet, stored, started, generations, failures, preparer, run };
  }

  test('starts once the fleet has room for it, as a job\'s does, and gives it back at its end', async () => {
    const { fleet, stored, started, generations, preparer, run } = preparing(true);

    // A job's container holds the whole fleet.
    await fleet.acquire('job/v1', 4, { deadlineAt: Date.now() + 60_000 });
    await preparer.begin('k'.repeat(64), Date.now(), { recipe, sha: null });
    await preparer.alarm();
    const waiting = { started: started.length, retry: (await stored.ctx.storage.getAlarm() ?? 0) > Date.now() };

    await fleet.release('job/v1');
    await run();

    expect({ waiting, prepared: generations.length, held: await fleet.used() }).toEqual({ waiting: { started: 0, retry: true }, prepared: 1, held: 0 });
  });

  test('waits for room when the account is full, as for its fleet, and is prepared once there is', async () => {
    Object.assign(globalThis, { scheduler: { wait: async () => undefined } });
    const { fleet, stored, generations, failures, preparer, run } = preparing(true, undefined, 1);

    await preparer.begin('k'.repeat(64), Date.now(), { recipe, sha: null });
    await preparer.alarm();
    const refused = { held: await fleet.used(), again: (await stored.ctx.storage.getAlarm() ?? 0) > Date.now() };

    await run();

    expect({ refused, failures, prepared: generations.length, held: await fleet.used() }).toEqual({ refused: { held: 0, again: true }, failures: [], prepared: 1, held: 0 });
  });

  test('holds its vCPUs past its end while it will not stop, as a vessel\'s does, apart from the next attempt at its environment', async () => {
    const { fleet, generations, preparer, run } = preparing(false);

    await preparer.begin('k'.repeat(64), Date.now(), { recipe, sha: null });
    await run();
    // The next attempt at the same environment finds the fleet full of the one that will not stop.
    const next = preparing(true, fleet);

    await next.preparer.begin('k'.repeat(64), Date.now() + 1, { recipe, sha: null });
    await next.preparer.alarm();

    expect({ prepared: generations.length, held: await fleet.used(), next: next.started.length }).toEqual({ prepared: 1, held: 4, next: 0 });
  });
});

describe('an environment whose preparation the platform fails', () => {
  /** A registry whose preparations each run on a fresh object, the `n`th answered by `answers[n]`, every attempt's
   *  alarms run until the environment is ready or has failed: how it ended, and how many attempts it took. */
  async function attempted(answers: readonly Answer[]) {
    // Each name its own object, as the platform's are, so an attempt on a name already used finds that one.
    const preparers = new Map<string, ArmadaPreparer>();
    const stored = state();

    const environments: ArmadaEnvironments = new ArmadaEnvironments(stored.ctx, world({
      PREPARER: namespace((name: string) => {
        const box = Object.assign(container(answers[preparers.size] ?? answering('none', 0)), { snapshotContainer: async () => ({ id: 'snapshot', size: 1 }) });

        return preparers.get(name) ?? preparers.set(name, new ArmadaPreparer(state(box).ctx, world({ ENVIRONMENTS: namespace(() => environments) }))).get(name);
      }),
    }));

    const key = 'k'.repeat(64);
    let readiness = await environments.ensure(key, recipe, null);

    for (let alarm = 0; alarm < 200 && readiness.kind === 'preparing'; alarm += 1) {
      await [...preparers.values()].at(-1)?.alarm();
      readiness = await environments.ensure(key, recipe, null);
    }

    return { kind: readiness.kind, reason: readiness.kind === 'failed' ? readiness.reason : '', attempts: preparers.size };
  }

  /** A container whose start the platform ends, as it did with `internal error`. */
  const unstarted: Answer = (argv) => (argv[2] ?? '').includes('echo ready') ? new Error('internal error; reference = abc') : { exitCode: 0, stdout: '' };

  /** A container whose recipe's setup exits 2. */
  const failing = (): Answer => {
    const otherwise = answering('none', 0);

    return (argv, options) => argv[3] === 'wait' && (argv[2] ?? '').includes('/phases/setup/') ? { exitCode: 0, stdout: '2\n' } : otherwise(argv, options);
  };

  test('attempts it again in a fresh container, up to three in all, whatever the clock; a failure of its recipe fails at once', async () => {
    Object.assign(globalThis, { scheduler: { wait: async () => undefined } });
    // A clock that stands still: every attempt begins in one millisecond.
    setSystemTime(new Date(Date.UTC(2026, 9, 13, 12, 0, 0)));
    const once = await attempted([unstarted]);
    const always = await attempted([unstarted, unstarted, unstarted]);
    const recipeFailed = await attempted([failing()]);

    expect({ once, always, recipeFailed: { ...recipeFailed, reason: recipeFailed.reason.split(':')[0] } }).toEqual({
      once: { kind: 'ready', reason: '', attempts: 2 },
      always: {
        kind: 'failed', attempts: 3,
        reason: 'base: the container would not start: the first exec failed to run: internal error; reference = abc (the platform failed all 3 attempts, each in a fresh container)',
      },
      recipeFailed: { kind: 'failed', reason: 'setup', attempts: 1 },
    });
    setSystemTime();
  });
});

describe('preparing an environment', () => {
  test('runs the recipe\'s setup as root with root\'s PATH, where locale-gen and its kin are, and root\'s HOME (#28)', async () => {
    const machine = answering('setup', 0);
    const prepared = await prepare(machine);
    const env = machine.envs[machine.launched.indexOf('setup')];

    expect({ failures: prepared.failures, path: env?.['PATH']?.split(':'), home: env?.['HOME'] })
      .toEqual({ failures: [], path: expect.arrayContaining(['/usr/sbin', '/sbin', '/usr/bin']), home: '/root' });
  });

  test('waits again where the platform lost a wait, and counts the container lost after three in a row', async () => {
    const twice = await prepare(answering('setup', 2));
    const thrice = await prepare(answering('setup', 3));

    expect({ twice: [twice.generations.length, twice.failures], thrice: [thrice.generations.length, thrice.failures] }).toEqual({
      twice: [1, []],
      thrice: [0, ['setup: the wait failed to run: Network connection lost.']],
    });
  });

  test('bounds a phase by its size\'s vCPUs: a base phase of 20 minutes is too long on medium, and not on micro', async () => {
    /** The base phase runs `minutes`, the clock moving 2 minutes a wait; every other command answers at once. */
    const slow = (minutes: number): Answer => {
      const quick = answering('setup', 0);
      let now = Date.now();
      const end = now + minutes * 60_000;

      return (argv, options) => {
        const answered = quick(argv, options);

        if (argv[3] !== 'wait' || !(argv[2] ?? '').includes('/phases/base/')) return answered;
        now += 120_000;
        setSystemTime(new Date(now));

        return { exitCode: 0, stdout: now >= end ? '0\n' : '' };
      };
    };

    try {
      const medium = await prepare(slow(20), 100, 'medium');
      const micro = await prepare(slow(20), 100, 'micro');

      expect({ medium: medium.failures, micro: [micro.generations.length, micro.failures] })
        .toEqual({ medium: ['base: the runner layer ran longer than 12 min'], micro: [1, []] });
    } finally {
      setSystemTime();
    }
  });

  // Failing the phase for it would lose a snapshot already made, with no record of it anywhere.
  test('publishes a snapshot whose container will not stop', async () => {
    const prepared = await prepare(answering('setup', 0), 40, 'medium', false);

    expect({ snapshots: prepared.generations.map((each) => each.snapshot.id), failures: prepared.failures }).toEqual({ snapshots: ['snapshot'], failures: [] });
  });

  // A snapshot that does not start fails the job's vessels instead, which the job says once (worker/tests/job.test.ts).
  test('ends at the snapshot, starting nothing from it', async () => {
    const machine = answering('setup', 0);
    const prepared = await prepare(machine);

    expect({ phases: Object.keys(prepared.generations[0]?.seconds ?? {}), launched: machine.launched }).toEqual({ phases: ['base', 'setup', 'receive', 'install', 'snapshot'], launched: ['base', 'setup'] });
  });
});

/** A container that is this host: every exec runs here. */
function here(): Container {
  const host: Partial<Container> = {};

  Object.assign(host, {
    running: true,
    start: () => undefined,
    destroy: async () => undefined,
    monitor: async () => await new Promise<void>(() => undefined),
    setInactivityTimeout: async () => undefined,
    exec: async (argv: string[], options?: ContainerExecOptions) => {
      const child = Bun.spawn(argv, { cwd: options?.cwd, env: options?.env ?? process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      const sink = child.stdin;

      // An exec that takes no stdin sees it closed, as the platform's does.
      if (options?.stdin !== 'pipe') await sink.end();
      const stdin = options?.stdin === 'pipe' ? new WritableStream<Uint8Array>({ write: async (chunk) => { await sink.write(chunk); }, close: async () => { await sink.end(); } }) : null;

      return { stdin, output: async () => ({ exitCode: await child.exited, stdout: await new Response(child.stdout).arrayBuffer(), stderr: await new Response(child.stderr).arrayBuffer() }) };
    },
  });

  // SAFETY: a preparer calls only these members of its container, each constructed above to run on this host.
  return host as Container;
}

const root = process.getuid?.() === 0 && Bun.spawnSync(['id', 'ci']).exitCode === 0;

if (!root) console.log('preparation.test: a phase delivered twice: skipped: it runs as root beside armada\'s runner layer');

/** A preparer on this host, at `recipe`'s setup phase, with the runner layer's work directory in place and no phase
 *  begun: a phase whose directory exists is taken as already launched. */
async function atSetup(phases: Recipe) {
  const failures: string[] = [];
  const stored = state(here());

  const preparer = new ArmadaPreparer(stored.ctx, world({
    ENVIRONMENTS: namespace(() => ({ beat: async () => undefined, wanted: async () => true, preparationFailed: async (_key: string, _since: number, reason: string) => { failures.push(reason); } })),
  }));

  rmSync(`${STATE}/phases`, { recursive: true, force: true });
  mkdirSync(workdirOf(phases), { recursive: true });
  await stored.ctx.storage.put('preparation', { key: 'k'.repeat(64), since: 0, recipe: phases, sha: null, phase: 'setup', seconds: {}, snapshot: null });

  return { preparer, failures, phase: async () => (await stored.ctx.storage.get<{ phase: string }>('preparation'))?.phase };
}

describe.skipIf(!root)('a preparation phase', () => {
  test('runs once when its alarm is delivered again while it runs', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-prep-'));

    // A setup that holds a lock while it runs, as apt-get holds dpkg's.
    const setup = `mkdir ${scratch}/lock || { echo "held by another setup" >&2; exit 100; }\necho ran >> ${scratch}/runs\nsleep 2\nrmdir ${scratch}/lock\n`;

    try {
      const { preparer, failures, phase } = await atSetup({ ...recipe, setup });
      // Two invocations of the phase's alarm at once: the platform delivers an alarm at least once.
      await Promise.all([preparer.alarm(), preparer.alarm()]);

      expect({ failures, runs: readFileSync(`${scratch}/runs`, 'utf8'), phase: await phase() }).toEqual({ failures: [], runs: 'ran\n', phase: 'receive' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('leaves the user able to write what the recipe\'s setup, as root, put in the user\'s home', async () => {
    try {
      // As uv's installer does: setup writes under $HOME/.local, then install, as the user, writes beside it.
      const { preparer, failures, phase } = await atSetup({ ...recipe, setup: 'mkdir -p "$HOME/.local/share" && touch "$HOME/.local/marker"\n', install: 'mkdir -p "$HOME/.local/share/uv/python"\n' });

      for (let alarm = 0; alarm < 40 && failures.length === 0 && (await phase()) !== 'snapshot'; alarm += 1) await preparer.alarm();

      expect({ failures, made: Bun.spawnSync(['test', '-d', '/home/ci/.local/share/uv/python']).exitCode }).toEqual({ failures: [], made: 0 });
    } finally {
      rmSync('/home/ci/.local', { recursive: true, force: true });
    }
  });
});
