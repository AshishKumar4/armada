import { describe, expect, test } from 'bun:test';
import { RELAY_HEADER, RELAY_IN } from '../src/relay';
import { ArmadaVessel } from '../src/vessel';
import { container, state, world } from './harness';

/** No network or container: only the Workers API surfaces a relay upgrade consumes. */
class Socket {
  send(_message: string | ArrayBuffer | Uint8Array): void {}

  close(_code?: number, _reason?: string): void {}
}

class Pair {
  readonly 0 = new Socket();

  readonly 1 = new Socket();
}

/** A held storage read and a held first TCP write, controlled independently. The latter models a TCP connection
 *  whose container is slow to answer. It must not delay the HTTP upgrade, which never awaits that connection. */
async function upgrade(holdStorage: boolean, holdContainer: boolean) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'WebSocketPair');
  Object.assign(globalThis, { WebSocketPair: Pair });
  const storage = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const writing = Promise.withResolvers<void>();
  const token = 't'.repeat(48);
  const dialed: number[] = [];
  let input: ReadableStreamDefaultController<Uint8Array> | undefined;

  const box = Object.assign(container(() => ({ exitCode: 0, stdout: '' })), {
    getTcpPort: (port: number) => {
      dialed.push(port);

      return { connect: () => ({
        readable: new ReadableStream<Uint8Array>({ start: (controller) => { input = controller; } }),
        writable: new WritableStream<Uint8Array>({ write: async () => { if (holdContainer) await writing.promise; } }),
      }) };
    },
  });

  const stored = state(box);
  await stored.ctx.storage.put('slot:0', {
    claim: { index: 2, attempt: 1, gang: { token, rank: 2, job: 'job', vessels: ['v6', 'v12', 'v10', 'v8'], origin: '' } },
    startedAt: 0,
  });
  Object.assign(stored.ctx, { acceptWebSocket: (_socket: Socket) => undefined });
  const list = stored.ctx.storage.list.bind(stored.ctx.storage);
  Object.assign(stored.ctx.storage, {
    list: async (...args: Parameters<typeof list>) => {
      reading.resolve();
      if (holdStorage) await storage.promise;

      return await list(...args);
    },
  });

  const vessel = new ArmadaVessel(stored.ctx, world({}));
  const response = vessel.fetch(new Request('https://armada.example/relay/job/v10?port=33133&id=b6464de9b6dd1d83', {
    headers: { upgrade: 'websocket', [RELAY_HEADER]: token },
  }));

  try {
    await reading.promise;
    // An event-loop turn, not a 60-second wall-clock failure: an unheld upgrade settles entirely in microtasks.
    const before = await Promise.race([
      response.then((answer) => answer.status),
      new Promise<'pending'>((resolve) => { setImmediate(() => { resolve('pending'); }); }),
    ]);
    storage.resolve();
    const after = (await response).status;

    return { before, after, dialed };
  } finally {
    storage.resolve();
    writing.resolve();
    input?.close();
    if (saved === undefined) Reflect.deleteProperty(globalThis, 'WebSocketPair');
    else Object.defineProperty(globalThis, 'WebSocketPair', saved);
  }
}

describe('a relay upgrade under vessel pressure (Dew ledger 1401)', () => {
  test('answers while the container connection has not completed its first write', async () => {
    expect(await upgrade(false, true)).toEqual({ before: 101, after: 101, dialed: [RELAY_IN] });
  });

  test('answers a new link while the vessel lifecycle storage is stalled', async () => {
    // Intentionally RED on origin/main: before is "pending". Releasing only storage makes the same request 101.
    // A fix must move the relay off the lifecycle object's storage/input gate, not merely increase RELAY_GRACE.
    expect(await upgrade(true, false)).toEqual({ before: 101, after: 101, dialed: [RELAY_IN] });
  });
});
