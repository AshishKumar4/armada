import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { recipe, sh, task } from '../../../src/index';
import { greeting } from '../greeting';

export const square = task({ id: 'square', run: (n: number) => n * n });

export const greet = task({
  id: 'greet',
  input: v.object({ name: v.pipe(v.string(), v.minLength(1)) }),
  output: v.object({ text: v.string() }),
  run: ({ name }) => ({ text: greeting(name) }),
});

export const encode = task({ id: 'encode', run: (text: string) => new TextEncoder().encode(text) });

export const refuse = task({
  id: 'refuse',
  run: (n: number): number => {
    throw new RangeError(`no ${String(n)}`);
  },
});

/** Answers what its output schema refuses. */
export const lie = task({ id: 'lie', output: v.object({ n: v.number() }), run: (n: number) => ({ n: String(n) as unknown as number }) });

/** A command that writes its number as JSON, and exits 3 above 2. */
export const write = task({
  id: 'write',
  output: v.object({ n: v.number() }),
  run: (n: number, { out }) => sh`printf '{"n": %s}' ${n} > ${out}; exit ${n > 2 ? 3 : 0}`,
});

/** Its word, unharmed by the shell. */
export const echo = task({ id: 'echo', output: 'text', run: (word: string, { out }) => sh`printf %s ${word} > ${out}` });

export const twoBytes = task({ id: 'two-bytes', output: 'bytes', run: (_: null, { out }) => sh`printf '\\377\\376' > ${out}` });

export const touch = task({ id: 'touch', run: (n: number) => sh`true ${n}` });

/** A body that runs a command and answers with a value built from it. */
export const shout = task({ id: 'shout', run: async (word: string) => (await sh`printf %s ${word}`.text()).toUpperCase() });

/** A plain value shaped like a command, which must come back as the value it is. */
export const lookalike = task({ id: 'lookalike', run: (path: string) => ({ script: `touch ${path}`, text: 'not a command' }) });

/** A recipe read from a file on the machine that makes the job, which a container must never read. */
export const fromFile = task({
  id: 'from-file',
  recipe: () => {
    if (process.env['ARMADA_TASK'] !== undefined) throw new Error('a container read the recipe');

    return recipe.debian().setup(readFileSync(new URL('../greeting.ts', import.meta.url), 'utf8'));
  },
  run: (n: number) => n + 1,
});

/** Fails until its third attempt, and is retried for it. */
export const flaky = task({
  id: 'flaky',
  retries: { attempts: 3, backoffSeconds: 0, errors: ['Flake'] },
  run: (n: number, { attempt }) => {
    if (attempt < 3) throw Object.assign(new Error(`attempt ${String(attempt)}`), { name: 'Flake' });

    return n;
  },
});
