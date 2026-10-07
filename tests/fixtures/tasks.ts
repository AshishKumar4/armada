import * as v from 'valibot';
import { fn } from '../../src/index';
import { greeting } from './greeting';

export const square = fn(import.meta, (n: number) => n * n);

export const greet = fn(import.meta, {
  input: v.object({ name: v.pipe(v.string(), v.minLength(1)) }),
  output: v.object({ text: v.string() }),
}, ({ name }) => ({ text: greeting(name) }));

export const encode = fn(import.meta, (text: string) => new TextEncoder().encode(text));

export const refuse = fn(import.meta, (n: number): number => {
  throw new RangeError(`no ${String(n)}`);
});

/** Answers what its output schema refuses. */
export const lie = fn(import.meta, { output: v.object({ n: v.number() }) }, (n: number) => ({ n: String(n) as unknown as number }));
