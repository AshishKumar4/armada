import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PEAK_WINDOW_SECONDS, run, startAndAnswer, usageFrom, waitOn } from '../src/container';
import { container } from './harness';

describe('startAndAnswer', () => {
  test('starts a container again whose first exec the runtime killed, and answers once it comes up', async () => {
    Object.assign(globalThis, { scheduler: { wait: async (ms: number) => { await new Promise((resolve) => setTimeout(resolve, ms)); } } });
    let firsts = 0;
    let starts = 0;

    const machine = container((argv) => {
      if (argv[2]?.includes('echo ready') !== true) return { exitCode: 0, stdout: '' };

      firsts += 1;

      return firsts === 1 ? { exitCode: 137, stdout: '' } : { exitCode: 0, stdout: 'ready' };
    });

    const start = machine.start.bind(machine);

    machine.start = (options) => { starts += 1; start(options); };

    await startAndAnswer(machine, { entrypoint: ['sleep', 'infinity'], enableInternet: false }, { ms: 30_000, inactivityMs: 60_000 });

    expect({ firsts, starts }).toEqual({ firsts: 2, starts: 2 });
  });
});

describe('run', () => {
  /** The exec's signal, caught as the container sees it. */
  let signal: AbortSignal | undefined;

  test('an exec that answers leaves its signal unaborted past the deadline', async () => {
    const answered = container((_argv, options) => {
      signal = options?.signal;

      return { exitCode: 0, stdout: 'done' };
    });

    const ran = await run(answered, ['echo', 'done'], { ms: 30 });
    expect(ran).toEqual({ exitCode: 0, stdout: 'done', stderr: '' });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(signal?.aborted).toBe(false);
  });

  test('an exec that never answers rejects on its deadline', async () => {
    const hanging = container((_argv, options) => {
      const given = options?.signal;

      signal = given;

      return new Promise((_resolve, reject) => { given?.addEventListener('abort', () => { reject(given.reason); }); });
    });

    const started = Date.now();
    await expect(run(hanging, ['sleep', '600'], { ms: 30 })).rejects.toBeInstanceOf(DOMException);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(signal?.aborted).toBe(true);
  });
});

// 2026-11-10: a task that filled its container's disk exited, but the `exit` its wrapper writes on that disk failed (an
// I/O error), and its vessel read the empty file as a task still running until its timeout, 900 s.
describe('waitOn', () => {
  test('answers a task whose process is gone with no exit recorded at once, as gone, and a running one with nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'armada-wait-'));
    const wait = (seconds: string) => Bun.spawnSync(['/bin/sh', '-c', waitOn(dir), 'wait', seconds], { stdout: 'pipe' });

    try {
      // Its runner started, then ended without its exit written: the file it would write is there but empty.
      const ended = Bun.spawnSync(['/bin/sh', '-c', 'echo $$']);

      writeFileSync(join(dir, 'pid'), ended.stdout.toString());
      writeFileSync(join(dir, 'exit'), '');
      const began = Date.now();
      const gone = wait('20');

      writeFileSync(join(dir, 'pid'), `${String(process.pid)}\n`);
      const running = wait('1');

      expect({ gone: gone.stdout.toString().trim(), quick: Date.now() - began < 10_000, running: running.stdout.toString().trim() })
        .toEqual({ gone: 'gone', quick: true, running: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a run\'s usage', () => {
  test('reads its busiest window\'s cores beside its memory, CPU time, kills and disk, and none where no window was read', () => {
    const window = PEAK_WINDOW_SECONDS * 1e6;

    expect([usageFrom(`${String(2 ** 30)}\n5000000\n0\n${String(4 * window)}\n1000`), usageFrom(`${String(2 ** 30)}\n5000000\n0\n-1`)])
      .toEqual([{ peakMemory: 2 ** 30, cpuSeconds: 5, peakCores: 4, oomKilled: undefined, diskBytes: 1000 },
        { peakMemory: 2 ** 30, cpuSeconds: 5, peakCores: undefined, oomKilled: undefined, diskBytes: undefined }]);
  });
});
