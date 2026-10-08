/**
 * A gang's network. Containers have outbound internet and no inbound address, and a Durable Object can open TCP into
 * its own container (`getTcpPort`). So each rank r of a gang is host `rank<r>` at 127.0.1.<r + 1> in every container,
 * and a connection to another rank's address goes: a DNAT to this relay's OUT port, a WebSocket to the Worker's
 * `/relay/<job>/<vessel>` (`relayed`), that rank's vessel, which opens the relay's IN port in its container and names
 * the port, and a connection there to the port on the rank's own address. Any TCP a program speaks runs over it
 * unchanged: jax.distributed's coordinator, gloo's collectives, a database.
 *
 * Each connection is a link (`Relayed`, `Link` in relay.py): numbered bytes, counted back so neither end runs more
 * than RELAY_WINDOW ahead (a WebSocket send never waits, and a fast sender would pile a collective's ring step into the
 * vessel's memory), and kept until counted, so a WebSocket the network drops is replaced without the program seeing it.
 */
import { STATE } from './container';

/** Where a rank's peers' connections arrive (loopback, DNAT'd to) and where its vessel connects in (every address). */
export const RELAY_OUT = 7911;

export const RELAY_IN = 7912;

/** The relay's script in a container, and its log: how each of its links dropped or ended. */
export const RELAY = `${STATE}/relay.py`;

export const RELAY_LOG = `${STATE}/relay.log`;

/** The header a relay's WebSocket presents the gang's token in. */
export const RELAY_HEADER = 'armada-relay';

/** The bytes either end of a relay link may have sent and not yet had counted. */
export const RELAY_WINDOW = 4 << 20;

/** How often, in bytes taken, each end counts them back to the other. */
export const RELAY_ACK = 1 << 20;

/** How long a vessel holds a link whose WebSocket dropped for its relay to open another. */
export const RELAY_GRACE_MS = 60_000;

/** A link's id: the relay names each connection it carries, and opens another WebSocket under it after a drop. */
export const LINK_ID = /^[0-9a-f]{16}$/u;

/**
 * One relay link at its vessel: a connection into the container's relay, carried by the peer relay's WebSocket and by
 * the next one after a drop. Each end numbers its bytes: a binary message is its first byte's offset (8 bytes, big
 * endian) and the bytes; `a<n>` counts the first n of the other end's bytes taken, every RELAY_ACK; `e<n>` ends this
 * end's stream at n. Each end keeps what the other has not counted, at most RELAY_WINDOW past it, sends it again on a
 * new WebSocket, and drops what it already took. A clean close (1000) ends the link; a drop leaves it RELAY_GRACE_MS
 * to come back. `log` says how it ended; `forget` lets the vessel drop it.
 */
export class Relayed {
  private socket: WebSocket | undefined;

  private read = 0;

  private acked = 0;

  private readonly kept: { readonly offset: number; readonly bytes: Uint8Array }[] = [];

  private ended: number | undefined;

  private written = 0;

  private reported = 0;

  private peerEnded: number | undefined;

  private closedInput = false;

  private resume: (() => void) | undefined;

  private grace: ReturnType<typeof setTimeout> | undefined;

  private over = false;

  private queue = Promise.resolve();

  constructor(private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly log: (event: string, detail: Record<string, unknown>) => void, private readonly forget: () => void) {}

  /** `socket` carries the link from now: what the peer has not counted goes again, then where each stream stands. */
  attach(socket: WebSocket): void {
    const earlier = this.socket;

    this.socket = socket;
    if (this.grace !== undefined) clearTimeout(this.grace);

    if (earlier !== undefined && earlier !== socket) earlier.close(1000, 'replaced');
    for (const { offset, bytes } of this.kept) this.send(offset, bytes);

    if (this.ended !== undefined) socket.send(`e${String(this.ended)}`);
    socket.send(`a${String(this.written)}`);
  }

  /** The container's bytes to the peer, waiting while RELAY_WINDOW of them are uncounted, then their end. */
  async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();

    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        this.kept.push({ offset: this.read, bytes: read.value });
        this.send(this.read, read.value);
        this.read += read.value.byteLength;

