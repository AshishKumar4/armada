import { describe, expect, test } from 'bun:test';
import type { Recipe } from '../../src/protocol';
import { ArmadaPreparer } from '../src/environments';
import { container, namespace, state, world } from './harness';

describe('preparing an environment', () => {
  test('runs the recipe\'s setup as root with root\'s PATH, where locale-gen and its kin are', async () => {
    const setups: (string | undefined)[] = [];
    const failures: string[] = [];
    const stored = state(container((argv, options) => {
      if (argv[1] === '/armada/setup.sh') setups.push(options?.env?.['PATH']);

      return { exitCode: 0, stdout: (argv[2] ?? '').includes('echo ready') ? 'ready\n' : '' };
    }));
    const preparer = new ArmadaPreparer(stored.ctx, world({
      ENVIRONMENTS: namespace(() => ({ preparationFailed: async (_key: string, _since: number, reason: string) => { failures.push(reason); } })),
    }));
    const recipe: Recipe = { base: 'cloudflare/debian-trixie', setup: 'locale-gen\n', install: '', smoke: '', instance: 'standard-4' };

    await preparer.begin('k'.repeat(64), 0, recipe, null);
    await preparer.alarm();
    await preparer.alarm();

    expect({ failures, path: setups[0]?.split(':') }).toEqual({ failures: [], path: expect.arrayContaining(['/usr/sbin', '/sbin', '/usr/bin']) });
  });
});
