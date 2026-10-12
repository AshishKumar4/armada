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
  const main = Bun.spawn(['/bin/sh', '-c', hold(state, 30)]);

  await Bun.sleep(300);

  return { state, main, ended: () => main.exitCode !== null };
}

describe('the container\'s main process', () => {
  test('holds through SIGTERM while a task runs and while its answer is unread, marks the container stopping, and ends once its vessel cleared it', async () => {
    const { state, main, ended } = await started(true);

    main.kill('SIGTERM');
    await Bun.sleep(2_000);
    const running = { ended: ended(), stopping: existsSync(join(state, 'stopping')) };

    writeFileSync(join(state, 'task', 'exit'), '0\n');
    await Bun.sleep(2_000);
    const unread = ended();

    rmSync(join(state, 'task'), { recursive: true });

    expect({ running, unread, cleared: await Promise.race([main.exited, Bun.sleep(5_000).then(() => 'still running')]) })
      .toEqual({ running: { ended: false, stopping: true }, unread: false, cleared: 0 });
  }, 20_000);

  test('ends at SIGTERM when no task runs', async () => {
    const { main } = await started(false);

    main.kill('SIGTERM');
    expect(await Promise.race([main.exited, Bun.sleep(7_000).then(() => 'still running')])).toBe(0);
  }, 15_000);
});