        while (this.read - this.acked > RELAY_WINDOW && !this.over) {
          const { promise, resolve } = Promise.withResolvers<void>();

          this.resume = resolve;
          await promise;
        }

        if (this.over) return;
      }
      this.ended = this.read;
      this.socket?.send(`e${String(this.ended)}`);
      this.settle();
    } catch (error) {
      this.end(1011, `the container's side failed: ${String(error)}`);
    }
  }

  /** A message on `socket`: a count or end of the peer's, taken at once, or bytes for the container, written in the
   *  order they came though the runtime hands over the next message while a write waits. A count must not wait behind
   *  a write: the container may be waiting on this link to send before it reads again. */
  async message(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (socket !== this.socket || this.over) return;

    if (typeof message === 'string') {
      const count = Number(message.slice(1));

      if (message.startsWith('a')) {
        this.acked = Math.max(this.acked, count);

        while (this.kept[0] !== undefined && this.kept[0].offset + this.kept[0].bytes.byteLength <= this.acked) this.kept.shift();
        this.resume?.();
      } else if (message.startsWith('e')) {
        this.peerEnded = count;
        await this.closeInput();
      }
      this.settle();

      return;
    }
    this.queue = this.queue.then(async () => { await this.write(message); });
    await this.queue;
  }

  /** The peer's bytes from the message's offset into the container, less those already written. */
  private async write(message: ArrayBuffer): Promise<void> {
    if (this.over) return;
    const offset = Number(new DataView(message).getBigUint64(0));
    const bytes = new Uint8Array(message, 8);
    const skip = this.written - offset;

    if (skip < 0) return this.end(1011, `the peer skipped from byte ${String(this.written)} to ${String(offset)}`);

    if (skip < bytes.byteLength) {
      try {
        await this.writer.write(bytes.subarray(skip));
      } catch (error) {
        return this.end(1011, `the container's side failed: ${String(error)}`);
      }
      this.written += bytes.byteLength - skip;
    }

    if (this.written - this.reported >= RELAY_ACK) {
      this.reported = this.written;
      this.socket?.send(`a${String(this.written)}`);
    }
    await this.closeInput();
    this.settle();
  }

  /** `socket` closed: cleanly, the link is over; else it dropped, and the peer has RELAY_GRACE_MS to come back. */
  async closed(socket: WebSocket, code: number, reason: string): Promise<void> {
    if (socket !== this.socket || this.over) return;
    this.socket = undefined;

    if (code === 1000) return this.end(1000, reason);
    this.log('relay link dropped', { code, reason, ...this.counts() });
    this.grace = setTimeout(() => { this.end(1011, 'its peer did not come back'); }, RELAY_GRACE_MS);
  }

  private send(offset: number, bytes: Uint8Array): void {
    if (this.socket === undefined) return;
    const message = new Uint8Array(8 + bytes.byteLength);

    new DataView(message.buffer).setBigUint64(0, BigInt(offset));
    message.set(bytes, 8);
    this.socket.send(message);
  }

  /** The container's input closes once the peer's stream ended and every byte of it is written. */
  private async closeInput(): Promise<void> {
    if (this.closedInput || this.peerEnded === undefined || this.written < this.peerEnded) return;
    this.closedInput = true;
    await this.writer.close().catch(() => undefined);
  }

  /** Both streams ended and each counted: the link is done. */
  private settle(): void {
    if (this.ended !== undefined && this.acked >= this.ended && this.closedInput) this.end(1000, 'done');
  }

  private end(code: number, reason: string): void {
    if (this.over) return;
    this.over = true;
    if (this.grace !== undefined) clearTimeout(this.grace);

    if (code !== 1000 || reason !== 'done') this.log('relay link ended', { code, reason, ...this.counts() });
    this.socket?.close(code, reason.slice(0, 120));
    this.resume?.();
    void this.writer.close().catch(() => undefined);
    this.forget();
  }

  private counts(): Record<string, number> {
    return { read: this.read, acked: this.acked, written: this.written };
  }
}

