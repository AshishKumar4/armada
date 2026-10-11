import { describe, expect, test } from 'bun:test';
import { run, startAndAnswer } from '../src/container';
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

    await startAndAnswer(machine, { entrypoint: ['sleep', 'infinity'], enableInternet: false }, 30_000, 60_000);

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
