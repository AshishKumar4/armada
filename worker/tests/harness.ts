/**
 * The Worker's Durable Objects under Bun: `cloudflare:workers` mocked to a base class that keeps `ctx` and `env`, each
 * object's storage in memory (its key-value API over a Map, its SQL API over bun:sqlite), and a container whose execs
 * answer as a test says. Stubs passed across the RPC boundary are the objects themselves. bunfig.toml preloads this
 * file, so the mock is in place before a test imports the Worker's modules.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mock } from 'bun:test';
import { timingSafeEqual } from 'node:crypto';
import * as v from 'valibot';
import { JsonSchema, type Json } from '../../src/protocol';
import type { Env } from '../src/env';

// workerd's constant-time comparison, which the Worker checks its bearer with.
Object.assign(crypto.subtle, { timingSafeEqual: (left: Uint8Array, right: Uint8Array) => timingSafeEqual(left, right) });

/** workerd's stream of a declared length, which refuses to end short or run long. */
class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0;

    super({
      transform: (chunk, controller) => {
        seen += chunk.byteLength;

        if (seen > length) throw new Error(`the stream ran past its ${String(length)} bytes`);
        controller.enqueue(chunk);
      },
      flush: () => {
        if (seen !== length) throw new Error(`the stream ended at ${String(seen)} of its ${String(length)} bytes`);
      },
    });
  }
}

Object.assign(globalThis, { FixedLengthStream });

await mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(protected readonly ctx: DurableObjectState, protected readonly env: Env) {}
  },
}));

/** A key, or the keys, a storage call names. */
const many = (key: string | readonly string[]): key is readonly string[] => Array.isArray(key);

export interface Stored {
  readonly ctx: DurableObjectState;
  /** Every key-value entry and every SQL row the object holds, as text. */
  readonly dump: () => string;
  /** The work the object handed `waitUntil`. */
  readonly pending: readonly Promise<unknown>[];
}

/** An in-memory Durable Object state, with `held` as its container. */
export function state(held?: Container): Stored {
  const entries = new Map<string, unknown>();
  let alarm: number | null = null;
  const db = new Database(':memory:');

  const storage = {
    get: async (key: string | readonly string[]) => many(key) ? new Map(key.flatMap((each) => entries.has(each) ? [[each, structuredClone(entries.get(each))]] : []))
      : structuredClone(entries.get(key)),
    put: async <T>(key: string | Readonly<Record<string, T>>, value?: T) => {
      for (const [name, each] of v.is(v.string(), key) ? [[key, value] as const] : Object.entries(key)) entries.set(name, structuredClone(each));
    },
    delete: async (keys: string | readonly string[]) => many(keys) ? keys.filter((key) => entries.delete(key)).length : entries.delete(keys),
    // As the platform lists: in key order, `end` exclusive, `limit` keys from the end `reverse` names.
    list: async ({ prefix = '', end, reverse = false, limit }: { prefix?: string; end?: string; reverse?: boolean; limit?: number } = {}) => {
      const keys = [...entries.keys()].filter((key) => key.startsWith(prefix) && (end === undefined || key < end)).sort();
      const ordered = reverse ? keys.reverse() : keys;

      return new Map(ordered.slice(0, limit ?? ordered.length).map((key) => [key, structuredClone(entries.get(key))]));
    },
    // One alarm an object, as the platform keeps it: set replaces it, delete clears it.
    getAlarm: async () => alarm,
    setAlarm: async (at: number | Date) => { alarm = at instanceof Date ? at.getTime() : at; },
    deleteAlarm: async () => { alarm = null; },
    sql: {
      exec: (query: string, ...bindings: SQLQueryBindings[]) => {
        const rows = db.query(query).all(...bindings);

        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`${String(rows.length)} rows from ${query}`);

            return rows[0];
          },
        };
      },
    },
  };

  const dump = () => {
    const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(({ name }) => db.query(`SELECT * FROM ${name}`).all());

    return JSON.stringify([[...entries], tables]);
  };

  // What an object hands `waitUntil`, for a test to wait on.
  const pending: Promise<unknown>[] = [];

  const ctx: Partial<DurableObjectState> = {};

  Object.assign(ctx, { storage, container: held, waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } });

  // SAFETY: the objects call only these storage methods, `container` and `waitUntil`, each constructed above.
  return { ctx: ctx as DurableObjectState, dump, pending };
}

/** A namespace whose `getByName` answers from `named`. */
export function namespace(named: (name: string) => object | undefined): DurableObjectNamespace {
  const space: Partial<DurableObjectNamespace> = {};

  Object.assign(space, { getByName: named });

  // SAFETY: the objects call only getByName, constructed above to return the object itself in place of an RPC stub.
  return space as DurableObjectNamespace;
}

