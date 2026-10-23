import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE } from '../src/container';
import { accepted, controlled, gone, opened, passed, type Part, type Sockets } from '../src/pairing';
import { GANG_UP, RELAY_HEADER, RELAY_PY } from '../src/relay';

/** Both ends of a link in one relay.py process, as two ranks' relays: its control socket at its hub (`control`), an
 *  echo server on rank 0's address, and a program whose connection to the echo goes out through `carry`.
 *  The program sends `total` bytes of a pattern, closes its side and reads back until the far side closes, then prints
 *  how much came back and whether it was the pattern. With `hold`, it sends one byte and keeps its side open, as a
 *  client waiting for a server's greeting does, reading for 20 s at most. */
const RELAYS = String.raw`
import hashlib, socket, sys, threading
total, port, origin, mode, source = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.stdin.read()
hold = mode == "hold"
sys.argv = ["relay.py", "0", origin, "20261008000000-00000000", "token", "0", "1"]
relay = {"__name__": "relay"}
exec(source, relay)
carry, control, OWN = relay["carry"], relay["control"], relay["OWN"]
if mode == "outage":
    # The relay's clock twenty times fast, so an outage of a hub past a minute of it takes seconds here.
    import time
    class Fast:
        def __getattr__(self, name):
            return getattr(time, name)
        def monotonic(self):
            return time.monotonic() * 20
        def sleep(self, seconds):
            time.sleep(seconds / 20)
    relay["time"] = Fast()
threading.Thread(target=control, daemon=True).start()
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

/** What a hub's socket is in the harness: a control socket, or one end of a link. */
interface Opened {
  readonly kind: string;
  readonly link: string;
  readonly port: number;
  readonly resume: boolean;
  readonly accept: boolean;
}

/** What the harness's hub asks of a socket Bun serves: its data, to send, to close, and to drop without a Close. */
interface Served {
  readonly data: Opened;
  send(message: string | ArrayBuffer): unknown;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** The hub's sockets as Bun holds them: each one's part and tags beside it, as a hub's attachments keep them. */
class BunSockets implements Sockets<Served> {
  private readonly held = new Map<Served, { part: Part; readonly tags: readonly string[]; closed: boolean }>();

  tagged(tag: string): Served[] {
    return [...this.held].filter(([, held]) => !held.closed && held.tags.includes(tag)).map(([socket]) => socket);
  }

  part(socket: Served): Part {
    const held = this.held.get(socket);

    if (held === undefined) throw new Error('a socket the hub never took');

    return held.part;
  }

  take(socket: Served, part: Part, tags: readonly string[]): void {
    this.held.set(socket, { part, tags, closed: false });
  }

  mark(socket: Served, part: Part): void {
    const held = this.held.get(socket);

    if (held !== undefined) held.part = part;
  }

  send(socket: Served, message: string | ArrayBuffer): void {
    socket.send(message);
  }

  close(socket: Served, code: number, reason: string): void {
    this.gone(socket);
    socket.close(code, reason);
  }

  gone(socket: Served): void {
    const held = this.held.get(socket);

    if (held !== undefined) held.closed = true;
  }
}

/** A rank's hub over Bun's WebSockets, pairing as `ArmadaHub` does (`hub.ts`). Each time `dropAfter` more of a link's
 *  outbound bytes arrive, one end of its pair drops without a Close frame, the opening end's and then the other's in
 *  turn, as the network or a restarted hub drops them. `lost` resets the program's connection as `reset` does, and
 *  drops the socket that carries the link's cancellation before the hub passes it on. `outage` refuses the link's
 *  opens for 4.5 s after its first drop, as a hub coming back does, while the relay's clock runs twenty times fast:
 *  90 s of the relay's. */
async function run(total: number, port: string, dropAfter: number, sending: 'all' | 'hold' | 'reset' | 'lost' | 'outage' = 'all') {
  const reached = new Map<string, number>();
  const asked: string[] = [];
  const hub = new BunSockets();
  let drops = 0;
  let outageUntil = 0;

  const server = Bun.serve<Opened>({
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      const kind = url.pathname.split('/')[6] ?? '';
      const link = url.searchParams.get('id') ?? '';
      const [accept, resume] = [url.searchParams.has('accept'), url.searchParams.has('resume')];

      if (kind === 'link' && !accept) {
        if (resume && Date.now() < outageUntil) {
          asked.push('refused');

          return new Response('the hub is coming back', { status: 503 });
        }

        asked.push(resume ? 'resume' : 'open');
      }

      return bun.upgrade(request, { data: { kind, link, port: Number(url.searchParams.get('port')), resume, accept } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === 'control') controlled(hub, ws);
        else if (ws.data.accept) accepted(hub, ws, ws.data.link);
        else opened(hub, ws, ws.data);
      },
      message(ws, message) {
        if (sending === 'lost' && message === 'g' && drops === 0) {
          drops += 1;
          ws.terminate();

          return;
        }

        const bytes = typeof message === 'string' ? null : message;

        if (bytes !== null && ws.data.kind === 'link' && !ws.data.accept) {
          const before = reached.get(ws.data.link) ?? 0;
          const end = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0)) + bytes.byteLength - 8;

          reached.set(ws.data.link, Math.max(before, end));

          if (Math.floor(Math.max(before, end) / dropAfter) > Math.floor(before / dropAfter)) {
            drops += 1;

            if (sending === 'outage' && drops === 1) outageUntil = Date.now() + 4500;
            const dropped = drops % 2 === 0 ? hub.tagged(`in:${ws.data.link}`)[0] ?? ws : ws;

            dropped.terminate();

            return;
          }
        }

        passed(hub, ws, bytes === null ? String(message) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      close(ws) {
        hub.gone(ws);
        gone(hub, ws);
      },
    },
  });

  const relays = Bun.spawn(['python3', '-c', RELAYS, String(total), port, `http://127.0.0.1:${String(server.port)}`, sending === 'lost' ? 'reset' : sending],
    { stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe' });

  const [out, err] = await Promise.all([new Response(relays.stdout).text(), new Response(relays.stderr).text(), relays.exited]);

  await server.stop(true);

  return { out: out.trim(), opened: asked, drops, err };
}

