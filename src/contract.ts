/**
 * The interface a deployment's Durable Objects call each other by, and the shapes they store, as a fingerprint: the
 * Worker's declarations, every exported type and every class's public methods with their arguments and results, as the
 * compiler emits them without comments. Each type an object keeps in its storage is exported for this. Objects running
 * the earlier Worker's code keep answering for minutes after a deploy, so a deploy whose fingerprint differs from the
 * deployed one's drains it first (`mustDrain`), and no object reads a call or a record of the other version. A change
 * only to how the code works, behind the same declarations, takes over the running jobs.
 *
 * Outside it: SQL tables, which each object migrates as it opens them; what runs in a container and how it answers,
 * which `DRIVER` versions; and what a type cannot say, such as a regex's pattern or a storage key's name. A drain ends
 * the jobs, not the records of the objects they share, so code that changes a stored shape still reads the earlier
 * one. After the drain, the fleet waits for the deployment-wide objects to run the new code (`ArmadaFleet.admitJob`),
 * not for those named by project or task class (`TIMINGS`, `ESTIMATES`), which idle once the jobs end.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The fingerprint of the Worker in `root`'s `worker/`, which its own `tsconfig.json` compiles. */
export function contractOf(root: string): string {
  const out = mkdtempSync(join(tmpdir(), 'armada-contract-'));

  try {
    // Run by the Bun that runs armada, as wrangler is: the compiler's own launcher needs Node.js.
    const emitted = Bun.spawnSync([process.execPath, join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'worker'), '--noEmit', 'false', '--declaration',
      '--emitDeclarationOnly', '--removeComments', '--rootDir', root, '--outDir', out]);

    if (emitted.exitCode !== 0) throw new Error(`the Worker's declarations did not compile:\n${emitted.stdout.toString()}${emitted.stderr.toString()}`);
    const files = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.d.ts')).toSorted();
    const hash = createHash('sha256');

    for (const file of files) hash.update(`${file}\n${readFileSync(join(out, file), 'utf8')}\n`);

    return hash.digest('hex');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
