import { describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Recipe, Size } from '../../src/protocol';
import { ArmadaPreparer, type Generation } from '../src/environments';
import { container, namespace, state, world, type Answer } from './harness';

const recipe: Recipe = { base: 'cloudflare/debian-trixie', setup: 'locale-gen\n', install: '', size: 'medium' };

interface Prepared {
  readonly generations: Generation[];
  readonly failures: string[];
}

/** A preparation of `recipe` at `size` in a container `answer` answers, its alarms run until it ends (or `alarms` run
 *  out). */
async function prepare(answer: Answer, alarms = 40, size: Size = 'medium'): Promise<Prepared> {
  const generations: Generation[] = [];
  const failures: string[] = [];
  const stored = state(Object.assign(container(answer), { snapshotContainer: async () => ({ id: 'snapshot', size: 1 }) }));

  const preparer = new ArmadaPreparer(stored.ctx, world({
    ENVIRONMENTS: namespace(() => ({
      prepared: async (generation: Generation) => { generations.push(generation); },
      preparationFailed: async (_key: string, _since: number, reason: string) => { failures.push(reason); },
    })),
  }));

  await preparer.begin('k'.repeat(64), 0, { recipe: { ...recipe, size }, sha: null });

  for (let alarm = 0; alarm < alarms && generations.length + failures.length === 0; alarm += 1) await preparer.alarm();

  return { generations, failures };
}

/** A container where every phase's command exits 0 at once, and the waits for `phase` the platform loses `lost` times.
 *  As on the platform, an exec whose working directory the container lacks finds no command: the work directory exists
 *  once the base phase (the runner's layer) has run. */
function answering(phase: string, lost: number): Answer & { readonly launched: string[]; readonly paths: (string | undefined)[] } {
  const launched: string[] = [];
  const paths: (string | undefined)[] = [];
  let waits = 0;
  let layered = false;

  return Object.assign((argv: readonly string[], options?: ContainerExecOptions) => {
    if (options?.cwd !== undefined && !layered) return new Error('Command `/bin/sh` was not found in the container. Check the path or install the binary.');

    if (argv[3] === 'wait' && (argv[2] ?? '').includes('/phases/base/')) layered = true;

    if (argv[3] === 'launch') {
      launched.push(argv[4] ?? '');
      paths.push(options?.env?.['PATH']);
    }

    if (argv[3] === 'wait' && (argv[2] ?? '').includes(`/phases/${phase}/`)) {
      waits += 1;

      if (waits <= lost) return new Error('Network connection lost.');
    }

    if (argv[3] === 'wait') return { exitCode: 0, stdout: '0\n' };

    return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
  }, { launched, paths });
}

describe('preparing an environment', () => {
  test('runs the recipe\'s setup as root with root\'s PATH, where locale-gen and its kin are', async () => {
    const machine = answering('setup', 0);
    const prepared = await prepare(machine);

    expect({ failures: prepared.failures, path: machine.paths[machine.launched.indexOf('setup')]?.split(':') })
      .toEqual({ failures: [], path: expect.arrayContaining(['/usr/sbin', '/sbin', '/usr/bin']) });
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

describe.skipIf(!root)('a preparation phase', () => {
  test('runs once when its alarm is delivered again while it runs', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-prep-'));
    const failures: string[] = [];
    const stored = state(here());

    const preparer = new ArmadaPreparer(stored.ctx, world({
      ENVIRONMENTS: namespace(() => ({ preparationFailed: async (_key: string, _since: number, reason: string) => { failures.push(reason); } })),
    }));

    // A setup that holds a lock while it runs, as apt-get holds dpkg's.
    const setup = `mkdir ${scratch}/lock || { echo "held by another setup" >&2; exit 100; }\necho ran >> ${scratch}/runs\nsleep 2\nrmdir ${scratch}/lock\n`;

    try {
      await stored.ctx.storage.put('preparation', { key: 'k'.repeat(64), since: 0, recipe: { ...recipe, setup }, sha: null, phase: 'setup', seconds: {}, snapshot: null });
      // Two invocations of the phase's alarm at once: the platform delivers an alarm at least once.
      await Promise.all([preparer.alarm(), preparer.alarm()]);
      const phase = (await stored.ctx.storage.get<{ phase: string }>('preparation'))?.phase;

      expect({ failures, runs: readFileSync(`${scratch}/runs`, 'utf8'), phase }).toEqual({ failures: [], runs: 'ran\n', phase: 'receive' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
