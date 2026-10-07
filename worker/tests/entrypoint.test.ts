/**
 * The container's main process (`hold`), run here in /bin/sh: the platform's SIGTERM no longer ends the container
 * while a task runs on it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hold } from '../src/container';

const roots: string[] = [];

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A state directory, with a task running in it when `running`, and its main process started on it. */
async function started(running: boolean) {
  const state = mkdtempSync(join(tmpdir(), 'armada-hold-'));

  roots.push(state);
  mkdirSync(join(state, 'task'));
  if (running) writeFileSync(join(state, 'task', 'pid'), '1\n');
  const main = Bun.spawn(['/bin/sh', '-c', hold(state, 30, 1)]);

  await Bun.sleep(300);

  return { state, main, ended: () => main.exitCode !== null };
}

describe('the container\'s main process', () => {
  test('holds through SIGTERM while a task runs, marks the container stopping, and ends a linger after the task', async () => {
    const { state, main, ended } = await started(true);

    main.kill('SIGTERM');
    await Bun.sleep(2_000);
    expect({ ended: ended(), stopping: existsSync(join(state, 'stopping')) }).toEqual({ ended: false, stopping: true });
    writeFileSync(join(state, 'task', 'exit'), '0\n');
    expect(await Promise.race([main.exited, Bun.sleep(5_000).then(() => 'still running')])).toBe(0);
  }, 15_000);

  test('ends a linger after SIGTERM when no task runs', async () => {
    const { main } = await started(false);
    const sent = Date.now();

    main.kill('SIGTERM');
    expect(await Promise.race([main.exited, Bun.sleep(5_000).then(() => 'still running')])).toBe(0);
    expect(Date.now() - sent).toBeGreaterThanOrEqual(900);
  }, 15_000);
});
