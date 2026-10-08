/**
 * What the typed API takes and refuses, checked by the typecheck. A task the overloads refuse has a `Checked` id type no
 * string fits; a call they refuse passes what the parameter does not take. Each `true` or `false` below stops compiling
 * once its type gives the other answer.
 */
import * as v from 'valibot';
import { sh, task, type Context, type Json, type Result, type Shell, type Task, type Word } from '../src/index';
import type { Checked } from '../src/task';

/** Whether the overloads refuse a task: its id is checked to a type no string fits. */
type Refused<C> = [C] extends [string] ? false : true;

/** Whether a value of type A fits where P is asked for. */
type Fits<A, P> = [A] extends [P] ? true : false;

/** JSON.parse's answer: `any`, which no task may take or give. */
type Parsed = ReturnType<typeof JSON.parse>;

export const refused = {
  dated: true satisfies Refused<Checked<number, Date, undefined>>,
  holey: true satisfies Refused<Checked<number, { a: number; b: string | undefined }, undefined>>,
  vague: true satisfies Refused<Checked<object, number, undefined>>,
  mapped: true satisfies Refused<Checked<Map<string, number>, number, undefined>>,
  parsedItem: true satisfies Refused<Checked<Parsed, number, undefined>>,
  parsedValue: true satisfies Refused<Checked<string, Parsed, undefined>>,
  opaque: true satisfies Refused<Checked<number, unknown, undefined>>,
  textForValue: true satisfies Refused<Checked<number, number, 'text'>>,
  bytesForValue: true satisfies Refused<Checked<number, number, 'bytes'>>,
  bytesWithoutOutput: true satisfies Refused<Checked<string, Uint8Array, undefined>>,
  mismatched: true satisfies Refused<Checked<number, { n: string }, v.ObjectSchema<{ readonly n: v.NumberSchema<undefined> }, undefined>>>,
  anyCommand: true satisfies Refused<Checked<null, Shell, v.AnySchema>>,
  unknownValue: true satisfies Refused<Checked<null, number, v.UnknownSchema>>,
  datedCommand: true satisfies Refused<Checked<null, Shell, v.DateSchema<undefined>>>,
};

export const taken = {
  json: false satisfies Refused<Checked<number, { a: number; b?: string }, undefined>>,
  bytes: false satisfies Refused<Checked<string, Uint8Array, 'bytes'>>,
  command: false satisfies Refused<Checked<number, Shell, 'text'>>,
};

export const optional = task({ id: 'optional', output: v.object({ a: v.number(), b: v.optional(v.string()) }), run: (n: number) => ({ a: n }) });

export const plain = task({ id: 'plain', run: (n: number) => n > 0 ? { a: n } : { a: n, b: 'none' } });

export const measured = task({ id: 'measured', input: v.object({ url: v.string() }), output: v.object({ bytes: v.number() }), run: async ({ url }) => ({ bytes: url.length }) });

export const buffered = task({ id: 'buffered', output: 'bytes', run: (text: string) => Buffer.from(text) });

export const echo = task({ id: 'echo', output: 'text', run: (word: string, { out }) => sh`printf %s ${word} > ${out}` });

export const counted = task({ id: 'counted', output: v.object({ n: v.number() }), run: (n: number, { out }) => sh`echo '{"n": ${n}}' > ${out}` });

export const touch = task({ id: 'touch', run: (n: number) => sh`true ${n}` });

// A body that does not type its item takes null, the one item it is sure of, and without an output answers JSON.
export const untyped: Task<null, Json> = task({ id: 'untyped', run: (n) => n });

// A secret the task names is a string.
export const named: Task<null, number> = task({ id: 'named', secrets: ['API_KEY'], output: v.number(), run: (_: null, { secrets }) => secrets.API_KEY.length });

export const calls = {
  bytesArrivePlain: false satisfies Fits<Awaited<ReturnType<typeof buffered.run>>, Buffer>,
  inputIsTheSchemas: false satisfies Fits<{ href: string }, Parameters<typeof measured.run>[0]>,
  itemsAreTheBodys: false satisfies Fits<string[], Parameters<typeof optional.map>[0]>,
  shWordsOnly: false satisfies Fits<{ a: number }, Word>,
  namedSecretsOnly: false satisfies Fits<'OTHER_KEY', keyof Context<'API_KEY'>['secrets']>,
};

export async function typed() {
  const values: { a: number; b?: string }[] = await optional.map([1]);
  const json: Json[] = await plain.map([1]);
  const checked: { bytes: number } = await measured.run({ url: 'x' });
  const bytes: Uint8Array = await buffered.run('x');
  const text: Task<string, string> = echo;
  const counts: Task<number, { n: number }> = counted;
  const none: Task<number, null> = touch;
  const described: string[] = [];

  for await (const result of optional.stream([1])) described.push(describe(result));

  return { values, json, checked, bytes, text, counts, none, described };
}

function describe(result: Result<number, { a: number; b?: string }>): string {
  if (result.ok) return String(result.value.a);

  switch (result.kind) {
    case 'error': return result.error.message;
    case 'timeout': return String(result.meta.seconds);
    case 'cancelled':
    case 'lost': return result.reason;
  }
}
