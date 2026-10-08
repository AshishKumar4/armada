import { describe, expect, test } from 'bun:test';
import { RELAY_PY, Relayed } from '../src/relay';

/** The container's end of relay.py's `Link`, as a program sees it: it sends `bytes` of a fixed pattern on its
 *  connection, closes its side, reads back until the far end closes, and prints how much came back and whether it
 *  was the pattern. relay.py runs without its servers, its Link over a socket pair. */
const PROGRAM = String.raw`
import hashlib, socket, sys, threading
total, origin, source = int(sys.argv[1]), sys.argv[2], sys.stdin.read()
sys.argv = ["relay.py", "0", origin, "20261008000000-00000000", "token", "v1"]
exec(source.rsplit("threading.Thread(target=serve", 1)[0])
program, relayed = socket.socketpair()
threading.Thread(target=Link(relayed, 0, 9000).run, daemon=True).start()
block = hashlib.sha256(b"link").digest() * 2048
def write():
    for _ in range(total // len(block)):
        program.sendall(block)
    program.shutdown(socket.SHUT_WR)
threading.Thread(target=write, daemon=True).start()
got = hashlib.sha256()
size = 0
while data := program.recv(1 << 20):
    got.update(data)
    size += len(data)
expected = hashlib.sha256(block * (total // len(block))).hexdigest()
print(size, got.hexdigest() == expected, flush=True)
`;

/** A vessel's relay route over Bun's WebSockets, the container an echo: each link's input comes back as its output.
 *  A link's WebSocket drops without a Close frame each time `dropAfter` more of the link's bytes have arrived. */
function vessel(dropAfter: number) {
  const links = new Map<string, Relayed>();
  const reached = new Map<string, number>();
  const opened: string[] = [];
  const server = Bun.serve<{ readonly id: string }>({
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      const id = url.searchParams.get('id') ?? '';

      opened.push(url.searchParams.has('resume') ? 'resume' : 'open');

      if (!links.has(id) && url.searchParams.has('resume')) return new Response('the link is gone', { status: 410 });

      return bun.upgrade(request, { data: { id } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        let relayed = links.get(ws.data.id);

        if (relayed === undefined) {
          const echo = new TransformStream<Uint8Array, Uint8Array>();

          relayed = new Relayed(echo.writable.getWriter(), () => undefined, () => { links.delete(ws.data.id); });
          links.set(ws.data.id, relayed);
          void relayed.pump(echo.readable);
        }
        relayed.attach(ws as unknown as WebSocket);
      },
      async message(ws, message) {
        const before = reached.get(ws.data.id) ?? 0;
        const end = typeof message === 'string' ? before : Number(new DataView(message.buffer, message.byteOffset).getBigUint64(0)) + message.byteLength - 8;

        reached.set(ws.data.id, Math.max(before, end));
        await links.get(ws.data.id)?.message(ws as unknown as WebSocket,
          typeof message === 'string' ? message : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer);

        if (Math.floor(Math.max(before, end) / dropAfter) > Math.floor(before / dropAfter)) ws.terminate();
      },
      async close(ws, code, reason) {
        await links.get(ws.data.id)?.closed(ws as unknown as WebSocket, code, reason);
      },
    },
  });

  return { server, opened, links };
}

async function run(total: number, dropAfter: number) {
  const { server, opened, links } = vessel(dropAfter);
  const program = Bun.spawn(['python3', '-c', PROGRAM, String(total), `http://127.0.0.1:${String(server.port)}`], { stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(program.stdout).text(), new Response(program.stderr).text(), program.exited]);

  await server.stop(true);

  return { out: out.trim(), opened, open: links.size, err };
}

describe('a relay link between relay.py and a vessel', () => {
  test('carries a program\'s bytes there and back whole, and ends when both sides closed', async () => {
    const result = await run(8 << 20, Number.POSITIVE_INFINITY);

    expect({ out: result.out, opened: result.opened, open: result.open }).toEqual({ out: `${String(8 << 20)} True`, opened: ['open'], open: 0 });
  }, 60_000);

  test('opens another WebSocket under the link\'s id each time one drops mid-stream, and the program sees nothing of it', async () => {
    const result = await run(16 << 20, 3 << 20);

    expect({ out: result.out, first: result.opened[0], resumed: result.opened.length > 3, only: new Set(result.opened.slice(1)), open: result.open })
      .toEqual({ out: `${String(16 << 20)} True`, first: 'open', resumed: true, only: new Set(['resume']), open: 0 });
  }, 60_000);
});
