import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import * as v from 'valibot';
import { STATE } from '../src/container';
import { GANG_UP, Piped, RELAY_IN, RELAY_PY } from '../src/relay';

/** Both ends of a link in one relay.py process, as two ranks' relays: the inbound end's server on a free port (printed
 *  first), an echo server on rank 0's address, and a program whose connection to the echo goes out through `carry`.
 *  The program sends `total` bytes of a pattern, closes its side and reads back until the far side closes, then prints
 *  how much came back and whether it was the pattern. With `hold`, it sends one byte and keeps its side open, as a
 *  client waiting for a server's greeting does, reading for 20 s at most. */
const RELAYS = String.raw`
import hashlib, socket, sys, threading
total, port, origin, mode, source = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.stdin.read()
hold = mode == "hold"
sys.argv = ["relay.py", "0", origin, "20261008000000-00000000", "token", "v1"]
relay = {"__name__": "relay"}
exec(source, relay)
carry, guarded, inbound, OWN = relay["carry"], relay["guarded"], relay["inbound"], relay["OWN"]
if mode == "outage":
    # The relay's clock twenty times fast, so an outage of its vessel past a minute of it takes seconds here.
    import time
    class Fast:
        def __getattr__(self, name):
            return getattr(time, name)
        def monotonic(self):
            return time.monotonic() * 20
        def sleep(self, seconds):
            time.sleep(seconds / 20)
    relay["time"] = Fast()
server = socket.create_server(("127.0.0.1", 0))
print(server.getsockname()[1], flush=True)
threading.Thread(target=lambda: [threading.Thread(target=guarded, args=(inbound, server.accept()[0]), daemon=True).start()
                                 for _ in iter(int, 1)], daemon=True).start()
echo = socket.create_server((OWN, 0))
answered = threading.Event()
def answer(conn):
    try:
        while data := conn.recv(1 << 16):
            conn.sendall(data)
        conn.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    answered.set()
threading.Thread(target=lambda: [threading.Thread(target=answer, args=(echo.accept()[0],), daemon=True).start()
                                 for _ in iter(int, 1)], daemon=True).start()
# A server that sends until its connection goes, whatever it is sent: a feed, say.
feed = socket.create_server((OWN, 0))
def stream(conn):
    try:
        while True:
            conn.sendall(b"f" * (1 << 16))
    except OSError:
        pass
    answered.set()
threading.Thread(target=lambda: [threading.Thread(target=stream, args=(feed.accept()[0],), daemon=True).start()
                                 for _ in iter(int, 1)], daemon=True).start()
program, relayed = socket.socketpair()
target = {"echo": echo.getsockname()[1], "feed": feed.getsockname()[1]}.get(port) or int(port)
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
if mode == "reset":
    # The program reads a little of the feed, then its connection goes while the feed still sends.
    program.recv(1 << 16)
    program.close()
    print("feed ended", answered.wait(15), flush=True)
    sys.exit(0)
program.settimeout(20)
got, size = hashlib.sha256(), 0
while data := program.recv(1 << 20):
    got.update(data)
    size += len(data)
print(size, got.hexdigest() == hashlib.sha256(block * (total // len(block))).hexdigest(), flush=True)
`;

/** A vessel's relay route over Bun's WebSockets and a TCP connection into the inbound end, each WebSocket piped
 *  (`Piped`) as a vessel pipes it. Each time `dropAfter` more of a link's outbound bytes arrive, its WebSocket drops
 *  without a Close frame, and every other time its connection in is cut too, as a vessel reset cuts it. `lost` resets
 *  the program's connection as `reset` does, and drops the WebSocket that carries the link's cancellation before the
 *  vessel passes it on. `outage` refuses the link's opens for 4.5 s after its first drop, as a vessel whose object a
 *  storage failure reset refuses them, while the relay's clock runs twenty times fast: 90 s of the relay's. */
