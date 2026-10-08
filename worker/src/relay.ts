/**
 * A gang's network. Containers have outbound internet and no inbound address, and a Durable Object can open TCP into
 * its own container (`getTcpPort`). So each rank r of a gang is host `rank<r>` at 127.0.1.<r + 1> in every container,
 * and a connection to another rank's address goes: a DNAT to this relay's OUT port, a WebSocket to the Worker's
 * `/relay/<job>/<vessel>` (`relayed`), that rank's vessel, which opens the relay's IN port in its container (`Piped`),
 * and a connection there to the port on the rank's own address. Any TCP a program speaks runs over it unchanged:
 * jax.distributed's coordinator, gloo's collectives, a database.
 *
 * Each connection is a link between the two relays (`Link` in relay.py), and the vessel between them holds none of
 * it: each end numbers its bytes, counts back the other's, runs at most RELAY_WINDOW ahead of the count (a WebSocket
 * send never waits, so a fast sender would pile a collective's ring step into the vessel's memory) and keeps what is
 * not yet counted. When the network drops the WebSocket, or the vessel is reset, the outbound end opens another under
 * the link's id, the vessel opens another connection in under it, and each end sends what the other has not counted,
 * the program seeing nothing of it.
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

/** The bytes either end of a link may have sent and not yet had counted: at a 5 ms round trip, 200 MB/s a link. */
export const RELAY_WINDOW = 1 << 20;

/** How often, in bytes taken, each end counts them back to the other. */
export const RELAY_ACK = 1 << 18;

/** How long, in seconds, an end waits for a link that dropped to come back. */
export const RELAY_GRACE = 60;

/** A link's id: the relay names each connection it carries, and opens another WebSocket under it after a drop. */
export const LINK_ID = /^[0-9a-f]{16}$/u;

const TEXT = 0x74;

const BINARY = 0x62;

/**
 * A relay WebSocket at its vessel, piped to a connection into the container's relay: first a line naming the link
 * (`<id> <port> <resume>`), then each message as a record (a kind byte, `t` or `b`, the length in 4 bytes, big
 * endian, and the bytes), and each record back as a message. A close either way ends both: the link's ends carry on
 * over the next pair. `log` says how a WebSocket closed that did not close cleanly.
 */
export class Piped {
  private queue: Promise<void>;

  private over = false;

  constructor(private readonly socket: WebSocket, private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    link: string, private readonly log: (event: string, detail: Record<string, unknown>) => void) {
    this.queue = writer.write(new TextEncoder().encode(`${link}\n`)).catch((error: unknown) => { this.end(1011, `the container's side failed: ${String(error)}`); });
  }

  /** The container's records to the WebSocket, as they complete, then the WebSocket's close. */
  async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    let held = new Uint8Array(0);

    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const joined = new Uint8Array(held.byteLength + read.value.byteLength);

        joined.set(held);
        joined.set(read.value, held.byteLength);
        let at = 0;

        while (joined.byteLength - at >= 5) {
          const length = new DataView(joined.buffer, at + 1, 4).getUint32(0);

          if (joined.byteLength - at < 5 + length) break;
          const body = joined.slice(at + 5, at + 5 + length);

          this.socket.send(joined[at] === TEXT ? new TextDecoder().decode(body) : body);
          at += 5 + length;
        }

