/**
 * The interface a deployment's Durable Objects call each other by, as a fingerprint: the Worker's declarations, every
 * exported type and every class's public methods with their arguments and results, as the compiler emits them without
 * comments. Objects running the earlier Worker's code keep answering for minutes after a deploy, so a deploy whose
 * fingerprint differs from the deployed one's drains it first (`mustDrain`), and no object reads a call of the other
 * version. A change only to how the code works, behind the same declarations, takes over the running jobs.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The fingerprint of the Worker in `root`'s `worker/`, which its own `tsconfig.json` compiles. */
export function contractOf(root: string): string {
  const out = mkdtempSync(join(tmpdir(), 'armada-contract-'));

  try {
    const emitted = Bun.spawnSync([join(root, 'node_modules', '.bin', 'tsc'), '-p', join(root, 'worker'), '--noEmit', 'false', '--declaration', '--emitDeclarationOnly',
      '--removeComments', '--rootDir', root, '--outDir', out]);

    if (emitted.exitCode !== 0) throw new Error(`the Worker's declarations did not compile:\n${emitted.stdout.toString()}${emitted.stderr.toString()}`);
    const files = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.d.ts')).toSorted();
    const hash = createHash('sha256');

    for (const file of files) hash.update(`${file}\n${readFileSync(join(out, file), 'utf8')}\n`);

    return hash.digest('hex');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
