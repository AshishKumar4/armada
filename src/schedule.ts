/** Plans independent, non-preemptive tasks on identical machines. Durations and releases are estimates, in seconds. */
export interface Schedule {
  readonly lanes: readonly (readonly number[])[];
  readonly loads: readonly number[];
  readonly makespan: number;
  readonly lowerBound: number;
  readonly ratio: number;
  readonly exact: boolean;
}

// Eight bisections reduce MULTIFIT's additive search term to 1/256.
const BISECTIONS = 8;
// Exhaustive partitions grow exponentially; the remote planner benchmark measures this boundary.
const EXACT_TASKS = 12;

function ordered(weights: readonly number[]): number[] {
  return weights.map((_, index) => index).sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a - b);
}

function result(weights: readonly number[], releases: readonly number[], lanes: readonly (readonly number[])[], exact = false): Schedule {
  const loads = lanes.map((lane, index) => (releases[index] ?? 0) + lane.reduce((sum, task) => sum + (weights[task] ?? 0), 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const earliest = Math.min(...releases);
  // Each machine contributes only the capacity after its release. Water filling gives a release-aware work bound.
  const sorted = [...releases].sort((a, b) => a - b);
  let water = sorted[0] ?? 0;
  let remaining = total;
  for (let index = 1; index <= sorted.length; index += 1) {
    const next = sorted[index] ?? Infinity;
    const capacity = (next - water) * index;
    if (remaining <= capacity) { water += remaining / index; break; }
    remaining -= capacity;
    water = next;
  }
  const lowerBound = weights.length === 0 ? 0 : Math.max(water, earliest + Math.max(...weights));
  const makespan = weights.length === 0 ? 0 : Math.max(...loads);

  return { lanes, loads, makespan, lowerBound, ratio: lowerBound === 0 ? 1 : makespan / lowerBound, exact };
}

/** The existing longest-first greedy schedule, retained as a candidate, never as a second dispatch path. */
export function lpt(weights: readonly number[], releases: readonly number[]): Schedule {
  const lanes: number[][] = releases.map(() => []);
  const loads = [...releases];
  for (const task of ordered(weights)) {
    const lane = loads.reduce((least, load, index) => load < (loads[least] ?? Infinity) ? index : least, 0);
    lanes[lane]?.push(task);
    loads[lane] = (loads[lane] ?? 0) + (weights[task] ?? 0);
  }

  return result(weights, releases, lanes);
}

function pack(weights: readonly number[], releases: readonly number[], deadline: number): Schedule | undefined {
  const lanes: number[][] = releases.map(() => []);
  const loads = [...releases];
  for (const task of ordered(weights)) {
    const lane = loads.findIndex((load) => load + (weights[task] ?? 0) <= deadline);
    if (lane < 0) return undefined;
    lanes[lane]?.push(task);
    loads[lane] = (loads[lane] ?? 0) + (weights[task] ?? 0);
  }

  return result(weights, releases, lanes);
}

function improve(weights: readonly number[], releases: readonly number[], initial: Schedule): Schedule {
  let best = initial;
  for (;;) {
    let next = best;
    const critical = best.loads.indexOf(best.makespan);
    for (const task of best.lanes[critical] ?? []) {
      for (let to = 0; to < best.lanes.length; to += 1) {
        if (to === critical) continue;
        // A strict improvement is required; neutral moves could cycle indefinitely.
        const swaps: (number | undefined)[] = [undefined, ...(best.lanes[to] ?? [])];
        for (const swap of swaps) {
          const loads = [...best.loads];
          const delta = (weights[task] ?? 0) - (swap === undefined ? 0 : weights[swap] ?? 0);
          loads[critical] = (loads[critical] ?? 0) - delta;
          loads[to] = (loads[to] ?? 0) + delta;
          if (Math.max(...loads) >= next.makespan) continue;
          const lanes = best.lanes.map((lane) => [...lane]);
          lanes[critical] = (lanes[critical] ?? []).filter((index) => index !== task);
          lanes[to] = (lanes[to] ?? []).filter((index) => index !== swap);
          lanes[to]?.push(task);
          if (swap !== undefined) lanes[critical]?.push(swap);
          next = result(weights, releases, lanes.map((lane) => lane.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))));
        }
      }
    }
    if (next === best) return best;
    best = next;
  }
}

function exact(weights: readonly number[], releases: readonly number[], initial: Schedule): Schedule {
  let best = initial;
  const tasks = ordered(weights);
  const lanes: number[][] = releases.map(() => []);
  const loads = [...releases];
  const visit = (at: number): void => {
    const task = tasks[at];
    if (task === undefined) { best = result(weights, releases, lanes.map((lane) => [...lane]), true); return; }
    const seen = new Set<number>();
    for (let lane = 0; lane < loads.length; lane += 1) {
      const load = loads[lane] ?? 0;
      if (seen.has(load) || load + (weights[task] ?? 0) >= best.makespan) continue;
      seen.add(load);
      loads[lane] = load + (weights[task] ?? 0);
      lanes[lane]?.push(task);
      visit(at + 1);
      lanes[lane]?.pop();
      loads[lane] = load;
    }
  };
  visit(0);

  return { ...best, exact: true };
}

/** The best of LPT, MULTIFIT and strictly improving moves/swaps; small instances enumerate every better partition. */
export function schedule(weights: readonly number[], releases: readonly number[]): Schedule {
  if (releases.length === 0) throw new Error('a schedule needs at least one machine');
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0) || releases.some((release) => !Number.isFinite(release) || release < 0)) {
    throw new Error('durations and releases must be finite nonnegative seconds');
  }
  let best = lpt(weights, releases);
  let low = best.lowerBound;
  let high = Math.max(...releases) + Math.max(Math.max(0, ...weights), 2 * weights.reduce((sum, weight) => sum + weight, 0) / releases.length);
  const upper = pack(weights, releases, high);
  if (upper !== undefined && upper.makespan < best.makespan) best = upper;
  for (let round = 0; round < BISECTIONS; round += 1) {
    const middle = (low + high) / 2;
    const candidate = pack(weights, releases, middle);
    if (candidate === undefined) low = middle;
    else { high = middle; if (candidate.makespan < best.makespan) best = candidate; }
  }
  // Local search is unnecessary when the work or largest-task lower bound is already met.
  if (best.makespan > best.lowerBound) best = improve(weights, releases, best);

  return weights.length <= EXACT_TASKS ? exact(weights, releases, best) : best;
}

/** Wall time first: among plans within epsilon of the best at the largest pool, choose the smallest pool. */
export function poolFor(weights: readonly number[], most: number, bootSeconds = 0, epsilon = 0): number {
  const limit = Math.max(1, Math.min(most, Math.max(1, weights.length)));
  const target = schedule(weights, Array.from({ length: limit }, () => bootSeconds)).makespan * (1 + epsilon);
  for (let pool = 1; pool < limit; pool += 1) {
    if (schedule(weights, Array.from({ length: pool }, () => bootSeconds)).makespan <= target) return pool;
  }

  return limit;
}
