import { describe, expect, test } from 'bun:test';
import { Piped } from '../src/relay';

/** A record as the container's relay writes one: a kind byte, the length in 4 bytes, big endian, and the bytes. */
function record(kind: 't' | 'b', bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + bytes.byteLength);

  out[0] = kind.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, bytes.byteLength);
  out.set(bytes, 5);

  return out;
}

/** A pipe between a WebSocket and a container connection the test drives: what went each way, and how it closed. */
function pipe() {
  const messages: (string | number[])[] = [];
  const closes: [number, string][] = [];
  const written: number[][] = [];
  const logged: string[] = [];
  let inputClosed = false;

  const socket = {
    send: (data: string | Uint8Array) => { messages.push(data instanceof Uint8Array ? [...data] : data); },
    close: (code?: number, reason?: string) => { closes.push([code ?? 1005, reason ?? '']); },
  };

  const writer = {
    write: async (bytes?: Uint8Array) => { written.push([...bytes ?? []]); },
    close: async () => { inputClosed = true; },
  };

  let push: ReadableStreamDefaultController<Uint8Array> | undefined;
  const container = new ReadableStream<Uint8Array>({ start: (controller) => { push = controller; } });
  const piped = new Piped(socket, writer, 'abcd 9000 1', (event) => { logged.push(event); });

  return { piped, container, push: () => push, messages, closes, written, logged, inputClosed: () => inputClosed };
}

describe('a relay WebSocket at its vessel', () => {
  test('names the link to the container first, then writes each message as a record, in order', async () => {
    const { piped, written } = pipe();

    await Promise.all([piped.message('a5'), piped.message(new Uint8Array([1, 2, 3]).buffer)]);

    expect(written).toEqual([[...new TextEncoder().encode('abcd 9000 1\n')], [...record('t', new TextEncoder().encode('a5'))],
      [...record('b', new Uint8Array([1, 2, 3]))]]);
  });

  test('sends each record from the container as a message once it is whole, however the reads split it', async () => {
    const { piped, container, push, messages, closes } = pipe();
    const stream = new Uint8Array([...record('b', new Uint8Array([7, 8, 9])), ...record('t', new TextEncoder().encode('e3'))]);
    piped.start(container);

    for (const at of [0, 2, 6, 9]) push()?.enqueue(stream.slice(at, [2, 6, 9, stream.byteLength][[0, 2, 6, 9].indexOf(at)]));
    push()?.close();
    await piped.pumped;

    expect({ messages, closes }).toEqual({ messages: [[7, 8, 9], 'e3'], closes: [[1000, 'the container closed it']] });
  });

  test('closes the container\'s connection after what was written when its WebSocket closes, and says why if not cleanly', async () => {
    const clean = pipe();
    const dropped = pipe();

    await clean.piped.message('a1');
    await clean.piped.closed(1000, '');
    await dropped.piped.closed(1006, 'WebSocket disconnected without sending Close frame.');

    expect([clean.inputClosed(), clean.written.length, clean.logged, dropped.inputClosed(), dropped.logged])
      .toEqual([true, 2, [], true, ['relay WebSocket closed by its relay']]);
  });
});
