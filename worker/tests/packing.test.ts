import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JobSpecSchema, type Outcome } from '../../src/protocol';
import { itemKey, type Usage } from '../src/estimates';
import { ArmadaJob } from '../src/job';
import { namespace, READY, state, world } from './harness';

const GIB = 2 ** 30;

/** A class's store, and what jobs sent it: how many samples and which items to run alone, each time. */
interface Store {
  readonly estimates: DurableObjectNamespace;
  readonly recorded: readonly { readonly samples: number; readonly alone: readonly string[] }[];
}

/** A class's store that has learned `sample`, eight times over, and holds `items` records. */
function store(sample: Usage | null, items: Readonly<Record<string, Usage & { readonly alone: boolean }>> = {}): Store {
  const recorded: { samples: number; alone: string[] }[] = [];

  const estimates = namespace(() => ({
    read: async (keys: readonly string[]) => ({
      samples: sample === null ? [] : Array.from({ length: 8 }, () => sample),
      items: Object.fromEntries(keys.flatMap((key) => items[key] === undefined ? [] : [[key, items[key]]])),
    }),
    record: async (samples: readonly unknown[], alone: readonly string[] = []) => { recorded.push({ samples: samples.length, alone: [...alone] }); },
  }));

  return { estimates, recorded };
}

/** A job of `items` commands on a ready environment of a medium container, whose classes' store is `estimates`: what
 *  it began, and the job. */
async function packing(items: readonly string[], estimates: DurableObjectNamespace, more: Partial<v.InferInput<typeof JobSpecSchema>> = {}) {
  const begun: string[] = [];

  const created = new ArmadaJob(state().ctx, world({
    VESSEL: namespace((name: string) => ({ begin: async () => { begun.push(name); }, stop: async () => true })),
    ENVIRONMENTS: namespace(() => ({ used: async () => undefined, ensure: async () => ({ kind: 'ready', generation: READY }) })),
    ESTIMATES: estimates,
  }));

  await created.create('j1', v.parse(JobSpecSchema, { recipe: { size: 'medium' }, items: items.map((item) => ({ item, argv: ['run', item] })), run: { kind: 'command' }, pool: 4, ...more }));
  await created.alarm();

  return { job: created, begun };
}

/** What `vessel`'s slots 0 to 4 are handed, in turn: each task's item, or null. */
async function slotsOf(open: ArmadaJob, vessel: string): Promise<(number | null)[]> {
  const handed: (number | null)[] = [];

  for (let slot = 0; slot < 5; slot += 1) {
    const claim = await open.claim(vessel, slot);

    handed.push(claim === null || 'waitMs' in claim ? null : claim.index);
  }

  return handed;
}

const exited = (index: number, vessel: string, exitCode: number, more: Partial<Outcome> = {}): Outcome => ({
  index, kind: 'exited', exitCode, seconds: 10, vessel, attempt: 1, tail: '', output: false, cpuSeconds: 5, peakMemory: 2 * GIB, diskBytes: 1e6, ...more,
});

/** `vessel` runs the task it claimed and lands it with `outcome`. */
async function land(open: ArmadaJob, vessel: string, outcome: Outcome): Promise<void> {
  if (!(await open.accept(vessel, outcome.index, outcome.exitCode))) throw new Error(`${vessel} could not land task ${String(outcome.index)}`);
  await open.complete(vessel, outcome, 1000);
}

