import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { EventsSchema, FleetSchema, JobSpecSchema, JobsSchema, JobStatusSchema, ProjectsSchema, VerdictsSchema, type Outcome } from '../../src/protocol';
import type { Env } from '../src/env';
import type { Generation } from '../src/environments';
import { ArmadaFleet, RECENT } from '../src/fleet';
import { ArmadaJob } from '../src/job';
import worker from '../src/worker';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

const generation: Generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

afterEach(() => { setSystemTime(); });

/** A deployment whose jobs start on a ready environment and whose vessels only record that they began, and a request
 *  into its Worker under its bearer. */
function deployment() {
  const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '64' }));
  const jobs = new Map<string, ArmadaJob>();
  const artifacts = bucket();
  const env: Env = world({
    ARMADA_TOKEN: TOKEN, FLEET: namespace(() => fleet), ARTIFACTS: artifacts,
    JOB: namespace((name: string) => jobs.get(name) ?? jobs.set(name, new ArmadaJob(state().ctx, env)).get(name)),
    VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
    ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }) })),
  });
  const ask = async (path: string, init: RequestInit = {}) => await worker.fetch(new Request(`https://armada.test${path}`, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': '7', 'content-type': 'application/json', ...init.headers },
  }), env);
  const json = async <S extends v.GenericSchema>(path: string, schema: S) => v.parse(schema, await (await ask(path)).json());

  return { fleet, jobs, artifacts, ask, json };
}

const exited = (index: number, vessel: string, exitCode = 0): Outcome => ({ index, kind: 'exited', exitCode, seconds: 2, vessel, attempt: 1, tail: '', output: false });

/** A job on a ready environment, made and started. */
async function started(spec: v.InferInput<typeof JobSpecSchema>, stored = state()) {
  const job = new ArmadaJob(stored.ctx, world({
    VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
    ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation }) })),
  }));

  await job.create('j1', v.parse(JobSpecSchema, spec));
  await job.alarm();

  return job;
}

describe('the list of recent jobs', () => {
  test('is newest first, each a brief of its status, and pages back from a job', async () => {
    const { ask, json } = deployment();
    const made: string[] = [];

    for (const [second, label] of [[1, 'first'], [2, 'second'], [3, 'third']] as const) {
      setSystemTime(new Date(Date.UTC(2026, 9, 8, 12, 0, second)));
      const created = await ask('/jobs', { method: 'POST', body: JSON.stringify({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, label }) });

      made.push(v.parse(v.object({ id: v.string() }), await created.json()).id);
    }
    const all = await json('/jobs', JobsSchema);
    const page = await json(`/jobs?limit=1&before=${made[2] ?? ''}`, JobsSchema);

    expect({
      labels: all.jobs.map((job) => job.label), brief: all.jobs[0], paged: page.jobs.map((job) => job.label),
    }).toMatchObject({
      labels: ['third', 'second', 'first'],
      brief: { id: made[2], phase: 'preparing', tasks: { total: 1, queued: 1 }, containers: 0, alive: 0, problems: [] },
      paged: ['second'],
    });
  });

  test('keeps only the newest of them', async () => {
    const fleet = new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: '64' }));

    for (let at = 0; at < RECENT + 2; at += 1) await fleet.opened(`20261008120000-${String(at).padStart(8, '0')}`);
    const kept = await fleet.recent(RECENT + 10);

    expect({ kept: kept.length, newest: kept[0], oldest: kept.at(-1) }).toEqual({
      kept: RECENT, newest: `20261008120000-${String(RECENT + 1).padStart(8, '0')}`, oldest: '20261008120000-00000002',
    });
  });
});

