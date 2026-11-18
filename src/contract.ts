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

/** The fingerprint of what a client and the Worker each derive and must agree on: every value src/protocol.ts exports
 *  that both the Worker (worker/src/) and the client (src/, beside protocol.ts) import, with every declaration its
 *  source names, and those name in turn, followed through relative imports into their own modules, as their tokens:
 *  no comment and no whitespace, so formatting alone changes nothing, and every string, regex and template literal as
 *  written, so any change to how one is computed does. The contract (`contractOf`) reads declared types alone, never a
 *  body: 2026-11-18's deploy re-keyed a pinned job's environment (`environmentKey`) behind the same types, and every
 *  job of the pinned client was refused until it moved. `armada deploy` refuses a version whose fingerprint differs
 *  from the deployed one's unless its wire's floor is raised past it (`clientRefusal`), so a pinned client is refused
 *  at its first request with an update, never mid-job. It errs toward a change: a refactor of a shared derivation asks
 *  the floor's raise too. */
export function derivedOf(root: string): string {
  const protocol = join(root, 'src', 'protocol.ts');

  const sources = (directory: string): string[] => readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => join(directory, file));

  const importing = (files: readonly string[]): Set<string> => new Set(files.flatMap((file) => [...sourceModule(file).imported]
    .filter(([, imported]) => imported.from === protocol).map(([, imported]) => imported.name)));

  const worker = importing(sources(join(root, 'worker', 'src')));
  const client = importing(sources(join(root, 'src')).filter((file) => file !== protocol));
  const modules = new Map<string, SourceModule>();

  const moduleOf = (file: string): SourceModule => {
    const read = modules.get(file) ?? sourceModule(file);

    modules.set(file, read);

    return read;
  };

  const kept = new Set<string>();
  const seen = new Set<string>();

  // `name` as module `file` declares it, or where its relative import leads; a name no relative module declares (a
  // global, a package's, a local variable) leads nowhere.
  const reach = (file: string, name: string): void => {
    if (seen.has(`${file}\0${name}`)) return;

    seen.add(`${file}\0${name}`);
    const module = moduleOf(file);
    const imported = module.imported.get(name);

    if (imported !== undefined) {
      reach(imported.from, imported.name);

      return;
    }

    for (const tokens of module.declared.get(name) ?? []) {
      kept.add(`${relative(root, file)}\0${tokens.join(' ')}`);

      for (const token of tokens) if (/^[A-Za-z_$][\w$]*$/u.test(token) && token !== name) reach(file, token);
    }
  };

  for (const name of [...worker].filter((each) => client.has(each)).toSorted()) reach(protocol, name);
  const hash = createHash('sha256');

  for (const text of [...kept].toSorted()) hash.update(`${text}\n`);

  return hash.digest('hex');
}

/** A TypeScript source file's top-level declarations, each name's every declaration as its tokens (`tokensOf`), and
 *  the names its relative imports bring in, each with the file and name it stands for. */
interface SourceModule {
  readonly declared: ReadonlyMap<string, readonly (readonly string[])[]>;
  readonly imported: ReadonlyMap<string, { readonly from: string; readonly name: string }>;
}

/** The words that open a top-level declaration, after any of `export`, `declare`, `abstract`, `async`, `default`. */
const OPENING = new Set(['class', 'interface', 'type', 'const', 'function', 'enum', 'let', 'var', 'namespace']);

/** `file` read as a `SourceModule`: its tokens split into statements where a token at bracket depth 0 opens a line and
 *  starts a declaration, an import or an export. A type-only import brings in no value and is no derivation's. */
function sourceModule(file: string): SourceModule {
  const declared = new Map<string, string[][]>();
  const imported = new Map<string, { from: string; name: string }>();
  const statements: string[][] = [];

  for (const { token, opens } of tokensOf(readFileSync(file, 'utf8'))) {
    if (opens || statements.length === 0) statements.push([]);
    statements.at(-1)?.push(token);
  }

  for (const tokens of statements) {
    if (tokens[0] === 'import' && tokens[1] === '{') {
      const close = tokens.indexOf('}');
      const from = tokens[close + 2] ?? '';

      if (tokens[close + 1] !== 'from' || !/^['"]\./u.test(from)) continue;
      const target = join(dirname(file), from.slice(1, -1).replace(/\.(?:js|ts)$/u, '')) + '.ts';
      const names = tokens.slice(2, close).join(' ').split(',').map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith('type '));

      for (const part of names) {
        const [name = '', local = name] = part.split(/\s+as\s+/u);

        imported.set(local, { from: target, name });
      }

      continue;
    }

    let at = 0;

    while (['export', 'declare', 'abstract', 'async', 'default'].includes(tokens[at] ?? '')) at += 1;

    if (!OPENING.has(tokens[at] ?? '')) continue;
    const name = tokens[at + 1] ?? '';

    declared.set(name, [...declared.get(name) ?? [], tokens]);
  }

  return { declared, imported };
}

/** JavaScript's punctuators of more than one character, longest first: each read whole (maximal munch), so `a++ + b`
 *  and `a + ++b` stay apart. */
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '**', '<<', '>>'];