async function run(total: number, port: string, dropAfter: number, sending: 'all' | 'hold' | 'reset' | 'lost' | 'outage' = 'all') {
  const reached = new Map<string, number>();
  const opened: string[] = [];
  let drops = 0;
  let inPort = 0;
  let outageUntil = 0;

  const server = Bun.serve<{ readonly link: string; readonly id: string; piped?: Piped; cut?: () => void }>({
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      const resume = url.searchParams.has('resume');

      if (resume && Date.now() < outageUntil) {
        opened.push('refused');

        return new Response('the vessel is resetting', { status: 503 });
      }

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
        if (sending === 'lost' && message === 'g' && drops === 0) {
          drops += 1;
          ws.terminate();

          return;
        }

        const before = reached.get(ws.data.id) ?? 0;
        const bytes = message instanceof Uint8Array ? message : null;
        const end = bytes === null ? before : Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0)) + bytes.byteLength - 8;

        reached.set(ws.data.id, Math.max(before, end));
        await ws.data.piped?.message(bytes === null ? String(message) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

        if (Math.floor(Math.max(before, end) / dropAfter) > Math.floor(before / dropAfter)) {
          drops += 1;
          if (sending === 'outage' && drops === 1) outageUntil = Date.now() + 4500;

          if (drops % 2 === 0) ws.data.cut?.();
          ws.terminate();
        }
      },
      async close(ws, code, reason) {
        await ws.data.piped?.closed(code, reason);
      },
    },
  });

  const relays = Bun.spawn(['python3', '-c', RELAYS, String(total), port, `http://127.0.0.1:${String(server.port)}`, sending === 'lost' ? 'reset' : sending],
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

  // A vessel's object reset by a storage failure kept a CI gang's link from coming back for longer than a minute.
  test('carries on over a WebSocket that comes back only after its vessel was out for longer than a minute', async () => {
    const result = await run(6 << 20, 'echo', 4 << 20, 'outage');

    expect({ out: result.out, refused: result.opened.includes('refused'), last: result.opened.at(-1) })
      .toEqual({ out: `${String(6 << 20)} True`, refused: true, last: 'resume' });
  }, 60_000);

  test('closes a program\'s connection to a port nothing listens on, as a refused one', async () => {
    const result = await run(1 << 16, '1', Number.POSITIVE_INFINITY);

    expect({ out: result.out, said: result.err.includes('holds no such link') }).toEqual({ out: '0 False', said: true });
  }, 60_000);

  test('ends the link at both ends when the program\'s connection goes while bytes still come for it', async () => {
    const result = await run(0, 'feed', Number.POSITIVE_INFINITY, 'reset');

    expect(result.out).toBe('feed ended True');
  }, 60_000);

  test('ends both sides even if its carrier drops while cancellation is in flight', async () => {
    const result = await run(0, 'feed', Number.POSITIVE_INFINITY, 'lost');

    expect({ out: result.out, drops: result.drops }).toEqual({ out: 'feed ended True', drops: 1 });
  }, 60_000);

  test('closes it at once while the program still holds its side open, waiting for a greeting', async () => {
    // Nothing comes back, and the program's read ends rather than waiting out its 20 s.
    const result = await run(0, '1', Number.POSITIVE_INFINITY, 'hold');

    expect({ out: result.out, said: result.err.includes('holds no such link'), timedOut: result.err.includes('timed out') })
      .toEqual({ out: '0 True', said: true, timedOut: false });
  }, 60_000);
});

/** Whether process `pid` has exited, waited for when `wait`, by Linux's process-exit event. */
async function exited(pid: number, wait: boolean): Promise<boolean> {
  const waiting = Bun.spawn(['python3', '-c', String.raw`import os, select, sys
try:
    fd = os.pidfd_open(int(sys.argv[1]))
except ProcessLookupError:
    sys.exit(0)
ready = select.select([fd], [], [], None if sys.argv[2] == "wait" else 0)[0]
sys.exit(0 if ready else 1)
`, String(pid), wait ? 'wait' : 'poll']);

  return await waiting.exited === 0;
}

/** Whether a relay's inbound port answers a link to `port` on rank 0's address, as a vessel's pipe opens one, with
 *  what is served there. */
async function greeted(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(RELAY_IN, '127.0.0.1');
  let bytes = Buffer.alloc(0);

  const finish = (value: boolean) => {
    socket.destroy();
    resolve(value);
  };

  socket.setTimeout(2000, () => { finish(false); });
  socket.on('connect', () => { socket.write(`${'0'.repeat(16)} ${String(port)} 0\n`); });
  socket.on('error', () => { finish(false); });
  socket.on('end', () => { finish(false); });
  // Records as `Piped` carries them: a kind, a length, a body; a data record's body is its offset, then its bytes.
  socket.on('data', (data: Buffer) => {
    bytes = Buffer.concat([bytes, data]);

    while (bytes.length >= 5 && bytes.length >= bytes.readUInt32BE(1) + 5) {
      const size = bytes.readUInt32BE(1);
      const [kind] = bytes;
      const body = bytes.subarray(5, 5 + size);

      bytes = bytes.subarray(5 + size);

      if (kind === 0x62) return finish(body.subarray(8).toString() === 'ready');
    }
  });

  return await promise;
}

describe('a gang\'s relay replaced in its container', () => {
  test('is the one serving the next gang, even when the last relay has not let go of its ports yet', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-gang-up-'));
    const bin = join(scratch, 'bin');
    const pids: number[] = [];
    const server = createServer((socket) => { socket.end('ready'); });
    const listening = Promise.withResolvers<void>();

    // The privileged network setup is the platform's: only it is stubbed; the scripts and the relay are real.
    mkdirSync(bin);

    for (const command of ['hostname', 'iptables', 'mount', 'umount']) writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(scratch, 'relay.py'), RELAY_PY);
    // Rank 0's address, where the relay connects a link's port.
    server.listen(0, '127.0.1.1', listening.resolve);
    await listening.promise;
    const { port } = v.parse(v.object({ port: v.number() }), server.address());

    const up = async (token: string) => {
      const setup = Bun.spawn(['/bin/sh', '-c', GANG_UP.replaceAll(STATE, scratch), 'gang', '0', '2', 'https://armada.test', 'job', token, 'v1', 'v2'], {
        env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` }, stdout: 'ignore', stderr: 'pipe',
      });

      const exitCode = await setup.exited;

      pids.push(Number(readFileSync(join(scratch, 'relay.pid'), 'utf8')));

      return exitCode;
    };

    try {
      const first = await up('a'.repeat(48));
      const [old] = pids;

      // The last gang's relay still holds its ports when the next gang's setup starts.
      if (old !== undefined) process.kill(old, 'SIGSTOP');
      const second = await up('b'.repeat(48));
      const replaced = old !== undefined && await exited(old, false);

      expect({ first, second, replaced, served: await greeted(port) }).toEqual({ first: 0, second: 0, replaced: true, served: true });
    } finally {
      for (const pid of pids) if (!(await exited(pid, false))) process.kill(pid, 'SIGKILL');

      server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