describe('a job\'s outcomes', () => {
  test('say when each landed, and a job an earlier Worker made says it from then on', async () => {
    const stored = state();

    // An earlier Worker's job: its events table has no `at`, and one outcome is already in it.
    stored.ctx.storage.sql.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT NOT NULL)');
    stored.ctx.storage.sql.exec('INSERT INTO events (outcome) VALUES (?)', JSON.stringify(exited(9, 'v0')));
    const job = await started({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' } }, stored);
    const claim = await job.claim('v1');

    if (claim === null || 'waitMs' in claim) throw new Error('v1 got no task');
    setSystemTime(new Date(1_800_000_000_000));
    await job.accept('v1', claim.index, 0);
    await job.complete('v1', exited(claim.index, 'v1'), 2000);
    const { events } = v.parse(EventsSchema, await job.events(0));

    expect(events.map((event) => [event.outcome.index, event.at])).toEqual([[9, undefined], [0, 1_800_000_000_000]]);
  });
});

describe('a job\'s status', () => {
  test('names each task running now on each container it runs on, a gang\'s on every rank', async () => {
    const plain = await started({ recipe: {}, items: [{ item: 'a', argv: ['true'] }, { item: 'b', argv: ['true'] }], run: { kind: 'command' } });

    setSystemTime(new Date(1_800_000_000_000));
    await plain.claim('v1');
    const gang = await started({ recipe: {}, items: [{ item: { gang: 2 }, argv: ['true'] }], pool: 2, run: { kind: 'command' } });

    await gang.claim('v1');
    await gang.claim('v2');
    await gang.claim('v1');
    const [one, two] = [v.parse(JobStatusSchema, await plain.status()), v.parse(JobStatusSchema, await gang.status())];

    expect({ plain: one.running, gang: two.running }).toEqual({
      plain: [{ index: 0, vessel: 'v1', started: 1_800_000_000_000 }],
      gang: [{ index: 0, vessel: 'v1', started: 1_800_000_000_000 }, { index: 0, vessel: 'v2', started: 1_800_000_000_000 }],
    });
  });
});

describe('the fleet', () => {
  test('says each job\'s share of the vCPUs it holds, largest first, under its cap', async () => {
    const { fleet, json } = deployment();

    await fleet.acquire('20261008120000-aaaaaaaa/v1', 4);
    await fleet.acquire('20261008120000-aaaaaaaa/v2', 4);
    await fleet.acquire('20261008120001-bbbbbbbb/v1', 2);

    expect(await json('/fleet', FleetSchema)).toEqual({
      cap: 64, jobs: [{ id: '20261008120000-aaaaaaaa', vcpus: 8, containers: 2 }, { id: '20261008120001-bbbbbbbb', vcpus: 2, containers: 1 }],
    });
  });
});

describe('the verdicts', () => {
  test('are listed by project, and a project\'s newest first with their counts, one stored before them read for its counts', async () => {
    const { ask, json, artifacts } = deployment();
    const [old, green, red] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)] as const;
    const rows = (...codes: number[]) => codes.map((exitCode, at) => ({ name: `row${String(at)}`, exitCode }));

    setSystemTime(new Date(1_800_000_000_000));
    // A verdict stored before verdicts carried their counts.
    await artifacts.put(`verdicts/p/${old}.json`, JSON.stringify({ sha: old, part: 'all', rows: rows(0, 1, 1) }));
    setSystemTime(new Date(1_800_000_001_000));
    await ask(`/verdicts/p/${green}`, { method: 'PUT', body: JSON.stringify({ sha: green, part: 'all', rows: rows(0, 0) }) });
    setSystemTime(new Date(1_800_000_002_000));
    await ask(`/verdicts/p/${red}`, { method: 'PUT', body: JSON.stringify({ sha: red, part: 'all', rows: rows(0, 2) }) });
    await ask(`/verdicts/q/${green}`, { method: 'PUT', body: JSON.stringify({ sha: green, part: 'all', rows: rows(0) }) });
    const mismatched = await ask(`/verdicts/p/${green}`, { method: 'PUT', body: JSON.stringify({ sha: red, part: 'all', rows: rows(0) }) });

    expect({ projects: await json('/verdicts', ProjectsSchema), verdicts: await json('/verdicts/p', VerdictsSchema), mismatched: mismatched.status }).toEqual({
      projects: { projects: ['p', 'q'] },
      verdicts: {
        verdicts: [
          { sha: red, uploaded: 1_800_000_002_000, rows: 2, reds: 1 }, { sha: green, uploaded: 1_800_000_001_000, rows: 2, reds: 0 },
          { sha: old, uploaded: 1_800_000_000_000, rows: 3, reds: 2 },
        ],
      },
      mismatched: 400,
    });
  });
});

describe('a browser at the deployment\'s root', () => {
  test('is sent to the dashboard, with no bearer asked for', async () => {
    const answer = await worker.fetch(new Request('https://armada.test/'), world({ ARMADA_TOKEN: TOKEN }));

    expect([answer.status, answer.headers.get('location')]).toEqual([302, 'https://armada.test/ui/']);
  });
});
