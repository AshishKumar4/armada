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
import { dirname, join, relative } from 'node:path';

/** The fingerprint of the Worker in `root`'s `worker/`, which its own `tsconfig.json` compiles. */
export function contractOf(root: string): string {
  const out = mkdtempSync(join(tmpdir(), 'armada-contract-'));

  try {
    // Run by the Bun that runs armada, as wrangler is: the compiler's own launcher needs Node.js.
    const emitted = Bun.spawnSync([process.execPath, join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'worker'), '--noEmit', 'false', '--declaration',
      '--emitDeclarationOnly', '--removeComments', '--rootDir', root, '--outDir', out]);

    if (emitted.exitCode !== 0) throw new Error(`the Worker's declarations did not compile:\n${emitted.stdout.toString()}${emitted.stderr.toString()}`);

    const files = new Map(readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.d.ts'))
      .map((file) => [join(out, file), readFileSync(join(out, file), 'utf8')]));

    const hash = createHash('sha256');

    for (const declaration of called(out, files, bound(root))) hash.update(`${declaration}\n`);

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

/** An emitted import or re-export: its names (`a`, `b as c`, `type d`) and the module it names. */
const IMPORTED = /^(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)';$/u;

/** An emitted namespace import (`import * as P`), or a re-export of all a module exports (`export *`). */
const WHOLE = /^(?:import\s+(?:type\s+)?\*\s+as\s+([\w$]+)|export\s+(?:type\s+)?\*)\s+from\s+'([^']+)';$/u;

/** One emitted declaration file: what it declares by name; the module and name each name it imports stands for; the
 *  module each namespace it imports stands for; the modules whose exports it exports whole. */
interface Module {
  readonly declared: ReadonlyMap<string, readonly string[]>;
  readonly imported: ReadonlyMap<string, { readonly from: string; readonly name: string }>;
  readonly namespaces: ReadonlyMap<string, string>;
  readonly starred: readonly string[];
}

/** `files` (path to emitted `.d.ts` text), each read as a `Module`. A relative import or re-export of another form
 *  (a default import) is refused, never dropped: a name it brings in would leave the fingerprint. */
function modulesOf(files: ReadonlyMap<string, string>): ReadonlyMap<string, Module> {
  return new Map([...files].map(([file, text]) => {
    const declared = new Map<string, string[]>();
    const imported = new Map<string, { from: string; name: string }>();
    const namespaces = new Map<string, string>();
    const starred: string[] = [];
    const target = (module: string) => join(dirname(file), module.replace(/\.(?:js|ts)$/u, '')) + '.d.ts';

    // A top-level statement starts at the margin; its body and continuation lines are indented, or close it.
    for (const chunk of text.split(/\n(?=[^\s}\])])/u)) {
      const name = DECLARED.exec(chunk)?.[1];

      if (name !== undefined) {
        declared.set(name, [...declared.get(name) ?? [], chunk]);

        continue;
      }

      const statement = chunk.replace(/\s+/gu, ' ').trim();

      if (!/^(?:import|export)\b.* from '\./u.test(statement)) continue;

      const named = IMPORTED.exec(statement);
      const whole = WHOLE.exec(statement);

      if (named !== null) {
        for (const part of (named[1] ?? '').split(',').map((each) => each.trim().replace(/^type\s+/u, '')).filter((each) => each !== '')) {
          const [exported = '', local = exported] = part.split(/\s+as\s+/u);

          imported.set(local, { from: target(named[2] ?? ''), name: exported });
        }
      } else if (whole?.[1] !== undefined) {
        namespaces.set(whole[1], target(whole[2] ?? ''));
      } else if (whole !== null) {
        starred.push(target(whole[2] ?? ''));
      } else {
        throw new Error(`${file}: an import of a form the Worker's contract does not follow: ${statement}`);
      }
    }

    return [file, { declared, imported, namespaces, starred }];
  }));
}

/** The declarations the public methods of the classes `roots` name, each with its file (under `out`), sorted: each
 *  class's public members and the classes it extends, then every declaration a kept text names, resolved in its own
 *  module (a local declaration, else what its import, namespace import or whole re-export stands for), transitively;
 *  every declaration of a name, as an interface's may be several. A class reached keeps its public members alone;
 *  its constructor, private and protected members are no call's, and the platform's type arguments of what it
 *  extends (`DurableObject<Env>`) are its deployment's, no call's. */
function called(out: string, files: ReadonlyMap<string, string>, roots: readonly string[]): readonly string[] {
  const modules = modulesOf(files);
  const kept = new Set<string>();
  const seen = new Set<string>();

  // Where `name` is declared, seen from `file`: its own module, else where its import or a whole re-export leads.
  const declaring = (file: string, name: string, hops = 0): readonly (readonly [string, string])[] => {
    const module = modules.get(file);

    if (module === undefined || hops > 16) return [];

    if (module.declared.has(name)) return [[file, name]];

    const imported = module.imported.get(name);

    if (imported !== undefined) return declaring(imported.from, imported.name, hops + 1);

    return module.starred.flatMap((from) => declaring(from, name, hops + 1));
  };

  // Every declaration of `name` in `file`, its text kept, then every name it says followed.
  const reach = (file: string, name: string): void => {
    if (seen.has(`${file}\n${name}`)) return;

    seen.add(`${file}\n${name}`);

    const module = modules.get(file);

    for (const chunk of module?.declared.get(name) ?? []) {
      const text = /^(?:export )?(?:declare )?(?:abstract )?class /u.test(chunk) ? publicOf(chunk) : chunk;

      kept.add(`${relative(out, file)}\n${text}`);

      for (const [word = ''] of text.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/gu)) {
        const [head = '', member] = word.split('.');
        const namespace = module?.namespaces.get(head);
        const found = namespace !== undefined && member !== undefined ? declaring(namespace, member) : declaring(file, head);

        for (const [at, declared] of found) if (!(at === file && declared === name)) reach(at, declared);
      }
    }
  };

  for (const [file, module] of modules) for (const root of roots) if (module.declared.has(root)) reach(file, root);

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
