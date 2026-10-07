/**
 * What the typed API refuses at compile time. The typecheck compiles this file; each `@ts-expect-error` fails the
 * typecheck if the line under it ever compiles.
 */
import * as v from 'valibot';
import { sh, task, type Result, type Task } from '../src/index';

// @ts-expect-error a Date does not come back as a Date
export const dated = task({ id: 'dated', run: (n: number) => new Date(n) });

// A body that does not type its item takes null, the one item it is sure of.
export const untyped: Task<null, null> = task({ id: 'untyped', run: (n) => n });

// @ts-expect-error a required property that may be undefined does not survive JSON
export const holey = task({ id: 'holey', run: (n: number) => ({ a: n, b: n > 1 ? 'x' : undefined }) });

// @ts-expect-error `object` says nothing of what travels
export const vague = task({ id: 'vague', run: (x: object): object => x });

// @ts-expect-error a Map item is not JSON
export const mapped = task({ id: 'mapped', run: (m: Map<string, number>) => m.size });

// @ts-expect-error `any`, here JSON.parse's, is not known to be JSON
export const anything = task({ id: 'anything', run: (text: string) => JSON.parse(text) });

// @ts-expect-error a schema of anything says nothing of what travels
export const anySchema = task({ id: 'any-schema', input: v.any(), run: () => 1 });

// @ts-expect-error an explicit unknown is not known to be JSON
export const opaque = task({ id: 'opaque', run: (n: number): unknown => n });

// @ts-expect-error a body whose context it types itself is checked too
export const contextual = task({ id: 'contextual', run: (n: number, { out }) => ({ when: new Date(n), out }) });

// @ts-expect-error text or bytes output is a command's out file, read for a body that returns sh
export const textValue = task({ id: 'text-value', output: 'text', run: (n: number) => n });

// @ts-expect-error the body returns what its output schema does not take
export const mismatched = task({ id: 'mismatched', output: v.object({ n: v.number() }), run: (n: number) => ({ n: String(n) }) });

export const optional = task({ id: 'optional', run: (n: number): { a: number; b?: string } => ({ a: n }) });

export const shaped = task({ id: 'shaped', input: v.object({ url: v.string() }), output: v.object({ bytes: v.number() }), run: async ({ url }) => ({ bytes: url.length }) });

export const buffered = task({ id: 'buffered', run: (text: string) => Buffer.from(text) });

export const echo = task({ id: 'echo', output: 'text', run: (word: string, { out }) => sh`printf %s ${word} > ${out}` });

export const counted = task({ id: 'counted', output: v.object({ n: v.number() }), run: (n: number, { out }) => sh`echo '{"n": ${n}}' > ${out}` });

export const touch = task({ id: 'touch', run: (n: number) => sh`true ${n}` });

export async function typed(): Promise<void> {
  const values: { a: number; b?: string }[] = await optional.map([1]);
  const checked: { bytes: number } = await shaped.run({ url: 'x' });
  const bytes: Uint8Array = await buffered.run('x');
  const text: Task<string, string> = echo;
  const json: Task<number, { n: number }> = counted;
  const none: Task<number, null> = touch;
  // @ts-expect-error bytes arrive as a plain Uint8Array, not the Buffer the body returned
  const buffer: Buffer = await buffered.run('x');
  // @ts-expect-error the input schema's input is what a caller passes
  await shaped.run({ href: 'x' });
  // @ts-expect-error items are the body's input
  await optional.map(['1']);
  // @ts-expect-error sh interpolates words, numbers, word lists, the out file and commands, nothing else
  sh`echo ${{ a: 1 }}`;

  for await (const result of optional.stream([1])) {
    const narrowed: string = describe(result);

    void narrowed;
  }
  void [values, checked, bytes, buffer, text, json, none];
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

// @ts-expect-error a command's output schema is checked too: `any` says nothing of what travels
export const anyCommand = task({ id: 'any-command', output: v.any(), run: () => sh`echo 1` });

// @ts-expect-error an output schema of anything says nothing of what travels
export const unknownValue = task({ id: 'unknown-value', output: v.unknown(), run: () => 1 });

// @ts-expect-error a command's JSON cannot be a Date
export const datedCommand = task({ id: 'dated-command', output: v.date(), run: () => sh`true` });

// @ts-expect-error a body reads only the secrets its task names
export const unnamed = task({ id: 'unnamed', secrets: ['API_KEY'], run: (_: null, { secrets }) => secrets.OTHER_KEY });

// A secret the task names is a string.
export const named: Task<null, number> = task({ id: 'named', secrets: ['API_KEY'], run: (_: null, { secrets }) => secrets.API_KEY.length });
