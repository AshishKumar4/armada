import { describe, expect, test } from 'bun:test';
import { DrainBound, drainWithin, openJobs, type Drainable, type ListedJob } from '../src/drain';
import { DRIVER, drainReasons, PROTOCOL, type Health } from '../src/protocol';

const MINUTE = 60_000;

/** A deployed version whose open jobs finish after `finishing` asks of the drain (never, where null), every call kept
 *  in order, on a clock that each sleep advances. */
function deployment(finishing: number | null, open: readonly ListedJob[]) {
  const calls: string[] = [];
  let asks = 0;
  let clock = 0;
  const deployed: Drainable = {
    drain: async () => {
      calls.push('drain');
      asks += 1;

      return await Promise.resolve(finishing !== null && asks > finishing ? 0 : open.length);
    },
    admit: async () => { calls.push('admit'); await Promise.resolve(); },
    openJobs: async () => await Promise.resolve([...open]),
  };

  return { deployed, calls, clock: { now: () => clock, sleep: async (ms: number) => { clock += ms; await Promise.resolve(); }, pollMs: MINUTE } };
}

const OPEN: ListedJob[] = [
  { id: 'job-b', label: 'nvgpu-lean', phase: 'running', createdAt: -120 * MINUTE },
  { id: 'job-a', label: '', phase: 'preparing', createdAt: -180 * MINUTE },
];

describe('a deploy drains the deployed version for a bound at most', () => {
  test('open jobs that outlast the bound end the drain: the deployed version admits jobs again and the deploy ends naming them', async () => {
    const { deployed, calls, clock } = deployment(null, OPEN);
    let drained = false;
    const said: string[] = [];
    const ended = drainWithin(deployed, 5 * MINUTE, () => { drained = true; }, (line) => { said.push(line); }, clock);

    const error = await ended.then(() => null, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(DrainBound);
    expect(drained).toBe(true);
    // Refused for the bound and no longer: asked each minute, then admitted once.
    expect(calls).toEqual(['drain', 'drain', 'drain', 'drain', 'drain', 'drain', 'admit']);
    expect(clock.now()).toBe(5 * MINUTE);
    // Every job still open is named, oldest first, with its age at the bound.
    const message = (error as DrainBound).message;

    expect(message.indexOf('job-a')).toBeLessThan(message.indexOf('job-b'));
    expect(message).toContain('185 min');
    expect(message).toContain('125 min');
    expect(said).toHaveLength(5);
  });

  test('open jobs that finish within the bound leave the drain held for the deploy, never admitting', async () => {
    const { deployed, calls, clock } = deployment(2, OPEN);
    let drained = false;

    await drainWithin(deployed, 5 * MINUTE, () => { drained = true; }, () => undefined, clock);

    expect(drained).toBe(true);
    expect(calls).toEqual(['drain', 'drain', 'drain']);
  });

  test('a Worker too old to drain is neither drained nor admitted', async () => {
    const calls: string[] = [];
    let drained = false;
    const old: Drainable = {
      drain: async () => { calls.push('drain'); return await Promise.resolve(null); },
      admit: async () => { calls.push('admit'); await Promise.resolve(); },
      openJobs: async () => await Promise.resolve([]),
    };

    await drainWithin(old, MINUTE, () => { drained = true; }, () => undefined, { now: () => 0, sleep: async () => { await Promise.resolve(); }, pollMs: 1 });

    expect([drained, calls]).toEqual([false, ['drain']]);
  });
});

describe('a deploy says why it drains', () => {
  const health = (fields: Partial<Health>): Health => ({ ok: true, driver: DRIVER, protocol: PROTOCOL, oldest: 3, vcpus: 1, jobs: 0, contract: 'this', ...fields }) as Health;

  test('one reason for each way the deployed Worker differs, none where this one takes over its jobs', () => {
    expect([
      drainReasons(health({}), false, 'this').length,
      drainReasons(health({}), true, 'this').length,
      drainReasons(health({ protocol: PROTOCOL + 1, driver: DRIVER + 1, contract: 'earlier' }), false, 'this').length,
      drainReasons(null, false, 'this').length,
    ]).toEqual([0, 1, 3, 1]);
  });
});

describe('the open jobs are read whole or not at all', () => {
  const page = (ids: readonly string[], done: ReadonlySet<string> = new Set()) =>
    Response.json({ jobs: ids.map((id) => ({ id, label: '', phase: done.has(id) ? 'done' : 'running', createdAt: 0 })) });

  test('every page is read, done jobs left out', async () => {
    const first = Array.from({ length: 100 }, (_, at) => `j${String(at)}`);
    const asked: string[] = [];
    const open = await openJobs(async (path) => {
      asked.push(path);

      return await Promise.resolve(path.includes('before=') ? page(['last'], new Set()) : page(first, new Set(['j0'])));
    });

    expect([open.length, asked.length, asked[1]]).toEqual([100, 2, '/jobs?limit=100&before=j99']);
  });

  test('a listing that repeats an id, or that no Worker answers, is refused', async () => {
    const repeated = Array.from({ length: 100 }, () => 'same');

    expect(await openJobs(async () => await Promise.resolve(page(repeated))).then(() => 'read', () => 'refused')).toBe('refused');
    expect(await openJobs(async () => await Promise.resolve(new Response(null, { status: 404 }))).then(() => 'read', () => 'refused')).toBe('refused');
  });
});