/** As root: the gang this container left, if any: its relay stopped, its DNAT rules gone, its hosts file and hostname
 *  the runner's own. */
export const GANG_DOWN = String.raw`if [ -f ${STATE}/relay.pid ]; then kill "$(cat ${STATE}/relay.pid)" 2>/dev/null || true; rm -f ${STATE}/relay.pid; fi
iptables -t nat -F ARMADA_GANG 2>/dev/null || true
if [ -f ${STATE}/hosts.mounted ]; then umount /etc/hosts; rm -f ${STATE}/hosts.mounted; fi
hostname localhost`;

/** As root: this container as rank $1 of a gang of $2, the relay given the Worker's origin, the job, the gang's token
 *  and each rank's vessel ($3...): the ranks' names in the hosts file, a DNAT of each other rank's address to OUT, and
 *  the relay listening. */
export const GANG_UP = String.raw`set -eu
rank=$1 world=$2
shift 2
${GANG_DOWN}
hostname "rank$rank"
grep -v ' rank[0-9]*$' /etc/hosts > ${STATE}/hosts
iptables -t nat -N ARMADA_GANG 2>/dev/null || true
iptables -t nat -C OUTPUT -j ARMADA_GANG 2>/dev/null || iptables -t nat -A OUTPUT -j ARMADA_GANG
r=0
while [ "$r" -lt "$world" ]; do
  echo "127.0.1.$((r + 1)) rank$r" >> ${STATE}/hosts
  [ "$r" -eq "$rank" ] || iptables -t nat -A ARMADA_GANG -d "127.0.1.$((r + 1))/32" -p tcp -j DNAT --to-destination 127.0.0.1:${String(RELAY_OUT)}
  r=$((r + 1))
done
mount --bind ${STATE}/hosts /etc/hosts
touch ${STATE}/hosts.mounted
setsid python3 ${RELAY} "$rank" "$@" > ${RELAY_LOG} 2>&1 < /dev/null &
echo $! > ${STATE}/relay.pid
n=0
until ss -ltn | grep -q ':${String(RELAY_OUT)} ' && ss -ltn | grep -q ':${String(RELAY_IN)} '; do
  n=$((n + 1))
  [ "$n" -lt 200 ] || { cat ${RELAY_LOG} >&2; exit 1; }
  sleep 0.05
done`;

/** The relay: `relay.py <rank> <origin> <job> <token> <vessel of rank 0> <vessel of rank 1> ...`. Each connection is a
 *  `Link`, three threads; a WebSocket frame carries at most 64 KiB and its offset, under the Workers runtime's message
 *  limit. A rank whose vessel refuses (it has not taken up the gang yet) is asked again for up to a minute, as is one
 *  whose WebSocket dropped. */
