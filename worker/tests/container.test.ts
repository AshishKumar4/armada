import { describe, expect, test } from 'bun:test';
import { run } from '../src/container';
import { container } from './harness';

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
