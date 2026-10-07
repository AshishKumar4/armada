/**
 * What the typed API refuses at compile time. The typecheck compiles this file; each `@ts-expect-error` fails the
 * typecheck if the line under it ever compiles.
 */
import * as v from 'valibot';
import { cmd, fn, recipe, type Result } from '../src/index';

// @ts-expect-error a Date does not come back as a Date
export const dated = fn(import.meta, (n: number) => new Date(n));

// @ts-expect-error an item with no type is not known to be JSON
export const untyped = fn(import.meta, (n) => n);

// @ts-expect-error a required property that may be undefined does not survive JSON
export const holey = fn(import.meta, (n: number) => ({ a: n, b: n > 1 ? 'x' : undefined }));

// @ts-expect-error a command's item is sent as JSON
export const datedItem = cmd(recipe(), (when: Date) => ['date', String(when)]);

// @ts-expect-error `object` says nothing of what travels
export const vague = fn(import.meta, (x: object): object => x);

// @ts-expect-error a Map item is not JSON
export const mapped = fn(import.meta, (m: Map<string, number>) => m.size);

// @ts-expect-error `any` is not known to be JSON
export const anything = fn(import.meta, (x: any) => x);

// @ts-expect-error a schema of anything says nothing of what travels
export const anySchema = fn(import.meta, { input: v.any() }, () => 1);

export const buffered = fn(import.meta, (text: string) => Buffer.from(text));

export const optional = fn(import.meta, (n: number): { a: number; b?: string } => ({ a: n }));

export const shaped = fn(import.meta, { input: v.object({ url: v.string() }), output: v.object({ bytes: v.number() }) }, async ({ url }) => ({ bytes: url.length }));

export async function typed(): Promise<void> {
  const values: { a: number; b?: string }[] = await optional.map([1]).values();
  const checked: { bytes: number } = await shaped.run({ url: 'x' });
  const bytes: Uint8Array = await buffered.run('x');
  // @ts-expect-error bytes arrive as a plain Uint8Array, not the Buffer the function returned
  const buffer: Buffer = await buffered.run('x');
  // @ts-expect-error the input schema's input is what a caller passes
  await shaped.run({ href: 'x' });
  // @ts-expect-error items are the handler's input
  await optional.map(['1']).values();

  for await (const result of optional.map([1])) {
    const narrowed: string = describe(result);

    void narrowed;
  }
  void [values, checked, bytes, buffer];
}

function describe(result: Result<number, { a: number; b?: string }>): string {
  switch (result.kind) {
    case 'ok': return String(result.value.a);
    case 'error': return result.error.message;
    case 'timeout': return String(result.meta.seconds);
    case 'cancelled':
    case 'lost': return result.reason;
  }
}
