import { readFileSync } from 'node:fs';
import { Armada } from '../src/sdk';
import { lpt, schedule } from '../src/schedule';

const baseline = process.argv[2];
const candidate = process.argv[3];
if (baseline === undefined || candidate === undefined) throw new Error('scheduler-bench <baseline connection> <candidate connection>');

async function run(file: string, weights: readonly number[], pool: number, staticSplit: boolean) {
  const armada = new Armada(JSON.parse(readFileSync(file, 'utf8')));
  const items = staticSplit ? lpt(weights, Array.from({ length: pool }, () => 0)).lanes.map((lane) => ({
    item: { weight: lane.reduce((sum, index) => sum + (weights[index] ?? 0), 0) }, argv: ['sh', '-c', lane.map((index) => `sleep ${String(weights[index])}`).join('; ')],
  })) : weights.map((weight) => ({ item: { weight }, argv: ['sleep', String(weight)] }));
  const id = await armada.create({ recipe: { size: 'micro' }, items, pool, run: { kind: 'command' }, label: staticSplit ? 'static timing split' : 'dynamic queue' });
  let after = 0;
  for (;;) {
    const events = await armada.events(id, after);
    after = events.events.at(-1)?.seq ?? after;
    if (events.events.some((event) => event.outcome.exitCode !== 0)) throw new Error(`benchmark ${id} failed`);
    if (events.done) break;
    await Bun.sleep(1000);
  }
  const status = await armada.status(id);
  console.log(JSON.stringify({ url: armada.connection.url, id, tasks: weights.length, pool, staticSplit,
    wallSeconds: ((status.finishedAt ?? 0) - status.createdAt) / 1000,
    mapSeconds: ((status.finishedAt ?? 0) - (status.startedAt ?? 0)) / 1000,
    containerSeconds: status.vessels.reduce((sum, vessel) => sum + vessel.busyMs + (vessel.bootMs ?? 0), 0) / 1000,
    schedule: status.schedule,
  }));
}

// This is a measured work run, not a snapshot prewarm: report the initial cold run as well as subsequent runs.
for (const [weights, pool] of [[Array.from({ length: 100 }, () => 3), 100], [[5, 5, 4, 4, 3, 3, 3], 3]] as const) {
  for (const file of [baseline, candidate]) {
    for (const staticSplit of [false, true]) await run(file, weights, pool, staticSplit);
  }
}

// Measure exact-search latency separately from container time, in the remote environment.
for (const n of [8, 10, 12, 14, 90, 1000]) {
  const weights = Array.from({ length: n }, (_, index) => 1 + (index * 17 + 11) % 37);
  const started = performance.now();
  const plan = schedule(weights, [0, 0, 0]);
  console.log(JSON.stringify({ n, plannerMs: performance.now() - started, makespan: plan.makespan, ratio: plan.ratio, exact: plan.exact }));
}
