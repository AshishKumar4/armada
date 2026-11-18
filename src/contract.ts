/**
 * The interface a deployment's Durable Objects call each other by, as a fingerprint: each Durable Object class's public
 * methods (the classes its config binds, and the classes they extend), with every declaration their arguments and
 * results name, and those name in turn, as the compiler emits them without comments. Objects running the earlier
 * Worker's code keep answering for minutes after a deploy, so a deploy whose fingerprint differs from the deployed
 * one's drains it first (`mustDrain`), and no object calls the other version by an interface it does not take. A change
 * only to how the code works, behind the same calls, takes over the running jobs; so does one to an export no call
 * names, a constant, a helper or a client's type (2026-11-18: a new HTTP header's name forced a drain that ran 30 min
 * against five open jobs and deployed nothing).
 *
 * Outside it: what an object keeps in its own storage, which only it reads, and which a drain does not touch either (a
 * drain ends the jobs, not the records of the objects they share, so code that changes a stored shape still reads the
 * earlier one); SQL tables, which each object migrates as it opens them; what runs in a container and how it answers,
 * which `DRIVER` versions; and what a type cannot say, such as a regex's pattern. After the drain, the fleet waits for
 * the deployment-wide objects to run the new code (`ArmadaFleet.admitJob`), not for those named by project or task
 * class (`TIMINGS`, `ESTIMATES`), which idle once the jobs end.
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
    const files = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.d.ts'));
    const hash = createHash('sha256');

    for (const declaration of called(files.map((file) => readFileSync(join(out, file), 'utf8')), bound(root))) hash.update(`${declaration}\n`);

    return hash.digest('hex');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The Durable Object classes `root`'s Worker config binds. */
function bound(root: string): readonly string[] {
  return [...readFileSync(join(root, 'worker', 'wrangler.jsonc'), 'utf8').matchAll(/"class_name":\s*"(\w+)"/gu)].map((match) => match[1] ?? '');
}

/** A top-level declaration's name in an emitted declaration file. */
const DECLARED = /^(?:export )?(?:declare )?(?:abstract )?(?:class|interface|type|const|function|enum|let|var|namespace) +([\w$]+)/u;

/** The declarations of `files` (emitted `.d.ts` texts) the public methods of the classes `roots` name, sorted: each
 *  class's public members and the classes it extends, then every declaration a kept text names, transitively. A class
 *  reached keeps its public members alone; its constructor, private and protected members are no call's. */
function called(files: readonly string[], roots: readonly string[]): readonly string[] {
  const declared = new Map<string, string[]>();

  for (const text of files) {
    // A top-level statement starts at the margin; its body and continuation lines are indented, or close it.
    const chunks = text.split(/\n(?=[^\s}\])])/u);

    for (const chunk of chunks) {
      const name = DECLARED.exec(chunk)?.[1];

      if (name !== undefined) declared.set(name, [...declared.get(name) ?? [], chunk]);
    }
  }

  const kept = new Set<string>();
  const seen = new Set<string>();

  const reach = (name: string): void => {
    if (seen.has(name)) return;

    seen.add(name);

    for (const chunk of declared.get(name) ?? []) {
      const text = /^(?:export )?(?:declare )?(?:abstract )?class /u.test(chunk) ? publicOf(chunk) : chunk;

      kept.add(text);

      for (const word of text.matchAll(/[A-Za-z_$][\w$]*/gu)) if (word[0] !== name) reach(word[0]);
    }
  };

  for (const root of roots) reach(root);

  return [...kept].toSorted();
}

/** A class declaration's name, the classes it extends, and its public members: its constructor's, private and
 *  protected members dropped, each member with its continuation lines. */
function publicOf(chunk: string): string {
  const [head = '', ...body] = chunk.split('\n');
  const members: string[] = [];

  for (const line of body) {
    if (/^ {4}\S/u.test(line) || members.length === 0) members.push(line);
    else members[members.length - 1] += `\n${line}`;
  }

  // Its header names the class and what it extends, not the platform's type arguments (`DurableObject<Env>`).
  const named = head.replace(/<[^{]*(?=\s*\{)/u, '').replace(/\bextends (DurableObject|Error)\b/u, '');

  return [named, ...members.filter((member) => !/^ {4}(?:private |protected |constructor\()/u.test(member))].join('\n');
}