        held = joined.slice(at);
      }

      this.end(1000, 'the container closed it');
    } catch (error) {
      this.end(1011, `the container's side failed: ${String(error)}`);
    }
  }

  /** A message to the container, as a record, written after those before it though the runtime hands over the next
   *  message while a write waits. */
  async message(message: string | ArrayBuffer): Promise<void> {
    const body = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
    const record = new Uint8Array(5 + body.byteLength);

    record[0] = typeof message === 'string' ? TEXT : BINARY;
    new DataView(record.buffer).setUint32(1, body.byteLength);
    record.set(body, 5);
    this.queue = this.queue.then(async () => { await this.writer.write(record); })
      .catch((error: unknown) => { this.end(1011, `the container's side failed: ${String(error)}`); });
    await this.queue;
  }

  /** The WebSocket closed: the container's connection closes after what was written to it. */
  async closed(code: number, reason: string): Promise<void> {
    if (!this.over && code !== 1000) this.log('relay WebSocket closed by its relay', { code, reason });
    this.over = true;
    this.queue = this.queue.then(async () => { await this.writer.close(); }).catch(() => undefined);
    await this.queue;
  }

  private end(code: number, reason: string): void {
    if (this.over) return;
    this.over = true;

    if (code !== 1000) this.log('relay WebSocket closed by its vessel', { code, reason });
    this.socket.close(code, reason.slice(0, 120));
    void this.writer.close().catch(() => undefined);
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

/** The relay: `relay.py <rank> <origin> <job> <token> <vessel of rank 0> <vessel of rank 1> ...`. Each connection is
 *  a `Link`: a thread taking the far end's messages and one each way to and from the program. A WebSocket frame carries
 *  at most 64 KiB and its offset, under the Workers runtime's message limit. A vessel that refuses (it has not taken up
 *  the gang yet) is asked again for up to RELAY_GRACE seconds, as is one whose WebSocket dropped. */
export const RELAY_PY = String.raw`import base64, collections, os, socket, ssl, struct, sys, threading, time
from urllib.parse import urlsplit

OUT, IN = ${String(RELAY_OUT)}, ${String(RELAY_IN)}
WINDOW, ACK, GRACE, KEEPALIVE = ${String(RELAY_WINDOW)}, ${String(RELAY_ACK)}, ${String(RELAY_GRACE)}, 30
RANK, ORIGIN, JOB, TOKEN, VESSELS = int(sys.argv[1]), urlsplit(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5:]
OWN = "127.0.1.%d" % (RANK + 1)
LINKS, LINKED = {}, threading.Lock()


def exact(sock, n):
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise EOFError
        out += chunk
    return bytes(out)


def close(sock):
    try:
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass


class Frames:
    """A WebSocket to a rank's vessel, which an outbound link goes over: text and binary messages, pings answered."""

    def __init__(self, ws):
        self.ws, self.lock = ws, threading.Lock()

    def put(self, text, data, opcode=None):
        """One message, under the caller's hold of self.lock."""
        opcode, mask, n = opcode or (1 if text else 2), os.urandom(4), len(data)
        size = bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack("!H", n) if n < 65536 else bytes([0xFF]) + struct.pack("!Q", n)
        body = (int.from_bytes(data, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big") if n else b""
        self.ws.sendall(bytes([0x80 | opcode]) + size + mask + body)

    def ping(self):
        with self.lock:
            self.put(False, b"", 9)

    def take(self):
        """The next message, (text, data); EOFError or ConnectionError once the WebSocket is gone."""
        while True:
            head, length = exact(self.ws, 2)
            n = length & 0x7F
            n = struct.unpack("!H", exact(self.ws, 2))[0] if n == 126 else struct.unpack("!Q", exact(self.ws, 8))[0] if n == 127 else n
            data, opcode = exact(self.ws, n), head & 0x0F
            if opcode in (0, 1, 2):
                return opcode == 1, data
            if opcode == 9:
                with self.lock:
                    self.put(False, data, 10)
            elif opcode == 8:
                code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else 1005
                raise ConnectionError("closed %d %s" % (code, data[2:].decode(errors="replace")))

    def close(self):
        try:
            self.ws.close()
        except OSError:
            pass


class Records:
    """A vessel's connection in, which an inbound link goes over: its WebSocket's messages as records."""

    def __init__(self, conn):
        self.conn, self.lock = conn, threading.Lock()

    def put(self, text, data, opcode=None):
        self.conn.sendall((b"t" if text else b"b") + struct.pack("!I", len(data)) + data)

    def ping(self):
        pass

    def take(self):
        kind, n = struct.unpack("!cI", exact(self.conn, 5))
        return kind == b"t", exact(self.conn, n)

    def close(self):
        try:
            self.conn.close()
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
        return Frames(ws), status
    ws.close()
    return None, status


class Link:
    """One connection a program opened to another rank, between this end and the far rank's relay. Each end numbers
    the program's bytes it sends (a binary message is their first offset, 8 bytes, and the bytes), counts back the far
    end's it took ('a<n>', every ACK), stops WINDOW ahead of the far end's count, keeps what is not yet counted, and
    ends its stream with 'e<n>'; 'g' says the far end holds no such link. When what carries the link goes, the
    outbound end opens another WebSocket under the link's id (reopen) and the inbound end takes the vessel's next
    connection in under it (handover); each then sends what the other has not counted and drops what it already
    took. Done once both streams ended and each was counted."""

    def __init__(self, local, name, carrier, reopen=None, held=None):
        self.local, self.name, self.carrier, self.reopen = local, name, None, reopen or self.handed
        self.changed, self.pending = threading.Condition(), None
        self.sent = self.acked = self.taken = self.received = 0
        self.kept, self.incoming = collections.deque(), collections.deque()
        self.ended = self.peer_ended = None
        self.over = self.delivered = False
        if held is not None:
            held(self)
        self.attach(carrier)

    def log(self, what):
        sys.stderr.write("%s %s: %s after %d sent, %d counted, %d received\n"
                         % (time.strftime("%H:%M:%S"), self.name, what, self.sent, self.acked, self.received))

    def send(self, carrier, text, data):
        if carrier is None:
            return
        try:
            with carrier.lock:
                carrier.put(text, data)
        except OSError:
            pass

    def attach(self, carrier):
        """carrier takes the link: what the far end has not counted goes first, then where each stream stands."""
        with carrier.lock:
            with self.changed:
                self.carrier, kept = carrier, list(self.kept)
            try:
                for offset, data in kept:
                    carrier.put(False, struct.pack("!Q", offset) + data)
                if self.ended is not None:
                    carrier.put(True, b"e%d" % self.ended)
                carrier.put(True, b"a%d" % self.received)
            except OSError:
                pass

    def handover(self, carrier):
        """The vessel's next connection in, for an inbound link: the one before it, and one handed over and not yet
        taken, are closed, which hands over."""
        with self.changed:
            earlier, unused, self.pending = self.carrier, self.pending, carrier
            self.changed.notify_all()
        for replaced in (earlier, unused):
            if replaced is not None:
                replaced.close()

    def handed(self):
        with self.changed:
            deadline = time.monotonic() + GRACE
            while self.pending is None and not self.over and time.monotonic() < deadline:
                self.changed.wait(deadline - time.monotonic())
            carrier, self.pending = self.pending, None
            return carrier

    def run(self):
        for work in (self.from_local, self.to_local, self.keepalive):
            threading.Thread(target=work, daemon=True).start()
        while not self.over:
            carrier = self.carrier
            why = self.receive(carrier)
            if self.over:
                break
            self.log("%s; waiting for it to come back" % why)
            carrier.close()
            carrier = self.reopen()
            if carrier is None:
                self.log("it did not come back")
                break
            self.attach(carrier)
        self.finish()

    def receive(self, carrier):
        """The far end's messages on carrier until the link is over or carrier goes: why it stopped."""
        try:
            while not self.over:
                text, data = carrier.take()
                if not text:
                    offset = struct.unpack("!Q", data[:8])[0]
                    if offset > self.taken:
                        self.log("the far end skipped from byte %d to %d" % (self.taken, offset))
                        self.over = True
                        return "a gap"
                    if offset + len(data) - 8 > self.taken:
                        with self.changed:
                            self.incoming.append(data[8 + self.taken - offset:])
                            self.changed.notify_all()
                        self.taken = offset + len(data) - 8
                elif data == b"g":
                    self.log("the far end holds no such link")
                    self.over = True
                else:
                    count = int(data[1:])
                    with self.changed:
                        if data[:1] == b"a":
                            self.acked = max(self.acked, count)
                            while self.kept and self.kept[0][0] + len(self.kept[0][1]) <= self.acked:
                                self.kept.popleft()
                        else:
                            self.peer_ended = count
                        self.changed.notify_all()
                    self.settle()
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
                    offset, carrier = self.sent, self.carrier
                    self.kept.append((offset, data))
                    self.sent += len(data)
                self.send(carrier, False, struct.pack("!Q", offset) + data)
        except OSError:
            pass
        with self.changed:
            self.ended, carrier = self.sent, self.carrier
        self.send(carrier, True, b"e%d" % self.ended)
        self.settle()

    def to_local(self):
        """The far end's bytes to the program, counted back as it takes them, apart from taking the far end's
        messages: a program that is not reading must not hold up the counts of what it sends."""
        reported = 0
        while True:
            with self.changed:
                while not self.incoming and not self.over and (self.peer_ended is None or self.received < self.peer_ended):
                    self.changed.wait()
                if self.over and not self.incoming:
                    return
                data = self.incoming.popleft() if self.incoming else None
            if data is None:
                # The far end's whole stream arrived: its last bytes are counted, and the program reads its end. The
                # link is not done before this count is sent, or the far end would wait for it.
                self.send(self.carrier, True, b"a%d" % self.received)
                close(self.local)
                with self.changed:
                    self.delivered = True
                self.settle()
                return
            try:
                self.local.sendall(data)
            except OSError:
                return
            with self.changed:
                self.received += len(data)
            if self.received - reported >= ACK:
                reported = self.received
                self.send(self.carrier, True, b"a%d" % self.received)

    def settle(self):
        with self.changed:
            done = self.ended is not None and self.acked >= self.ended and self.delivered
        if done:
            self.finish()

    def finish(self):
        with self.changed:
            self.over = True
            carrier = self.carrier
            self.changed.notify_all()
        if carrier is not None:
            carrier.close()
        self.local.close()

    def keepalive(self):
        """Pings an idle WebSocket, which Cloudflare closes after 100 s without data: a collective library's
        connections sit idle between collectives, for a compilation, say."""
        while not self.over:
            time.sleep(KEEPALIVE)
            carrier = self.carrier
            try:
                if carrier is not None:
                    carrier.ping()
            except OSError:
                pass


def carry(local, rank, port):
    """local, a program's connection to rank's port, as a link over a WebSocket to rank's vessel."""
    link, name = os.urandom(8).hex(), "rank %d port %d" % (rank, port)

    def reopen(resume=True):
        deadline = time.monotonic() + GRACE
        while True:
            try:
                carrier, status = opened(rank, port, link, resume)
            except OSError as error:
                carrier, status = None, repr(error).encode()
            if carrier is not None or time.monotonic() > deadline:
                if carrier is None:
                    sys.stderr.write("%s %s: no WebSocket: %s\n" % (time.strftime("%H:%M:%S"), name, status.decode(errors="replace")))
                return carrier
            time.sleep(0.5)

    carrier = reopen(resume=False)
    if carrier is None:
        local.close()
        return
    Link(local, name, carrier, reopen).run()


def outbound(local):
    port, address = struct.unpack("!2xH4s8x", local.getsockopt(socket.SOL_IP, 80, 16))
    carry(local, int(socket.inet_ntoa(address).rsplit(".", 1)[1]) - 1, port)


def inbound(conn):
    """The vessel's connection in, under a link's id: the link's next carrier if this end holds it; else, for a new
    link, a connection to its port on this rank's address, or 'g' when that or the link is gone."""
    line = b""
    while not line.endswith(b"\n"):
        line += exact(conn, 1)
    link, port, resume = line.decode().split()
    carrier = Records(conn)
    with LINKED:
        held = LINKS.get(link)
    if held is not None:
        held.handover(carrier)
        return
    try:
        if resume == "1":
            raise ConnectionError("the link is gone")
        local = socket.create_connection((OWN, int(port)))
    except OSError:
        carrier.put(True, b"g")
        carrier.close()
        return
    local.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def register(held):
        # Before its first carrier takes it, so a resume that comes at once finds it.
        with LINKED:
            LINKS[link] = held

    held = Link(local, "port %s from link %s" % (port, link), carrier, held=register)
    try:
        held.run()
    finally:
        with LINKED:
            LINKS.pop(link, None)


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


if __name__ == "__main__":
    threading.Thread(target=serve, args=(("0.0.0.0", IN), inbound), daemon=True).start()
    serve(("127.0.0.1", OUT), outbound)
`;