/** An R2 bucket in memory: what a test reads back of what was put, by key. */
export function bucket(objects = new Map<string, string>()) {
  const kept = new Map<string, { readonly uploaded: Date; readonly customMetadata: Record<string, string>; readonly httpMetadata: R2HTTPMetadata }>();

  const object = (key: string) => ({
    key, size: new TextEncoder().encode(objects.get(key) ?? '').byteLength, uploaded: kept.get(key)?.uploaded ?? new Date(), customMetadata: kept.get(key)?.customMetadata ?? {},
    httpMetadata: kept.get(key)?.httpMetadata ?? {},
    writeHttpMetadata: (headers: Headers) => {
      const meta = kept.get(key)?.httpMetadata;

      if (meta?.contentType !== undefined) headers.set('content-type', meta.contentType);

      if (meta?.contentEncoding !== undefined) headers.set('content-encoding', meta.contentEncoding);
    },
  });

  return {
    objects,
    /** When each object was put, and its type headers, which a test may move back or read. */
    kept,
    head: async (key: string) => objects.has(key) ? object(key) : null,
    get: async (key: string) => {
      const text = objects.get(key);

      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);

      return { ...object(key), size: bytes.byteLength, body: new Blob([bytes]).stream(), text: async () => text, json: async (): Promise<Json> => v.parse(JsonSchema, JSON.parse(text)), arrayBuffer: async () => bytes.buffer };
    },
    put: async (key: string, body: ReadableStream | string | ArrayBuffer | null, options: { readonly customMetadata?: Record<string, string>; readonly httpMetadata?: R2HTTPMetadata } = {}) => {
      objects.set(key, await new Response(body).text());
      kept.set(key, { uploaded: new Date(), customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {} });
    },
    delete: async (key: string) => {
      objects.delete(key);
      kept.delete(key);
    },
    // A `delimiter` folds the keys under each next segment into one of `delimitedPrefixes`, as R2 does.
    list: async ({ prefix = '', delimiter }: { readonly prefix?: string; readonly delimiter?: string } = {}) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const folded = (key: string) => delimiter !== undefined && key.slice(prefix.length).includes(delimiter);

      return {
        objects: keys.filter((key) => !folded(key)).map(object), truncated: false,
        delimitedPrefixes: [...new Set(keys.filter(folded).map((key) => key.slice(0, key.indexOf(delimiter ?? '', prefix.length) + 1)))],
      };
    },
  };
}

/** A binding a test answers in memory: a namespace, a bucket, a version, or a variable's text. */
type Fake = DurableObjectNamespace | ReturnType<typeof bucket> | WorkerVersionMetadata | string;

/** The bindings an object reaches, each answered in memory: the fleet always has room. */
export function world(bindings: Partial<Record<keyof Env, Fake>>): Env {
  const env: Partial<Env> = {};

  Object.assign(env, {
    FLEET: namespace(() => ({ acquire: async () => true, release: async () => undefined, opened: async () => undefined, closed: async () => undefined, admits: async () => true, reserve: async () => true })),
    VERSION: { id: 'version', tag: '', timestamp: '' },
    ARTIFACTS: bucket(),
    ...bindings,
  });

  // SAFETY: the objects reach only these bindings, each constructed above or by the test with the members they call.
  return env as Env;
}

/** What a container's exec answers: its exit code and output, or a throw for an exec the platform lost. */
export type Answer = (argv: readonly string[], options?: ContainerExecOptions) => { readonly exitCode: number; readonly stdout: string } | Error | Promise<{ readonly exitCode: number; readonly stdout: string }>;

/** A container that has started, whose every exec `answer` decides. */
export function container(answer: Answer): Container {
  const fake = {
    running: true,
    start: () => undefined,
    destroy: async () => undefined,
    monitor: () => new Promise<void>(() => undefined),
    setInactivityTimeout: async () => undefined,
    exec: async (argv: string[], options?: ContainerExecOptions) => {
      const answered = await answer(argv, options);

      if (answered instanceof Error) throw answered;

      const stdout = new TextEncoder().encode(answered.stdout);

      return {
        stdin: new WritableStream(), stdout: new Blob([stdout]).stream(), exitCode: Promise.resolve(answered.exitCode),
        output: async () => ({ exitCode: answered.exitCode, stdout: stdout.buffer, stderr: new ArrayBuffer(0) }),
      };
    },
  };

  const machine: Partial<Container> = {};

  Object.assign(machine, fake);

  // SAFETY: a vessel calls only these members of its container, each constructed above in memory.
  return machine as Container;
}
