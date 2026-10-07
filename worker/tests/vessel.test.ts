import { describe, expect, test } from 'bun:test';
import type { Outcome } from '../../src/protocol';
import { KEEP_MASK, MASK, MASK_VALUES, STOPPED, USAGE } from '../src/container';
import type { Claim } from '../src/job';
import { GANG_DOWN, GANG_UP, RELAY_HEADER } from '../src/relay';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { bucket, container, namespace, state, world } from './harness';

const spec: VesselSpec = {
  jobId: 'job', name: 'v1', snapshot: 'snapshot', instance: 'standard-4', vcpus: 4, workdir: '/home/ci/work', commit: null,
  tmpfs: [], files: {}, bundle: null, output: false, timeout: 600,
};

/** One task through a vessel whose waits the platform loses `lost` times before the task's exit is read, whose cgroup
 *  reads `usage`, and whose output file holds `out` when the job keeps outputs. */
async function run(lost: number, usage: { readonly exitCode: number; readonly stdout: string } | Error = { exitCode: 0, stdout: '' }, out?: string, stopping = '', launched?: number) {
  const completed: Outcome[] = [];
  const failed: string[] = [];
  let claimed = false;
  let waits = 0;
  const stored = state(container((argv) => {
    if (argv[2] === USAGE) return usage;

    if (argv[2] === STOPPED) return { exitCode: 0, stdout: stopping };

    if (argv[0] === 'stat') return argv[3] === '/armada/task/out' && out === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: String(argv[3] === '/armada/task/out' ? new TextEncoder().encode(out).byteLength : 0) };

    if (argv[0] === 'cat') return { exitCode: 0, stdout: argv[1] === '/armada/task/out' ? out ?? '' : '' };

    if (argv[3] !== 'wait') return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    waits += 1;

    return waits <= lost ? new Error('Network connection lost.') : { exitCode: 0, stdout: '0\n' };
  }));
  const job = {
    booted: async () => undefined,
    waiting: async () => undefined,
    claim: async () => {
      if (claimed) return null;
      claimed = true;

      return { index: 0, attempt: 1, argv: ['true'], env: {}, secrets: [], duplicate: false };
    },
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
    claimed = true;
    await stored.ctx.storage.put({ state: 'working', current: { claim: { index: 0, attempt: 1, argv: ['true'], secrets: [], duplicate: false }, startedAt: Date.now() - launched } });
  }

  for (let alarm = 0; alarm < 4; alarm += 1) await vessel.alarm();

  return { exits: completed.map((outcome) => outcome.exitCode), failed, completed, claimed, stored: artifacts.objects };
}

describe('a vessel waiting on its task', () => {
  test('waits again where the platform lost a wait, and counts the container lost after three in a row', async () => {
    expect(await run(2)).toMatchObject({ exits: [0], failed: [] });
    expect(await run(3)).toMatchObject({ exits: [], failed: ['the wait failed to run (the container ended unseen by this object; this object up since before the task): Network connection lost.'] });
  });

  test('says, when it loses the container, whether its object was restarted under the task', async () => {
    expect((await run(3, undefined, undefined, '', 60_000)).failed).toEqual(['the wait failed to run (the container ended unseen by this object; this object restarted 60 s into the task): Network connection lost.']);
  });
});

describe('a container the platform is stopping', () => {
  test('takes no task: its vessel fails before claiming one, so the job replaces it', async () => {
    expect(await run(0, undefined, undefined, '2026-10-07T18:21:00Z\n'))
      .toMatchObject({ exits: [], claimed: false, failed: ['the platform asked the container to stop at 2026-10-07T18:21:00Z'] });
  });
});

describe('a finished task', () => {
  test('reports its cgroup\'s peak memory and CPU seconds, and lands without them when they cannot be read', async () => {
    const [measured] = (await run(0, { exitCode: 0, stdout: '734003200\n2500000\n' })).completed;
    const [lost] = (await run(0, new Error('Network connection lost.'))).completed;

    expect([measured, lost].map((outcome) => outcome === undefined ? null : [outcome.exitCode, outcome.peakMemory, outcome.cpuSeconds])).toEqual([[0, 734003200, 2.5], [0, undefined, undefined]]);
  });
});

describe('a task\'s output', () => {
  test('rides in its outcome as text up to 32 KiB, and beyond that streams into R2 whole', async () => {
    const small = await run(0, undefined, '{"n": 1}');
    const large = await run(0, undefined, 'x'.repeat(32 * 1024 + 1));

    expect([small.completed[0]?.value, large.completed[0]?.output, large.completed[0]?.value, large.stored.get('jobs/job/tasks/0/output')?.length])
      .toEqual(['{"n": 1}', true, undefined, 32 * 1024 + 1]);
  });
});

