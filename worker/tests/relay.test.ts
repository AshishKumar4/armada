import { describe, expect, test, vi } from 'bun:test';
import { RELAY_ACK, RELAY_GRACE_MS, RELAY_WINDOW, Relayed } from '../src/relay';

/** A WebSocket's vessel end that records what it carried: each binary message as [offset, length], each text as is. */
function socket() {
  const carried: (string | [number, number])[] = [];
  const closes: [number, string][] = [];
  const ws = {
    send: (data: string | Uint8Array) => {
      carried.push(typeof data === 'string' ? data : [Number(new DataView(data.buffer).getBigUint64(0)), data.byteLength - 8]);
    },
    close: (code: number, reason: string) => { closes.push([code, reason]); },
  } as unknown as WebSocket;

  return { ws, carried, closes };
}

/** A link over a container connection the test drives: the bytes written into the container, what the link logged,
 *  and whether the vessel was told to forget it. */
function link() {
  const written: number[] = [];
  const logged: string[] = [];
  let forgotten = false;
  let inputClosed = false;
  const writer = {
    write: async (bytes: Uint8Array) => { written.push(...bytes); },
    close: async () => { inputClosed = true; },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;
  let push: ReadableStreamDefaultController<Uint8Array> | undefined;
  const container = new ReadableStream<Uint8Array>({ start: (controller) => { push = controller; } });
  const relayed = new Relayed(writer, (event) => { logged.push(event); }, () => { forgotten = true; });

  return { relayed, container, push: () => push, written, logged, forgotten: () => forgotten, inputClosed: () => inputClosed };
}

/** The peer's bytes from `offset`, as a binary message. */
function bytes(offset: number, values: number[]): ArrayBuffer {
  const message = new Uint8Array(8 + values.length);

  new DataView(message.buffer).setBigUint64(0, BigInt(offset));
  message.set(values, 8);

  return message.buffer;
}

const settled = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); };

describe('a relay link at its vessel', () => {
  test('stops reading the container past the window until the peer counts its bytes, then sends the rest', async () => {
    const { relayed, container, push } = link();
    const first = socket();
    const chunk = new Uint8Array(RELAY_WINDOW / 4);

    relayed.attach(first.ws);
    const pumped = relayed.pump(container);

    for (let index = 0; index < 8; index += 1) push()?.enqueue(chunk);
    await settled();
    const before = first.carried.length;

    await relayed.message(first.ws, `a${String(RELAY_WINDOW)}`);
    await settled();
    push()?.close();
    await pumped;

    // The attach counts nothing yet ('a0'); then five chunks, the window's worth and one, and after the count the rest.
    expect({ before, after: first.carried.length }).toEqual({ before: 6, after: 10 });
  });

  test('sends what the peer has not counted again on the WebSocket that replaces a dropped one, in order', async () => {
    const { relayed, container, push, logged } = link();
    const first = socket();
    const second = socket();

    relayed.attach(first.ws);
    void relayed.pump(container);
    push()?.enqueue(new Uint8Array(3));
    push()?.enqueue(new Uint8Array(4));
    await settled();
    await relayed.message(first.ws, 'a3');
    await relayed.closed(first.ws, 1006, 'WebSocket disconnected without sending Close frame.');
    push()?.enqueue(new Uint8Array(5));
    await settled();
    relayed.attach(second.ws);

    expect({ logged, first: first.carried, second: second.carried })
      .toEqual({ logged: ['relay link dropped'], first: ['a0', [0, 3], [3, 4]], second: [[3, 4], [7, 5], 'a0'] });
  });

  test('writes each of the peer\'s bytes once though a replacing WebSocket sends some again, and counts them back', async () => {
    const { relayed, written } = link();
    const first = socket();
    const second = socket();
    const half = RELAY_ACK / 2;

    relayed.attach(first.ws);
    await relayed.message(first.ws, bytes(0, [1, 2, 3]));
    relayed.attach(second.ws);
    // A late message on the replaced WebSocket is dropped, and the replayed bytes overlap those written.
    await relayed.message(first.ws, bytes(3, [4]));
    await relayed.message(second.ws, bytes(1, [2, 3, 4, 5]));
    await relayed.message(second.ws, bytes(5, new Array<number>(half).fill(6)));
    await relayed.message(second.ws, bytes(5 + half, new Array<number>(half).fill(7)));

    expect({ head: written.slice(0, 5), length: written.length, second: second.carried, first: first.closes })
      .toEqual({ head: [1, 2, 3, 4, 5], length: 5 + RELAY_ACK, second: ['a3', `a${String(5 + RELAY_ACK)}`], first: [[1000, 'replaced']] });
  });

  test('ends once both streams ended and each was counted, closing the container\'s input after the peer\'s last byte', async () => {
    const { relayed, container, push, inputClosed, forgotten } = link();
    const ws = socket();

    relayed.attach(ws.ws);
    void relayed.pump(container);
    push()?.enqueue(new Uint8Array(2));
    push()?.close();
    await settled();
    await relayed.message(ws.ws, 'e1');
    const early = inputClosed();

    await relayed.message(ws.ws, bytes(0, [9]));
    const input = inputClosed();
    const before = forgotten();

    await relayed.message(ws.ws, 'a2');

    expect({ early, input, before, after: forgotten(), closes: ws.closes }).toEqual({ early: false, input: true, before: false, after: true, closes: [[1000, 'done']] });
  });

  test('gives a dropped link RELAY_GRACE_MS to come back, then closes it and says so', async () => {
    const { relayed, logged, forgotten } = link();
    const ws = socket();

    vi.useFakeTimers();
    relayed.attach(ws.ws);
    await relayed.closed(ws.ws, 1006, '');
    vi.advanceTimersByTime(RELAY_GRACE_MS - 1);
    const waiting = forgotten();

    vi.advanceTimersByTime(1);
    vi.useRealTimers();

    expect({ waiting, logged, forgotten: forgotten() }).toEqual({ waiting: false, logged: ['relay link dropped', 'relay link ended'], forgotten: true });
  });
});
