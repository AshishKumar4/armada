import { expect, test } from 'bun:test';
import { lpt, poolFor, schedule } from '../src/schedule';

test('plans a skewed queue, improves the known LPT worst case, and accounts for late machines', () => {
  // The standard three-machine LPT counterexample: 11 versus the optimum 9.
  const work = [5, 5, 4, 4, 3, 3, 3];
  const plan = schedule(work, [0, 0, 0]);
  expect(lpt(work, [0, 0, 0]).makespan).toBe(11);
  expect(plan.makespan).toBe(9);
  expect(plan.lowerBound).toBe(9);
  expect(plan.ratio).toBe(1);
  expect(plan.exact).toBe(true);
  expect(plan.lanes.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  const released = schedule(work, [0, 3, 20]);
  expect(released.makespan).toBe(20);
  expect(poolFor([100, 40, 40, 40, 40], 5, 3)).toBe(3);
});

test('certificates bound exhaustive small optima and retain the LPT candidate on larger skewed workloads', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const weights = Array.from({ length: 7 }, (_, index) => 1 + (seed * (index + 3) * 31) % 17);
    const loads = [0, 0, 0];
    let optimal = Infinity;
    const enumerate = (at: number): void => {
      if (at === weights.length) { optimal = Math.min(optimal, Math.max(...loads)); return; }
      for (let lane = 0; lane < loads.length; lane += 1) {
        loads[lane] = (loads[lane] ?? 0) + (weights[at] ?? 0);
        enumerate(at + 1);
        loads[lane] = (loads[lane] ?? 0) - (weights[at] ?? 0);
      }
    };
    enumerate(0);
    const planned = schedule(weights, [0, 0, 0]);
    expect(planned.makespan).toBe(optimal);
    expect(planned.lowerBound).toBeLessThanOrEqual(optimal);
    const larger = [...weights, ...weights, seed];
    expect(schedule(larger, [0, 0, 0]).makespan).toBeLessThanOrEqual(lpt(larger, [0, 0, 0]).makespan);
  }
});