describe('a relay link between two relay.py ends through a hub', () => {
  test('carries a program\'s bytes there and back whole, and ends when both sides closed', async () => {
    const result = await run(8 << 20, 'echo', Number.POSITIVE_INFINITY);

    // Neither end waits for the other once both are done.
    expect({ out: result.out, opened: result.opened, err: result.err }).toEqual({ out: `${String(8 << 20)} True`, opened: ['open'], err: '' });
  }, 60_000);

  test('carries on over the next pair of WebSockets each time either end of one drops, unseen by the program', async () => {
    const result = await run(16 << 20, 'echo', 3 << 20);

    expect({ out: result.out, first: result.opened[0], resumed: result.opened.slice(1), drops: result.drops > 3 })
      .toEqual({ out: `${String(16 << 20)} True`, first: 'open', resumed: Array.from({ length: result.opened.length - 1 }, () => 'resume'), drops: true });
  }, 60_000);

  // A vessel's object reset by a storage failure kept a CI gang's link from coming back for longer than a minute.
  test('carries on over a WebSocket that comes back only after its vessel was out for longer than a minute', async () => {
    const result = await run(6 << 20, 'echo', 4 << 20, 'outage');

    // Each failed open is said with its status, and the open that came back with how many failed before it.
    const failed = result.err.split('\n').filter((line) => / open \d+ failed: HTTP\/1\.1 503/u.test(line));

    expect({ out: result.out, refused: result.opened.includes('refused'), last: result.opened.at(-1), said: failed.length > 0,
      back: / a WebSocket again after \d+ failed$/mu.test(result.err) })
      .toEqual({ out: `${String(6 << 20)} True`, refused: true, last: 'resume', said: true, back: true });
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

describe('a gang\'s relay replaced in its container', () => {
  test('is the one serving the next gang, even when the last relay has not let go of its ports yet', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-gang-up-'));
    const bin = join(scratch, 'bin');
    const pids: number[] = [];
    // The hub the relays dial: each control socket's gang token, as it presents it.
    const tokens: string[] = [];

    const hub = Bun.serve({
      port: 0,
      fetch(request, bun) {
        tokens.push(request.headers.get(RELAY_HEADER) ?? '');

        return bun.upgrade(request) ? undefined : new Response('no', { status: 400 });
      },
      websocket: { message() { /* a control socket's pings alone */ } },
    });

    // The privileged network setup is the platform's: only it is stubbed; the scripts and the relay are real.
    mkdirSync(bin);

    for (const command of ['hostname', 'iptables', 'mount', 'umount']) writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(scratch, 'relay.py'), RELAY_PY);

    const up = async (token: string) => {
      const setup = Bun.spawn(['/bin/sh', '-c', GANG_UP.replaceAll(STATE, scratch), 'gang', '0', '2', `http://127.0.0.1:${String(hub.port)}`, 'job', token, '0', '1'], {
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

      // The next gang's relay is the one at the hub: its control socket presents the next gang's token.
      for (let waited = 0; !tokens.includes('b'.repeat(48)) && waited < 2000; waited += 50) await Bun.sleep(50);

      expect({ first, second, replaced, served: tokens.includes('b'.repeat(48)) }).toEqual({ first: 0, second: 0, replaced: true, served: true });
    } finally {
      for (const pid of pids) if (!(await exited(pid, false))) process.kill(pid, 'SIGKILL');

      await hub.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