/** `source`'s tokens without comments or whitespace, each literal (a string, a template's every part, a regex) whole as
 *  written, and whether each opens a statement: at bracket depth 0, first on its line, and a word a statement opens
 *  with. A `/` is a regex where a value cannot end before it (an operator, an opening bracket, a keyword). */
function* tokensOf(source: string): Generator<{ readonly token: string; readonly opens: boolean }> {
  let at = 0;
  let depth = 0;
  let lineStart = true;
  let previous = '';
  // Each template whose `${` is open: the depth its expression closes back at.
  const templates: number[] = [];
  // Each open parenthesis: whether a control statement's condition (`if (`), after whose `)` a `/` opens a regex.
  const parens: boolean[] = [];
  const word = /[A-Za-z_$][\w$]*/uy;
  const number = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?/uy;
  const valueEnds = (token: string): boolean => /^[\w$)\]}'"`]/u.test(token.at(-1) ?? '') && !['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await', 'else', 'do'].includes(token);

  // A template from `start` (its backtick, or the `}` that closes an expression in it) to its end or next `${`.
  const template = (start: number): string => {
    let end = start + 1;

    while (end < source.length && source[end] !== '`' && !(source[end] === '$' && source[end + 1] === '{')) end += source[end] === '\\' ? 2 : 1;

    return source.slice(start, end < source.length && source[end] === '`' ? end + 1 : end + 2);
  };

  while (at < source.length) {
    const char = source[at] ?? '';

    if (char === '\n') {
      lineStart = true;
      at += 1;
      continue;
    }

    if (/\s/u.test(char)) {
      at += 1;
      continue;
    }

    if (source.startsWith('//', at)) {
      at = source.indexOf('\n', at) === -1 ? source.length : source.indexOf('\n', at);
      continue;
    }

    if (source.startsWith('/*', at)) {
      at = source.indexOf('*/', at + 2) === -1 ? source.length : source.indexOf('*/', at + 2) + 2;
      continue;
    }

    let token: string;

    if (char === '`' || (char === '}' && templates.at(-1) === depth)) {
      if (char === '}') templates.pop();
      token = template(at);

      if (token.endsWith('${')) {
        templates.push(depth);
      }
    } else if (char === '\'' || char === '"') {
      let end = at + 1;

      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      token = source.slice(at, end + 1);
    } else if (char === '/' && !valueEnds(previous)) {
      let end = at + 1;
      let inClass = false;

      while (end < source.length && (inClass || source[end] !== '/') && source[end] !== '\n') {
        if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        end += source[end] === '\\' ? 2 : 1;
      }

      end += 1;

      while (/[a-z]/u.test(source[end] ?? '')) end += 1;
      token = source.slice(at, end);
    } else {
      word.lastIndex = at;
      number.lastIndex = at;
      token = word.exec(source)?.[0] ?? number.exec(source)?.[0] ?? PUNCTUATORS.find((each) => source.startsWith(each, at)) ?? char;

      if ('([{'.includes(token)) depth += 1;
      else if (')]}'.includes(token)) depth -= 1;

      if (token === '(') parens.push(['if', 'while', 'for', 'with'].includes(previous));
      else if (token === ')' && parens.pop() === true) {
        yield { token, opens: false };
        lineStart = false;
        // As a statement may start here, a `/` next opens a regex: `previous` as an operator's would leave it.
        previous = ';';
        at += 1;
        continue;
      }
    }

    const opens = lineStart && depth === 0 && (OPENING.has(token) || ['export', 'declare', 'abstract', 'async', 'import'].includes(token));

    yield { token, opens };
    lineStart = false;
    previous = token;
    at += token.length;
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

/** The emitted declaration file relative `module` names from `file`. */
function targetOf(file: string, module: string): string {
  return join(dirname(file), module.replace(/\.(?:js|ts)$/u, '')) + '.d.ts';
}

/** `files` (path to emitted `.d.ts` text), each read as a `Module`. A relative import or re-export of another form
 *  (a default import) is refused, never dropped: a name it brings in would leave the fingerprint. */
function modulesOf(files: ReadonlyMap<string, string>): ReadonlyMap<string, Module> {
  return new Map([...files].map(([file, text]) => {
    const declared = new Map<string, string[]>();
    const imported = new Map<string, { from: string; name: string }>();
    const namespaces = new Map<string, string>();
    const starred: string[] = [];
    const target = (module: string) => targetOf(file, module);

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

      // A type the compiler wrote by its module inline (`import('../x').T`), as an inferred one is.
      for (const [, from = '', member = ''] of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)\.([A-Za-z_$][\w$]*)/gu)) {
        if (from.startsWith('.')) for (const [at, declared] of declaring(targetOf(file, from), member)) reach(at, declared);
      }

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
