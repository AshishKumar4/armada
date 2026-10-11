import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Outcome } from '../../src/protocol';
import { argvOf, KEEP_MASK, MASK, MASK_VALUES, STOPPED, TASK_GROUP, usageOf } from '../src/container';
import type { Claim, Gang } from '../src/job';
import { GANG_DOWN, GANG_UP, RELAY_HEADER, RELAY_LOG } from '../src/relay';
import { ArmadaVessel, TAIL_BYTES, tailOf, type VesselSpec } from '../src/vessel';
import { runKey } from '../src/env';
import { bucket, container, namespace, state, world } from './harness';


/** A task's artifacts archive: gzip, whose bytes are not text. */
const ARCHIVE = Bun.gzipSync('a kept file');

const spec: VesselSpec = {
  jobId: 'job', name: 'v1', snapshot: 'snapshot', instance: 'standard-4', vcpus: 4, workdir: '/home/ci/work', commit: null,
  tmpfs: [], files: {}, bundle: null, output: false, timeout: 600,
};

/** A job with one task to hand out: the first claim gets `claim`, and each after gets none. */
function once(claim: Claim) {
  const given = { done: false };

  return {
    given,
    next: async () => {
      if (given.done) return null;
      given.done = true;

      return claim;
    },
  };
}

/** How a test's one task meets its vessel: what its cgroup reads, what its output file holds when the job keeps
 *  outputs, when the platform says it stops the container, how long before the object started the task was launched
 *  when the runtime restarted it, whether its artifacts packed, and its claim's gang rank. */
interface Run {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly usage?: { readonly exitCode: number; readonly stdout: string } | Error;
  readonly out?: string;
  readonly stopping?: string;
  readonly launched?: number;
  readonly packed?: boolean;
  readonly gang?: Gang;
  readonly startAllowed?: boolean;
}

/** One task through a vessel whose waits the platform loses `lost` times before the task's exit is read. */
async function run(lost: number, { argv: words = ['true'], env = {}, usage = { exitCode: 0, stdout: '' }, out, stopping = '', launched, packed = false, gang, startAllowed = true }: Run = {}) {
  const completed: Outcome[] = [];
  const failed: string[] = [];
  const execs: (readonly string[])[] = [];
  const envs: (Readonly<Record<string, string>> | undefined)[] = [];
  const piped = new Map<string, string>();
  const started: { name: string; index: number; attempt: number; afterLaunch: boolean; stored: boolean }[] = [];
  const task = once({ index: 0, attempt: 1, argv: [...words], env: { ...env }, secrets: [], duplicate: false, gang });
  let waits = 0;

  const stored = state(container((argv, options) => {
    execs.push(argv);
    envs.push(options?.env);

    if (argv[2] === usageOf(TASK_GROUP)) return usage;

    if (argv[2] === STOPPED) return { exitCode: 0, stdout: stopping };

    if (argv[0] === 'stat' && argv[3] === '/armada/task/artifacts.tar.gz') return packed ? { exitCode: 0, stdout: String(ARCHIVE.byteLength) } : { exitCode: 1, stdout: '' };

    if (argv[0] === 'stat' && argv[3] === '/armada/task/out') return out === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: String(new TextEncoder().encode(out).byteLength) };

    if (argv[0] === 'stat') return { exitCode: 0, stdout: '0' };

    if (argv[0] === 'cat' && argv[1] === '/armada/task/artifacts.tar.gz') return { exitCode: 0, stdout: '', bytes: ARCHIVE };

    if (argv[0] === 'cat') return { exitCode: 0, stdout: argv[1] === '/armada/task/out' ? out ?? '' : '' };

    if (argv[3] !== 'wait') return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    waits += 1;

    return waits <= lost ? new Error('Network connection lost.') : { exitCode: 0, stdout: '0\n' };
  }, (argv, body) => { if (argv[3] === 'pipe-in') piped.set(argv[4] ?? '', body); }));

  const job = {
    booted: async () => undefined,
    waiting: async () => undefined,
    claim: task.next,
    started: async (name: string, index: number, attempt: number) => {
      started.push({ name, index, attempt, afterLaunch: execs.some((argv) => argv[3] === 'launch'), stored: (await stored.ctx.storage.get('slot:0')) !== undefined });

      return startAllowed;
    },
    stopped: async () => undefined,
    still: async () => true,
    accept: async () => true,
    complete: async (_name: string, outcome: Outcome) => { completed.push(outcome); },
    retired: async () => undefined,
    vesselFailed: async (_name: string, error: string) => { failed.push(error); },
  };

  const artifacts = bucket();
  const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: artifacts }));

  await vessel.begin({ ...spec, output: out !== undefined });

  // An object the runtime restarted under its task finds that task, launched `launched` ms before it started, in
  // storage.
  if (launched !== undefined) {
    task.given.done = true;
    await stored.ctx.storage.put({ state: 'working', 'slot:0': { claim: { index: 0, attempt: 1, argv: ['true'], secrets: [], duplicate: false }, startedAt: Date.now() - launched } });
  }

  for (let alarm = 0; alarm < 4; alarm += 1) await vessel.alarm();

  return { exits: completed.map((outcome) => outcome.exitCode), failed, completed, claimed: task.given.done, stored: artifacts.objects, execs, envs, piped, started };
}