describe('an efficient job', () => {
  test('packs tasks into a container as their estimates fit, and asks only for the containers they fill', async () => {
    // Half a core and 2 GiB each: four fit a medium container's 4 vCPUs and 85% of its 11.5 GiB.
    const { job, begun } = await packing(['a', 'b', 'c', 'd'], store({ cores: 0.5, memory: 2 * GIB, disk: 1e6 }).estimates);

    expect({ begun, slots: await slotsOf(job, 'j1/v1') }).toEqual({ begun: ['j1/v1'], slots: [0, 1, 2, 3, null] });
  });

  test('runs each task alone, one a container, until its class is measured, and in fast mode', async () => {
    const unmeasured = await packing(['a', 'b', 'c'], store(null).estimates);
    const fast = await packing(['a', 'b', 'c'], store({ cores: 0.5, memory: 2 * GIB, disk: 1e6 }).estimates, { mode: 'fast' });

    expect({ unmeasured: [unmeasured.begun.length, await slotsOf(unmeasured.job, 'j1/v1')], fast: fast.begun.length })
      .toEqual({ unmeasured: [3, [0, null, null, null, null]], fast: 3 });
  });

  test('keeps a task whose own record does not fit off a container already busy', async () => {
    const { estimates } = store({ cores: 0.5, memory: 2 * GIB, disk: 1e6 });
    const { job } = await packing(['a', 'b'], estimates);
    // Measured on its own at 9 GiB, past what is left beside a.
    const big = await packing(['a', 'big'], store({ cores: 0.5, memory: 2 * GIB, disk: 1e6 }, Object.fromEntries([[await keyOf('big'), { cores: 1, memory: 9 * GIB, disk: 1e6, alone: false }]])).estimates);

    const besideA = await slotsOf(big.job, 'j1/v1');
    const own = await big.job.claim('j1/v2', 0);

    expect({ small: await slotsOf(job, 'j1/v1'), besideA, own: own === null || 'waitMs' in own ? null : own.index })
      .toEqual({ small: [0, 1, null, null, null], besideA: [0, null, null, null, null], own: 1 });
  });

  test('runs a task again alone, before its own retries, when it failed beside others, and says how; green alone, its item runs alone after', async () => {
    const { estimates, recorded } = store({ cores: 0.5, memory: 2 * GIB, disk: 1e6 });
    const { job } = await packing(['a', 'b'], estimates, { retries: { exitCodes: [1], attempts: 3 } });

    await slotsOf(job, 'j1/v1');
    await land(job, 'j1/v1', exited(0, 'j1/v1', 1));
    // Requeued alone: a busy vessel is not handed it; an empty one is.
    const besideB = await job.claim('j1/v1', 2);
    const alone = await job.claim('j1/v2', 0);

    if (alone === null || 'waitMs' in alone) throw new Error('no vessel ran it alone');
    await land(job, 'j1/v2', exited(0, 'j1/v2', 0, { attempt: alone.attempt }));
    await land(job, 'j1/v1', exited(1, 'j1/v1', 0));
    const { events } = await job.events(0);

    expect({ besideB, alone: alone.index, landed: events.map(({ outcome }) => [outcome.index, outcome.exitCode, outcome.aloneAfter ?? null]), sentAlone: recorded.flatMap(({ alone: items }) => items).length })
      .toEqual({ besideB: null, alone: 0, landed: [[0, 0, 'exit 1'], [1, 0, null]], sentAlone: 1 });
  });

  test('runs a task killed for memory beside others again alone, and leaves its item to its own record', async () => {
    const { estimates, recorded } = store({ cores: 0.5, memory: 2 * GIB, disk: 1e6 });
    const { job } = await packing(['a', 'b'], estimates);

    await slotsOf(job, 'j1/v1');
    await land(job, 'j1/v1', exited(0, 'j1/v1', 137, { oomKilled: true, peakMemory: 11 * GIB }));
    const alone = await job.claim('j1/v2', 0);

    if (alone === null || 'waitMs' in alone) throw new Error('no vessel ran it alone');
    await land(job, 'j1/v2', exited(0, 'j1/v2', 0, { attempt: alone.attempt }));
    await land(job, 'j1/v1', exited(1, 'j1/v1', 0));
    const { events } = await job.events(0);

    expect({ landed: events.map(({ outcome }) => [outcome.index, outcome.aloneAfter ?? null]), sentAlone: recorded.flatMap(({ alone: items }) => items).length })
      .toEqual({ landed: [[0, 'killed for memory'], [1, null]], sentAlone: 0 });
  });
});

/** An item's key as its job keys it. */
const keyOf = async (item: string): Promise<string> => await itemKey({ item, argv: ['run', item] });
