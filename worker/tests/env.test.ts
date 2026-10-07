import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, type Outcome } from '../../src/protocol';
import type { Generation, Readiness } from '../src/environments';
import { ArmadaJob } from '../src/job';
import { ArmadaVessel } from '../src/vessel';
import { container, namespace, state, world, type Stored } from './harness';

const SECRET = 'tok-3f9a1c-secret';

const generation: Generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

interface Running {
  readonly job: ArmadaJob;
  readonly stored: Stored;
}

/** A job with two tasks and a credential in its env, its environment ready (or `readiness`), its vessels launched. */
async function running(readiness: Readiness = { kind: 'ready', generation }): Promise<Running> {
  const stored = state();
  const job = new ArmadaJob(stored.ctx, world({
    VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
    ENVIRONMENTS: namespace(() => ({ ensure: async () => readiness })),
  }));

  await job.create('j1', v.parse(JobSpecSchema, { recipe: {}, items: ['a', 'b'], run: { command: ['true'] }, env: { TOKEN: SECRET } }));
  await job.alarm();

  return { job, stored };
}

const exited = (index: number, vessel: string): Outcome => ({ index, kind: 'exited', exitCode: 0, seconds: 1, vessel, attempt: 1, tail: '', output: false });

describe('a job\'s env', () => {
  test('reaches every claim while the job runs', async () => {
    const { job } = await running();

    expect((await job.claim('v1'))?.env['TOKEN']).toBe(SECRET);
  });

  const ends: Record<string, (setup: Running) => Promise<void>> = {
    'every task done': async ({ job }) => {
      for (const vessel of ['v1', 'v2']) {
        const claim = await job.claim(vessel);

        if (claim === null || !(await job.accept(vessel, claim.index))) throw new Error(`${vessel} got no task`);
        await job.complete(vessel, exited(claim.index, vessel), 1000);
      }
    },
    'cancelled by its client': async ({ job }) => {
      await job.claim('v1');
      await job.cancel('cancelled by its client');
    },
    'past its deadline': async ({ job, stored }) => {
      await stored.ctx.storage.put('createdAt', 0);
      await job.alarm();
    },
    'its vessels lost, past their replacements': async ({ job, stored }) => {
      await job.claim('v1');
      await stored.ctx.storage.put('replaced', 8);
      await job.vesselFailed('v1', 'the wait failed to run');
      await job.vesselFailed('v2', 'could not start');
    },
    'its vessels silent, reaped by its watchdog': async ({ job, stored }) => {
      await job.claim('v1');
      await stored.ctx.storage.put('replaced', 8);
      stored.ctx.storage.sql.exec('UPDATE vessels SET beat = 0');
      await job.alarm();
    },
  };

  for (const [end, conclude] of Object.entries(ends)) {
    test(`is gone from the job's storage once it ends: ${end}`, async () => {
      const setup = await running();

      expect(setup.stored.dump()).toContain(SECRET);
      await conclude(setup);
      expect({ phase: (await setup.job.status())?.phase, kept: setup.stored.dump().includes(SECRET) }).toEqual({ phase: 'done', kept: false });
    });
  }

  test('is gone once its environment could not be prepared', async () => {
    const { job, stored } = await running({ kind: 'failed', reason: 'setup exited 1' });

    expect({ phase: (await job.status())?.phase, kept: stored.dump().includes(SECRET) }).toEqual({ phase: 'done', kept: false });
  });

  test('of a job created before it had a key of its own reaches its claims while it runs, and is gone once it ends', async () => {
    const stored = state();
    const job = new ArmadaJob(stored.ctx, world({ VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })) }));
    const { items, env, ...kept } = v.parse(JobSpecSchema, { recipe: {}, items: ['a'], run: { command: ['true'] }, env: { TOKEN: SECRET } });

    await job.create('j1', v.parse(JobSpecSchema, { recipe: {}, items, run: { command: ['true'] } }));
    // The layout an earlier Worker left: the env inside the spec.
    await stored.ctx.storage.put({ spec: { ...kept, env }, phase: 'running', environment: generation, startedAt: 0 });
    stored.ctx.storage.sql.exec(`INSERT INTO vessels (name, state, beat) VALUES ('v1', 'working', ?)`, Date.now());
    const claimed = (await job.claim('v1'))?.env['TOKEN'];

    await job.cancel('cancelled by its client');
    const running = stored.dump().includes(SECRET);
    const done = state();
    const finished = new ArmadaJob(done.ctx, world({}));

    await finished.create('j2', v.parse(JobSpecSchema, { recipe: {}, items, run: { command: ['true'] } }));
    await done.ctx.storage.put({ spec: { ...kept, env }, phase: 'done' });
    await finished.status();

    expect({ claimed, keptAfterCancel: running, keptWhenDone: done.dump().includes(SECRET) }).toEqual({ claimed: SECRET, keptAfterCancel: false, keptWhenDone: false });
  });

  test('reaches a vessel\'s task but never its storage, before or after the vessel is lost mid-task', async () => {
    const waits: string[] = [];
    const launched: (string | undefined)[] = [];
    const vesselState = state(container((argv, options) => {
      if (argv[3] === 'launch') launched.push(options?.env?.['TOKEN']);

      if (argv[3] === 'wait') {
        waits.push(vesselState.dump());

        return waits.length === 1 ? { exitCode: 0, stdout: '' } : new Error('Network connection lost.');
      }

      return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    }));
    const jobState = state();
    let vessel: ArmadaVessel | undefined;
    const job = new ArmadaJob(jobState.ctx, world({
      VESSEL: namespace((name): unknown => name === 'j1/v1' ? vessel : { begin: async () => undefined, stop: async () => undefined }),
      ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }) })),
    }));

    vessel = new ArmadaVessel(vesselState.ctx, world({ JOB: namespace(() => job) }));
    await job.create('j1', v.parse(JobSpecSchema, { recipe: {}, items: ['a'], run: { command: ['true'] }, env: { TOKEN: SECRET }, pool: 1 }));
    await job.alarm();
    await vessel.alarm();

    expect({
      launchedWith: launched,
      waits: waits.length,
      keptMidTask: waits[0]?.includes(SECRET),
      running: waits[0]?.includes('"current"'),
      keptAfter: vesselState.dump().includes(SECRET),
      requeued: (await job.status())?.tasks.queued,
    }).toEqual({ launchedWith: [SECRET], waits: 2, keptMidTask: false, running: true, keptAfter: false, requeued: 1 });
  });
});