describe('a task\'s argv and environment', () => {
  test('reach its launch in a file, not in the exec, which the runtime fails past 128 KiB a string, and keep every byte', async () => {
    const argv = ['sh', '-c', `it's "q" $HOME \`id\` \\ \n`, '', 'é', 'a'.repeat(200_000)];
    const env = { ARMADA_ITEM: JSON.stringify({ payload: 'b'.repeat(120_000), quote: "it's" }), PLAIN: 'x y' };
    const { exits, execs, envs, piped } = await run(0, { argv, env });
    const at = execs.findIndex((exec) => exec[3] === 'launch');
    const launch = execs[at] ?? [];
    const scratch = mkdtempSync(join(tmpdir(), 'armada-argv-'));

    try {
      const path = join(scratch, 'argv');

      writeFileSync(path, piped.get(argvOf(0)) ?? '');
      const read = Bun.spawnSync(['/bin/sh', '-c', `. ${path}; printf '%s\\0' "$@" "$ARMADA_ITEM" "$PLAIN"`]).stdout.toString().split('\0').slice(0, -1);

      expect({ exits, words: launch.slice(3), env: envs[at], sourced: (launch[2] ?? '').startsWith(`. ${argvOf(0)}\nrm -f ${argvOf(0)}\n`),
        read: read.length === argv.length + 2 && read.every((word, index) => word === [...argv, env.ARMADA_ITEM, env.PLAIN][index]) })
        .toEqual({ exits: [0], words: ['launch'], env: {}, sourced: true, read: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('a vessel waiting on its task', () => {
  test('waits again where the platform lost a wait, and counts the container lost after three in a row', async () => {
    expect(await run(2)).toMatchObject({ exits: [0], failed: [] });
    expect(await run(3)).toMatchObject({ exits: [], failed: [expect.any(String)] });
  });
});

describe('a container the platform is stopping', () => {
  test('takes no task: its vessel fails before claiming one, so the job replaces it', async () => {
    expect(await run(0, { stopping: '2026-10-07T18:21:00Z\n' }))
      .toMatchObject({ exits: [], claimed: false, failed: ['the platform asked the container to stop at 2026-10-07T18:21:00Z'] });
  });
});

describe('a finished task', () => {
  test('reports its cgroup\'s peak memory and CPU seconds, and lands without them when they cannot be read', async () => {
    const [measured] = (await run(0, { usage: { exitCode: 0, stdout: '734003200\n2500000\n' } })).completed;
    const [lost] = (await run(0, { usage: new Error('Network connection lost.') })).completed;

    expect([measured, lost].map((outcome) => outcome === undefined ? null : [outcome.exitCode, outcome.peakMemory, outcome.cpuSeconds])).toEqual([[0, 734003200, 2.5], [0, undefined, undefined]]);
  });
});

describe('a task\'s artifacts', () => {
  test('are stored as a tar.gz when its directory kept a file, and named on its outcome; an empty one stores none', async () => {
    const kept = await run(0, { packed: true });
    const empty = await run(0);

    const key = runKey(spec.jobId, 0, { vessel: spec.name, attempt: 1 }, 'artifacts');

    expect([kept.completed[0]?.artifacts, kept.stored.get(key), empty.completed[0]?.artifacts, empty.stored.has(key)])
      .toEqual([true, ARCHIVE, undefined, false]);
  });

  test('of a gang are its rank 0\'s only: rank 1 stores nothing and says none', async () => {
    const second = await run(0, { packed: true, gang: { rank: 1, job: 'job', vessels: ['v1', 'v2'], origin: 'https://origin', token: 't' } });

    expect([second.completed[0]?.artifacts, second.stored.has(runKey(spec.jobId, 0, { vessel: spec.name, attempt: 1 }, 'artifacts'))]).toEqual([undefined, false]);
  });
});

describe('a task\'s output', () => {
  test('rides in its outcome as text up to 32 KiB, and beyond that streams into R2 whole', async () => {
    const small = await run(0, { out: '{"n": 1}' });
    const large = await run(0, { out: 'x'.repeat(32 * 1024 + 1) });

    expect([small.completed[0]?.value, large.completed[0]?.output, large.completed[0]?.value, large.stored.get(runKey(spec.jobId, 0, { vessel: spec.name, attempt: 1 }, 'output'))?.length])
      .toEqual(['{"n": 1}', true, undefined, 32 * 1024 + 1]);
  });
});

describe('a task that names secrets', () => {
  test('has the values it started with masked in its log before its tail is read or the log is stored, the deployment\'s secrets unread', async () => {
    const seen: { readonly argv: readonly string[]; readonly env: unknown }[] = [];

    const stored = state(container((argv, options) => {
      seen.push({ argv, env: options?.env });

      if (argv[3] === 'wait') return { exitCode: 0, stdout: '0\n' };

      return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    }));

    const job = {
      booted: async () => undefined,
      waiting: async () => undefined,
      claim: once({ index: 0, attempt: 1, argv: ['true'], env: { API_KEY: 'sk-launched' }, secrets: ['API_KEY'], duplicate: false }).next,
      still: async () => true,
      accept: async () => true,
      complete: async () => undefined,
      retired: async () => undefined,
      vesselFailed: async () => undefined,
    };

    // Set anew while the task runs: the mask must not read it.
    let read = 0;

    const secrets = { values: async (names: readonly string[]) => { read += 1;

 return Object.fromEntries(names.map((name) => [name, 'sk-rotated'])); } };

    const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), SECRETS: namespace(() => secrets), ARTIFACTS: bucket() }));

    await vessel.begin(spec);

    for (let alarm = 0; alarm < 4; alarm += 1) await vessel.alarm();
    const kept = seen.findIndex((exec) => exec.argv[0] === 'node' && exec.argv[2] === KEEP_MASK);
    const launched = seen.findIndex((exec) => exec.argv[3] === 'launch');
    const masked = seen.findIndex((exec) => exec.argv[0] === 'node' && exec.argv[2] === MASK);
    const tailed = seen.findIndex((exec) => /^(tail|gzip) /u.test(exec.argv[2] ?? ''));

    expect({ order: kept !== -1 && kept < launched && launched < masked && masked < tailed, keep: [seen[kept]?.argv[3], seen[kept]?.env], mask: seen[masked]?.argv.slice(3), read })
      .toEqual({ order: true, keep: [MASK_VALUES, { API_KEY: 'sk-launched', ARMADA_MASK: 'API_KEY' }], mask: ['/armada/task/log', MASK_VALUES], read: 0 });
  });
});

describe('a gang rank', () => {
  test('acknowledges its exact attempt only after the launch and current task are stored, and kills a refused late launch', async () => {
    const gang = { rank: 0, job: 'job', vessels: ['v1', 'v2'], origin: 'https://armada.example', token: 't'.repeat(48) };
    const accepted = await run(0, { gang });
    const refused = await run(0, { gang, startAllowed: false });

    expect(accepted.started).toEqual([{ name: 'v1', index: 0, attempt: 1, afterLaunch: true, stored: true }]);
    expect(accepted.exits).toEqual([0]);
    expect(refused.exits).toEqual([]);
    expect(refused.execs.some((argv) => (argv[2] ?? '').includes('cgroup.kill'))).toBe(true);
    expect(refused.failed).toEqual([]);
  });

  test('waits for its gang, joins its network as its rank before it launches, and leaves it before a task of no gang', async () => {
    const ran: string[][] = [];
    const gang = { rank: 1, job: 'job', vessels: ['v2', 'v1'], origin: 'https://armada.example', token: 't'.repeat(48) };

    const claims: (Claim | { readonly waitMs: number } | null)[] = [{ waitMs: 1 }, { index: 0, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false, gang },
      { index: 1, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false }, null];

    const stored = state(container((argv) => {
      ran.push([...argv]);

      return { exitCode: 0, stdout: argv[3] === 'wait' ? '0\n' : '' };
    }));

    const job = {
      booted: async () => undefined, waiting: async () => undefined, claim: async () => claims.shift() ?? null, started: async () => true, still: async () => true,
      accept: async () => true, complete: async () => undefined, retired: async () => undefined, vesselFailed: async () => undefined,
    };

    const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job) }));

    await vessel.begin(spec);
    // The first alarm ends waiting for the gang; the next runs both tasks.
    await vessel.alarm();
    await vessel.alarm();

    const steps = ran.flatMap((argv) => {
      if (argv[2] === GANG_UP) return [['up', ...argv.slice(3)]];

      if (argv[2] === GANG_DOWN) return [['down']];

      if (argv[3] === 'launch') return [['launch']];

      return argv[4] === '/armada/relay.py' ? [['relay written']] : [];
    });

    expect(steps).toEqual([['relay written'], ['up', 'gang', '1', '2', 'https://armada.example', 'job', 't'.repeat(48), 'v2', 'v1'], ['launch'], ['down'], ['launch']]);
  });

  test('keeps its log, the relay\'s appended, when its gang ends without its answer: refused, or stopped while it ran, and says it stopped', async () => {
    const gang = { rank: 1, job: 'job', vessels: ['v2', 'v1'], origin: '', token: 't'.repeat(48) };

    const kept = async (accepted: boolean, exits: boolean) => {
      const completed: Outcome[] = [];
      let relayLogs = 0;
      let stops = 0;

      const stored = state(container((argv) => {
        relayLogs += (argv[2] ?? '').includes(RELAY_LOG) && (argv[2] ?? '').includes('>> /armada/task/log') ? 1 : 0;

        return { exitCode: 0, stdout: argv[3] === 'wait' && exits ? '3\n' : '' };
      }));

      const job = {
        booted: async () => undefined, waiting: async () => undefined, retired: async () => undefined, vesselFailed: async () => undefined,
        claim: once({ index: 0, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false, gang }).next,
        started: async () => true,
        still: async () => false, stopped: async () => { stops += 1; }, accept: async () => accepted,
        complete: async (_name: string, outcome: Outcome) => { completed.push(outcome); },
      };

      const artifacts = bucket();
      const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: artifacts }));

      await vessel.begin(spec);
      await vessel.alarm();

      return { logged: [...artifacts.objects.keys()].filter((key) => key.endsWith('log.gz')), completed: completed.length, relayLogs, stops };
    };

    const log = runKey(spec.jobId, 0, { vessel: spec.name, attempt: 1 }, 'log');

    expect([await kept(false, true), await kept(true, false), await kept(true, true)])
      .toEqual([{ logged: [log], completed: 0, relayLogs: 1, stops: 0 }, { logged: [log], completed: 0, relayLogs: 1, stops: 1 }, { logged: [log], completed: 1, relayLogs: 1, stops: 0 }]);
  });

  test('takes a relay only with its gang\'s token, and only to a port under a link id', async () => {
    const stored = state(container(() => ({ exitCode: 0, stdout: '' })));
    const vessel = new ArmadaVessel(stored.ctx, world({}));

    const relay = async (token: string, query: string) => (await vessel.fetch(new Request(`https://armada.example/relay/job/v1?${query}`,
      { headers: { [RELAY_HEADER]: token, upgrade: 'websocket' } }))).status;

    const link = `id=${'0'.repeat(16)}`;
    const none = await relay('t'.repeat(48), `port=8476&${link}`);

    await stored.ctx.storage.put('slot:0', { claim: { index: 0, attempt: 1, argv: ['true'], duplicate: false, gang: { rank: 0, job: 'job', vessels: ['v1', 'v2'], origin: '', token: 't'.repeat(48) } }, startedAt: 0 });

    expect([none, await relay('u'.repeat(48), `port=8476&${link}`), await relay('t'.repeat(48), `port=0&${link}`), await relay('t'.repeat(48), 'port=8476&id=x')])
      .toEqual([403, 403, 400, 400]);
  });
});

describe('a task\'s log tail', () => {
  test('is read from the log\'s end alone, however long a line it ends in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'armada-tail-'));

    try {
      // 32 MiB on one line, then two short ones.
      writeFileSync(join(dir, 'log'), `${'x'.repeat(32 * 1024 * 1024)}\nsecond\nthird\n`);
      const read = Bun.spawnSync(['/bin/sh', '-c', tailOf(dir)], { stdout: 'pipe' }).stdout;

      expect({ bytes: read.byteLength <= TAIL_BYTES, end: new TextDecoder().decode(read).endsWith('x\nsecond\nthird\n') }).toEqual({ bytes: true, end: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