export const RELAY_PY = String.raw`import base64, collections, os, socket, ssl, struct, sys, threading, time
from urllib.parse import urlsplit

OUT, IN = ${String(RELAY_OUT)}, ${String(RELAY_IN)}
WINDOW, ACK = ${String(RELAY_WINDOW)}, ${String(RELAY_ACK)}
PATIENCE, KEEPALIVE = 60, 30
RANK, ORIGIN, JOB, TOKEN, VESSELS = int(sys.argv[1]), urlsplit(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5:]
OWN = "127.0.1.%d" % (RANK + 1)


def exact(sock, n):
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise EOFError
        out += chunk
    return bytes(out)


def encoded(opcode, data):
    mask, n = os.urandom(4), len(data)
    size = bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack("!H", n) if n < 65536 else bytes([0xFF]) + struct.pack("!Q", n)
    body = (int.from_bytes(data, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big") if n else b""
    return bytes([0x80 | opcode]) + size + mask + body


def close(sock):
    try:
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def opened(rank, port, link, resume):
    """A WebSocket to rank's vessel carrying link to its port, or the status line it was refused with."""
    host, secure = ORIGIN.hostname, ORIGIN.scheme == "https"
    raw = socket.create_connection((host, ORIGIN.port or (443 if secure else 80)), timeout=30)
    ws = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if secure else raw
    ws.sendall(("GET /relay/%s/%s?port=%d&id=%s%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n${RELAY_HEADER}: %s\r\n\r\n"
                % (JOB, VESSELS[rank], port, link, "&resume=1" if resume else "", host,
                   base64.b64encode(os.urandom(16)).decode(), TOKEN)).encode())
    answer = b""
    while not answer.endswith(b"\r\n\r\n"):
        answer += exact(ws, 1)
    status = answer.split(b"\r\n", 1)[0]
    if b" 101 " in status:
        ws.settimeout(None)
        return ws, status
    ws.close()
    return None, status


class Link:
    """One connection a program opened to another rank, carried to that rank's vessel by a WebSocket, and by another
    under the same id when the network drops it (Relayed in relay.ts holds the vessel's end). This end numbers the
    local bytes it sends, keeps them until the vessel counts them, at most WINDOW ahead, and sends them again on a new
    WebSocket; it drops the vessel's bytes it already gave the program."""

    def __init__(self, local, rank, port):
        self.local, self.rank, self.port = local, rank, port
        self.id, self.name = os.urandom(8).hex(), "rank %d port %d" % (rank, port)
        self.ws, self.sending, self.changed = None, threading.Lock(), threading.Condition()
        self.sent = self.acked = self.taken = self.received = self.reported = 0
        self.kept, self.incoming = collections.deque(), collections.deque()
        self.ended = self.peer_ended = None
        self.over = False

    def log(self, what):
        sys.stderr.write("%s %s: %s after %d sent, %d counted, %d received\n"
                         % (time.strftime("%H:%M:%S"), self.name, what, self.sent, self.acked, self.received))

    def send(self, opcode, data):
        with self.sending:
            self.sent_on(opcode, data)

    def sent_on(self, opcode, data):
        if self.ws is not None:
            try:
                self.ws.sendall(encoded(opcode, data))
            except OSError:
                pass

    def attach(self, ws):
        """ws carries the link: what the vessel has not counted goes again, ahead of anything sent after it, then
        where each stream stands."""
        with self.sending:
            self.ws = ws
            with self.changed:
                kept = list(self.kept)
            for offset, data in kept:
                self.sent_on(2, struct.pack("!Q", offset) + data)
            if self.ended is not None:
                self.sent_on(1, b"e%d" % self.ended)
            self.sent_on(1, b"a%d" % self.received)

    def open(self, resume):
        """Opens the link's next WebSocket, asking again while the vessel is not yet the rank's (403) or the network
        fails, for PATIENCE: true once one carries the link; false once the vessel says it is gone (410) or never answers."""
        deadline = time.monotonic() + PATIENCE
        while True:
            try:
                ws, status = opened(self.rank, self.port, self.id, resume)
            except OSError as error:
                ws, status = None, repr(error).encode()
            if ws is not None:
                self.attach(ws)
                return True
            if b" 410 " in status or time.monotonic() > deadline:
                self.log("no WebSocket: %s" % status.decode(errors="replace"))
                return False
            time.sleep(0.5)

    def run(self):
        if not self.open(resume=False):
            self.local.close()
            return
        threading.Thread(target=self.from_local, daemon=True).start()
        threading.Thread(target=self.to_local, daemon=True).start()
        threading.Thread(target=self.keepalive, daemon=True).start()
        while True:
            ws = self.ws
            why = self.receive(ws)
            if self.over:
                break
            self.log("WebSocket dropped (%s), opening another" % why)
            with self.sending:
                self.ws = None
            try:
                ws.close()
            except OSError:
                pass
            if not self.open(resume=True):
                break
        self.finish()

    def receive(self, ws):
        """The vessel's messages on ws until the link is over or ws drops: why it stopped."""
        try:
            while not self.over:
                head, length = exact(ws, 2)
                n = length & 0x7F
                n = struct.unpack("!H", exact(ws, 2))[0] if n == 126 else struct.unpack("!Q", exact(ws, 8))[0] if n == 127 else n
                data, opcode = exact(ws, n), head & 0x0F
                if opcode == 2:
                    offset = struct.unpack("!Q", data[:8])[0]
                    if offset > self.taken:
                        self.fail("the vessel skipped from byte %d to %d" % (self.taken, offset))
                        return "a gap"
                    if offset + len(data) - 8 > self.taken:
                        with self.changed:
                            self.incoming.append(data[8 + self.taken - offset:])
                            self.changed.notify_all()
                        self.taken = offset + len(data) - 8
                elif opcode == 1:
                    count = int(data[1:])
                    if data[:1] == b"a":
                        with self.changed:
                            self.acked = max(self.acked, count)
                            while self.kept and self.kept[0][0] + len(self.kept[0][1]) <= self.acked:
                                self.kept.popleft()
                            self.changed.notify_all()
                    else:
                        with self.changed:
                            self.peer_ended = count
                            self.changed.notify_all()
                elif opcode == 9:
                    self.send(10, data)
                elif opcode == 8:
                    code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else 1005
                    reason = data[2:].decode(errors="replace")
                    if code != 1000 or reason != "replaced":
                        self.over = True
                        if code != 1000 or reason != "done":
                            self.log("closed %d %s" % (code, reason))
                    return "closed %d %s" % (code, reason)
        except (EOFError, OSError) as error:
            return repr(error)
        return "over"

    def from_local(self):
        try:
            while True:
                data = self.local.recv(65536)
                if not data:
                    break
                with self.changed:
                    while self.sent - self.acked > WINDOW and not self.over:
                        self.changed.wait()
                    if self.over:
                        return
                    offset = self.sent
                    self.kept.append((offset, data))
                    self.sent += len(data)
                self.send(2, struct.pack("!Q", offset) + data)
        except OSError:
            pass
        self.ended = self.sent
        self.send(1, b"e%d" % self.ended)

    def to_local(self):
        """The vessel's bytes to the program, counted back as it takes them, apart from the WebSocket's messages: a
        program that is not reading must not hold up the counts of what it sends."""
        while True:
            with self.changed:
                while not self.incoming and not self.over and (self.peer_ended is None or self.received < self.peer_ended):
                    self.changed.wait()
                if self.over:
                    return
                data = self.incoming.popleft() if self.incoming else None
            if data is None:
                # The vessel's whole stream arrived: its last bytes are counted, and the program reads its end.
                self.send(1, b"a%d" % self.received)
                close(self.local)
                return
            try:
                self.local.sendall(data)
            except OSError:
                return
            self.received += len(data)
            if self.received - self.reported >= ACK:
                self.reported = self.received
                self.send(1, b"a%d" % self.received)

    def fail(self, why):
        self.log(why)
        self.over = True
        self.send(8, struct.pack("!H", 1011) + why.encode()[:120])

    def finish(self):
        self.over = True
        with self.changed:
            self.changed.notify_all()
        self.local.close()

    def keepalive(self):
        """Pings an idle WebSocket, which Cloudflare closes after 100 s without data: a collective library's
        connections sit idle between collectives, for a compilation, say."""
        while not self.over:
            time.sleep(KEEPALIVE)
            self.send(9, b"")


def outbound(local):
    port, address = struct.unpack("!2xH4s8x", local.getsockopt(socket.SOL_IP, 80, 16))
    Link(local, int(socket.inet_ntoa(address).rsplit(".", 1)[1]) - 1, port).run()


def pipe(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    close(sink)


def inbound(conn):
    line = b""
    while not line.endswith(b"\n"):
        line += exact(conn, 1)
    local = socket.create_connection((OWN, int(line)))
    local.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    threading.Thread(target=pipe, args=(local, conn), daemon=True).start()
    pipe(conn, local)


def serve(address, handle):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(address)
    server.listen(128)
    while True:
        conn = server.accept()[0]
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=guarded, args=(handle, conn), daemon=True).start()


def guarded(handle, conn):
    try:
        handle(conn)
    except Exception as error:
        sys.stderr.write("%s: %r\n" % (handle.__name__, error))
        conn.close()


threading.Thread(target=serve, args=(("0.0.0.0", IN), inbound), daemon=True).start()
serve(("127.0.0.1", OUT), outbound)
`;
