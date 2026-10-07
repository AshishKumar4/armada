/**
 * The Worker's Durable Objects under Bun: `cloudflare:workers` mocked to a base class that keeps `ctx` and `env`, each
 * object's storage in memory (its key-value API over a Map, its SQL API over bun:sqlite), and a container whose execs
 * answer as a test says. Stubs passed across the RPC boundary are the objects themselves. bunfig.toml preloads this
 * file, so the mock is in place before a test imports the Worker's modules.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mock } from 'bun:test';
import type { Env } from '../src/env';

void mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(protected readonly ctx: unknown, protected readonly env: unknown) {}
  },
}));

export interface Stored {
  readonly ctx: DurableObjectState;
  /** Every key-value entry and every SQL row the object holds, as text. */
  readonly dump: () => string;
}

/** An in-memory Durable Object state, with `container` as its container. */
export function state(container?: Container): Stored {
  const entries = new Map<string, unknown>();
  const db = new Database(':memory:');
  const storage = {
    get: async (key: string) => structuredClone(entries.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [name, each] of typeof key === 'string' ? [[key, value] as const] : Object.entries(key)) entries.set(name, structuredClone(each));
    },
    delete: async (key: string) => entries.delete(key),
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
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

  // The few storage methods the objects call, not the whole DurableObjectState: a test double at the platform's seam.
  return { ctx: { storage, container } as unknown as DurableObjectState, dump };
}

/** A namespace whose `getByName` answers from `named`. */
export function namespace<T>(named: (name: string) => T): DurableObjectNamespace {
  // Only getByName is called; it returns the object itself in place of an RPC stub.
  return { getByName: named } as unknown as DurableObjectNamespace;
}

/** The bindings an object reaches, each answered in memory: the fleet always has room, and R2 stores nothing. */
export function world(bindings: Partial<Record<keyof Env, unknown>>): Env {
  const all = {
    FLEET: namespace(() => ({ acquire: async () => true, release: async () => undefined })),
    ARTIFACTS: { put: async () => undefined, get: async () => null },
    ...bindings,
  };

  // Only the bindings these objects reach are present.
  return all as unknown as Env;
}

/** What a container's exec answers: its exit code and output, or a throw for an exec the platform lost. */
export type Answer = (argv: readonly string[], options?: ContainerExecOptions) => { readonly exitCode: number; readonly stdout: string } | Error;

/** A container that has started, whose every exec `answer` decides. */
export function container(answer: Answer): Container {
  const fake = {
    running: true,
    start: () => undefined,
    destroy: async () => undefined,
    monitor: () => new Promise<void>(() => undefined),
    setInactivityTimeout: async () => undefined,
    exec: async (argv: string[], options?: ContainerExecOptions) => {
      const answered = answer(argv, options);

      if (answered instanceof Error) throw answered;

      return { stdin: new WritableStream(), output: async () => ({ exitCode: answered.exitCode, stdout: new TextEncoder().encode(answered.stdout).buffer, stderr: new ArrayBuffer(0) }) };
    },
  };

  // The calls a vessel makes of its container, answered in memory.
  return fake as unknown as Container;
}