describe('a task that names secrets', () => {
  test('has the values it started with masked in its log before its tail is read or the log is stored, the deployment\'s secrets unread', async () => {
    const seen: { readonly argv: readonly string[]; readonly env: unknown }[] = [];
    let claimed = false;
    const stored = state(container((argv, options) => {
      seen.push({ argv, env: options?.env });

      if (argv[3] === 'wait') return { exitCode: 0, stdout: '0\n' };

      return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    }));
    const job = {
      booted: async () => undefined,
      waiting: async () => undefined,
      claim: async () => {
        if (claimed) return null;
        claimed = true;

        return { index: 0, attempt: 1, argv: ['true'], env: { API_KEY: 'sk-launched' }, secrets: ['API_KEY'], duplicate: false };
      },
      still: async () => true,
      accept: async () => true,
      complete: async () => undefined,
      retired: async () => undefined,
      vesselFailed: async () => undefined,
    };
    // Set anew while the task runs: the mask must not read it.
    let read = 0;
    const secrets = { values: async (names: readonly string[]) => { read += 1; return Object.fromEntries(names.map((name) => [name, 'sk-rotated'])); } };
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

  test('a green answer its claim says to cache is written there before its outcome is reported', async () => {
    let claimed = false;
    let cachedAtReport: string | undefined;
    const artifacts = bucket();
    const stored = state(container((argv) => {
      if (argv[3] === 'wait') return { exitCode: 0, stdout: '0\n' };

      if (argv[0] === 'stat') return { exitCode: 0, stdout: argv[1] === '/armada/task/out' ? '21' : '0' };

      if (argv[0] === 'cat') return { exitCode: 0, stdout: argv[1] === '/armada/task/out' ? '{"ok":true,"value":4}' : '' };

      return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    }));
    const job = {
      booted: async () => undefined,
      waiting: async () => undefined,
      claim: async () => {
        if (claimed) return null;
        claimed = true;

        return { index: 0, attempt: 1, argv: ['true'], env: {}, secrets: [], cache: { key: 'cache/square-2', expires: 1234 }, duplicate: false };
      },
      still: async () => true,
      accept: async () => true,
      complete: async () => { cachedAtReport = artifacts.objects.get('cache/square-2'); },
      retired: async () => undefined,
      vesselFailed: async () => undefined,
    };
    const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job), ARTIFACTS: artifacts }));

    await vessel.begin({ ...spec, output: true });

    for (let alarm = 0; alarm < 4; alarm += 1) await vessel.alarm();

    expect({ cachedAtReport, expires: artifacts.kept.get('cache/square-2')?.customMetadata['expires'] }).toEqual({ cachedAtReport: '{"ok":true,"value":4}', expires: '1234' });
  });
});

describe('a gang rank', () => {
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
      booted: async () => undefined, waiting: async () => undefined, claim: async () => claims.shift() ?? null, still: async () => true,
      accept: async () => true, complete: async () => undefined, retired: async () => undefined, vesselFailed: async () => undefined,
    };
    const vessel = new ArmadaVessel(stored.ctx, world({ JOB: namespace(() => job) }));

    await vessel.begin(spec);
    // The first alarm ends waiting for the gang; the next runs both tasks.
    await vessel.alarm();
    await vessel.alarm();
    const steps = ran.filter((argv) => argv[2] === GANG_UP || argv[2] === GANG_DOWN || argv[3] === 'launch' || argv[4] === '/armada/relay.py')
      .map((argv) => argv[2] === GANG_UP ? ['up', ...argv.slice(3)] : argv[2] === GANG_DOWN ? ['down'] : argv[3] === 'launch' ? ['launch'] : ['relay written']);

    expect(steps).toEqual([['relay written'], ['up', 'gang', '1', '2', 'https://armada.example', 'job', 't'.repeat(48), 'v2', 'v1'], ['launch'], ['down'], ['launch']]);
  });

  test('takes a relay only with its gang\'s token, and only to a port', async () => {
    const stored = state(container(() => ({ exitCode: 0, stdout: '' })));
    const vessel = new ArmadaVessel(stored.ctx, world({}));
    const relay = async (token: string, port: string) => (await vessel.fetch(new Request(`https://armada.example/relay/job/v1?port=${port}`, { headers: { [RELAY_HEADER]: token } }))).status;
    const none = await relay('t'.repeat(48), '8476');

    await stored.ctx.storage.put('current', { claim: { index: 0, attempt: 1, argv: ['true'], duplicate: false, gang: { rank: 0, job: 'job', vessels: ['v1', 'v2'], origin: '', token: 't'.repeat(48) } }, startedAt: 0 });

    expect([none, await relay('u'.repeat(48), '8476'), await relay('t'.repeat(48), '0')]).toEqual([403, 403, 400]);
  });
});
