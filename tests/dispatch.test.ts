import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as v from 'valibot';
import { listSchedule } from '../src/dispatch';

/** The Lean model's answer for one instance, as `listSchedule` gives its own. */
const ScheduleSchema = v.object({ lanes: v.array(v.array(v.number())), loads: v.array(v.number()), makespan: v.number() });

/** The Lean executable `lake exe sched` leaves, printing `listSchedule`'s answer for one JSON instance. */
const EXE = new URL('../lean/.lake/build/bin/sched', import.meta.url).pathname;

const have = existsSync(EXE);

if (!have) console.log('dispatch differential test skipped: lean/.lake/build/bin/sched not built (cd lean && lake build)');

/** A deterministic source of instances, so a failing case reproduces from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const leanSchedule = (durations: readonly number[], releases: readonly number[]) => {
  const child = Bun.spawnSync([EXE], { env: process.env, stdin: new TextEncoder().encode(JSON.stringify({ durations, releases })) });

  if (child.exitCode !== 0) throw new Error(`sched failed: ${new TextDecoder().decode(child.stderr)}`);

  return v.parse(ScheduleSchema, JSON.parse(new TextDecoder().decode(child.stdout)));
};

(have ? describe : describe.skip)('listSchedule agrees with the Lean model', () => {
  test('seeded instances: 0..200 tasks on 1..64 machines, releases and ties', () => {
    const rand = mulberry32(0x5eed);

    for (let trial = 0; trial < 300; trial += 1) {
      const machines = 1 + Math.floor(rand() * 64);
      const durations = Array.from({ length: Math.floor(rand() * 201) }, () => Math.floor(rand() * 51));
      const releases = Array.from({ length: machines }, () => Math.floor(rand() * 31));

      expect(leanSchedule(durations, releases)).toEqual(listSchedule(durations, releases));
    }
  }, 60_000);

  test('edges: empty queue, one machine, all-zero durations', () => {
    expect(leanSchedule([], [0, 0])).toEqual(listSchedule([], [0, 0]));
    expect(leanSchedule([9, 8, 7], [0])).toEqual(listSchedule([9, 8, 7], [0]));
    expect(leanSchedule([0, 0, 0], [0, 0, 0])).toEqual(listSchedule([0, 0, 0], [0, 0, 0]));
    expect(leanSchedule([5, 5], [3, 3])).toEqual(listSchedule([5, 5], [3, 3]));
  });
});
