/**
 * Shell commands from a template, every interpolation escaped as one word, as Bun's `$` and zx do. A task whose body
 * returns a `Shell` is a command: its runner runs it, and the task answers with what it wrote to `out`. Inside a body,
 * `await sh\`...\`.text()` runs one and reads its output.
 */
import { spawn } from 'node:child_process';
import * as v from 'valibot';

/** What marks a command and the out file, so a body's plain value is never taken for either. Registered symbols, so
 *  a bundle holding a second copy of this module still knows them; JSON cannot carry them. */
const SHELL: unique symbol = Symbol.for('armada.shell');

const OUT: unique symbol = Symbol.for('armada.out');

/** The file a task answers with: interpolated into `sh` as its path. Only the runner and `.local` make one. */
export class OutFile {
  readonly [OUT] = true;

  constructor(readonly path: string) {}
}

/** What a template may interpolate: a word, a number, a list of words, the out file, or another command. */
export type Word = string | number | OutFile | Shell | readonly (string | number)[];

/** A command a body returned, made by this module or another copy of it. */
export const ShellSchema = v.custom<Shell>((value) => v.is(v.looseObject({ script: v.string() }), value) && SHELL in value);

const OutFileSchema = v.custom<OutFile>((value) => v.is(v.looseObject({ path: v.string() }), value) && OUT in value);

/** A command that has not run. It is not a thenable, so returning one from an async body makes it the task's command
 *  instead of awaiting it. */
export class Shell {
  readonly [SHELL] = true;

  constructor(readonly script: string) {}

  /** Runs it under `/bin/sh` and resolves to its output, or rejects with a ShellError when it exits nonzero. */
  async run(options: { readonly env?: Readonly<Record<string, string>>; readonly signal?: AbortSignal } = {}): Promise<{ readonly stdout: string; readonly stderr: string }> {
    const ran = await execute(this.script, options);

    if (ran.exitCode !== 0) throw new ShellError(this.script, ran.exitCode, ran.stderr);

    return ran;
  }

  async text(options?: { readonly env?: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<string> {
    return (await this.run(options)).stdout;
  }
}

export class ShellError extends Error {
  constructor(readonly script: string, readonly exitCode: number, readonly stderr: string) {
    super(`\`${script}\` exited ${String(exitCode)}${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-5).join('\n')}`}`);
    this.name = 'ShellError';
  }
}

/** One word for the shell, single-quoted unless it needs no quoting. */
export function quote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function interpolated(value: Word): string {
  if (v.is(ShellSchema, value)) return value.script;

  if (v.is(OutFileSchema, value)) return quote(value.path);

  return Array.isArray(value) ? value.map((word) => quote(String(word))).join(' ') : quote(String(value));
}

/** Whether the shell is inside quotes at the end of `script`: an interpolation quoted again there would be read inside
 *  those quotes, where `$(...)` still runs within double quotes. */
function quoted(script: string): boolean {
  let open: '' | "'" | '"' = '';

  for (let at = 0; at < script.length; at += 1) {
    const char = script[at];

    if (open !== "'" && char === '\\') at += 1;
    else if (open === '' && (char === "'" || char === '"')) open = char;
    else if (char === open) open = '';
  }

  return open !== '';
}

function template(strings: TemplateStringsArray, values: readonly Word[], escape: (value: Word) => string): Shell {
  return new Shell(strings.reduce((script, part, at) => {
    const value = values[at];

    if (value === undefined) return script + part;

    if (escape === interpolated && quoted(script + part)) throw new Error('sh quotes each ${} itself: write sh`echo ${word}`, not sh`echo "${word}"`');

    return script + part + escape(value);
  }, ''));
}

interface Sh {
  (strings: TemplateStringsArray, ...values: Word[]): Shell;
  /** Interpolates as written, unescaped: for a script that is itself shell. */
  raw(strings: TemplateStringsArray, ...values: (string | number)[]): Shell;
}

export const sh: Sh = Object.assign((strings: TemplateStringsArray, ...values: Word[]) => template(strings, values, interpolated), {
  raw: (strings: TemplateStringsArray, ...values: (string | number)[]) => template(strings, values, String),
});

/** Runs `script` under `/bin/sh`, with stdout and stderr read whole. */
export async function execute(script: string, options: { readonly env?: Readonly<Record<string, string>>; readonly signal?: AbortSignal; readonly inherit?: boolean } = {}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = spawn('/bin/sh', ['-c', script], { env: { ...process.env, ...options.env }, signal: options.signal, stdio: options.inherit === true ? 'inherit' : 'pipe' });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk); });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { resolve(code ?? (signal === null ? 1 : 128)); });
  });

  return { exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}
