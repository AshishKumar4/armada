import { describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { Writable } from 'node:stream';
import { Piped, RELAY_PY } from '../src/relay';

/** Both ends of a link in one relay.py process, as two ranks' relays: the inbound end's server on a free port (printed
 *  first), an echo server on rank 0's address, and a program whose connection to the echo goes out through `carry`.
 *  The program sends `total` bytes of a pattern, closes its side and reads back until the far side closes, then prints
 *  how much came back and whether it was the pattern. With `hold`, it sends one byte and keeps its side open, as a
 *  client waiting for a server's greeting does, reading for 20 s at most. */
const RELAYS = String.raw`
import hashlib, socket, sys, threading
total, port, origin, hold, source = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4] == "hold", sys.stdin.read()
sys.argv = ["relay.py", "0", origin, "20261008000000-00000000", "token", "v1"]
relay = {"__name__": "relay"}
exec(source, relay)
carry, guarded, inbound, OWN = relay["carry"], relay["guarded"], relay["inbound"], relay["OWN"]
server = socket.create_server(("127.0.0.1", 0))
print(server.getsockname()[1], flush=True)
threading.Thread(target=lambda: [threading.Thread(target=guarded, args=(inbound, server.accept()[0]), daemon=True).start()
                                 for _ in iter(int, 1)], daemon=True).start()
echo = socket.create_server((OWN, 0))
def answer(conn):
    while data := conn.recv(1 << 16):
        conn.sendall(data)
    conn.shutdown(socket.SHUT_WR)
threading.Thread(target=lambda: [threading.Thread(target=answer, args=(echo.accept()[0],), daemon=True).start()
                                 for _ in iter(int, 1)], daemon=True).start()
program, relayed = socket.socketpair()
target = echo.getsockname()[1] if port == "echo" else int(port)
threading.Thread(target=carry, args=(relayed, 0, target), daemon=True).start()
block = hashlib.sha256(b"link").digest() * 2048
def write():
    if hold:
        program.sendall(b"e")
        return
    for _ in range(total // len(block)):
        program.sendall(block)
    program.shutdown(socket.SHUT_WR)
threading.Thread(target=write, daemon=True).start()
program.settimeout(20)
got, size = hashlib.sha256(), 0
while data := program.recv(1 << 20):
    got.update(data)
    size += len(data)
print(size, got.hexdigest() == hashlib.sha256(block * (total // len(block))).hexdigest(), flush=True)
`;

/** A vessel's relay route over Bun's WebSockets and a TCP connection into the inbound end, each WebSocket piped
 *  (`Piped`) as a vessel pipes it. Each time `dropAfter` more of a link's outbound bytes arrive, its WebSocket drops
 *  without a Close frame, and every other time its connection in is cut too, as a vessel reset cuts it. */
async function run(total: number, port: string, dropAfter: number, sending: 'all' | 'hold' = 'all') {
  const reached = new Map<string, number>();
  const opened: string[] = [];
  let drops = 0;
  let inPort = 0;

  const server = Bun.serve<{ readonly link: string; readonly id: string; piped?: Piped; cut?: () => void }>({
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      const resume = url.searchParams.has('resume');

      opened.push(resume ? 'resume' : 'open');

      const id = url.searchParams.get('id') ?? '';
      const link = `${id} ${url.searchParams.get('port') ?? ''} ${resume ? '1' : '0'}`;

      return bun.upgrade(request, { data: { link, id } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        const tcp = connect(inPort, '127.0.0.1');

        ws.data.piped = new Piped(ws, Writable.toWeb(tcp).getWriter(), ws.data.link, () => undefined);
        ws.data.cut = () => { tcp.destroy(); };

        ws.data.piped.start(new ReadableStream<Uint8Array>({
          start: (controller) => {
            tcp.on('data', (chunk: Buffer) => { controller.enqueue(new Uint8Array(chunk)); });
            tcp.on('end', () => { controller.close(); });
            tcp.on('error', (error) => { controller.error(error); });
          },
        }));
      },
      async message(ws, message) {
        const before = reached.get(ws.data.id) ?? 0;
        const bytes = message instanceof Uint8Array ? message : null;
        const end = bytes === null ? before : Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0)) + bytes.byteLength - 8;

        reached.set(ws.data.id, Math.max(before, end));
        await ws.data.piped?.message(bytes === null ? String(message) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

        if (Math.floor(Math.max(before, end) / dropAfter) > Math.floor(before / dropAfter)) {
          drops += 1;

          if (drops % 2 === 0) ws.data.cut?.();
          ws.terminate();
        }
      },
      async close(ws, code, reason) {
        await ws.data.piped?.closed(code, reason);
      },
    },
  });

  const relays = Bun.spawn(['python3', '-c', RELAYS, String(total), port, `http://127.0.0.1:${String(server.port)}`, sending],
    { stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe' });

  const [out, err] = await Promise.all([(async () => {
    let text = '';

    for await (const chunk of relays.stdout.pipeThrough(new TextDecoderStream())) {
      text += chunk;
      inPort ||= Number(text.split('\n')[0]);
    }

    return text.split('\n').slice(1).join('\n');
  })(), new Response(relays.stderr).text(), relays.exited]);

  await server.stop(true);

  return { out: out.trim(), opened, drops, err };
}

describe('a relay link between two relay.py ends through a vessel\'s pipe', () => {
  test('carries a program\'s bytes there and back whole, and ends when both sides closed', async () => {
    const result = await run(8 << 20, 'echo', Number.POSITIVE_INFINITY);

    // Neither end waits for the other once both are done.
    expect({ out: result.out, opened: result.opened, err: result.err }).toEqual({ out: `${String(8 << 20)} True`, opened: ['open'], err: '' });
  }, 60_000);

  test('carries on over the next WebSocket each time one drops or the vessel\'s connection in is cut, unseen by the program', async () => {
    const result = await run(16 << 20, 'echo', 3 << 20);

    expect({ out: result.out, first: result.opened[0], resumed: result.opened.slice(1), drops: result.drops > 3 })
      .toEqual({ out: `${String(16 << 20)} True`, first: 'open', resumed: Array.from({ length: result.opened.length - 1 }, () => 'resume'), drops: true });
  }, 60_000);

  test('closes a program\'s connection to a port nothing listens on, as a refused one', async () => {
    const result = await run(1 << 16, '1', Number.POSITIVE_INFINITY);

    expect({ out: result.out, said: result.err.includes('holds no such link') }).toEqual({ out: '0 False', said: true });
  }, 60_000);

  test('closes it at once while the program still holds its side open, waiting for a greeting', async () => {
    // Nothing comes back, and the program's read ends rather than waiting out its 20 s.
    const result = await run(0, '1', Number.POSITIVE_INFINITY, 'hold');

    expect({ out: result.out, said: result.err.includes('holds no such link'), timedOut: result.err.includes('timed out') })
      .toEqual({ out: '0 True', said: true, timedOut: false });
  }, 60_000);
});
