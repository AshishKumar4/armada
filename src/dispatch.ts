/** A list schedule: each machine's tasks by index, each machine's load, and the last load. */
export interface Schedule {
  readonly lanes: number[][];
  readonly loads: number[];
  readonly makespan: number;
}

/** List scheduling: every task, in the given order, onto the machine whose load is least (ties: the first one),
 *  each machine starting at its own release. Integer milliseconds in, so the Lean model agrees exactly. */
export function listSchedule(durations: readonly number[], releases: readonly number[]): Schedule {
  const lanes: number[][] = releases.map(() => []);
  const loads = [...releases];

  for (const [task, duration] of durations.entries()) {
    let least = 0;

    for (let machine = 1; machine < loads.length; machine += 1) {
      if ((loads[machine] ?? 0) < (loads[least] ?? 0)) least = machine;
    }

    lanes[least]?.push(task);
    loads[least] = (loads[least] ?? 0) + duration;
  }

  return { lanes, loads, makespan: Math.max(0, ...loads) };
}
