import * as v from 'valibot';
import { sh, task } from '../../../src/index';
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
