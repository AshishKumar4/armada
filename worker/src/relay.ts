/**
 * A gang's network. Containers have outbound internet and no inbound address. So each rank r of a gang is host
 * `rank<r>` at 127.0.1.<r + 1> in every container, and a connection to another rank's address goes: a DNAT to this
 * relay's OUT port, a WebSocket out to that rank's hub (`ArmadaHub`, `/hub/<job>/<index>/<attempt>/<rank>`), which
 * tells the rank's relay over its control socket, whose relay dials the hub for the link in turn and connects to the
 * port on its own address. Any TCP a program speaks runs over it unchanged: jax.distributed's coordinator, gloo's
 * collectives, a database. The hub keeps nothing in storage, so no vessel's storage, which stalls and resets under the
 * platform, is on any link's path.
 *
 * Each connection is a link between the two relays (`Link` in relay.py), and the hub between them holds none of it:
 * each end numbers its bytes, counts back the other's, runs at most RELAY_WINDOW ahead of the count (a WebSocket send
 * never waits, so a fast sender would pile a collective's ring step into the hub's memory) and keeps what is not yet
 * counted. When the network drops a WebSocket, or the hub restarts, the outbound end opens another under the link's
 * id, the hub has the far relay dial another for it, and each end sends what the other has not counted, the program
 * seeing nothing of it.
 */
import { STATE } from './container';
import { SILENT_MS } from './job';

/** Where a rank's peers' connections arrive (loopback, DNAT'd to). */
export const RELAY_OUT = 7911;

/** The relay's script in a container, and its log: how each of its links dropped or ended. */
export const RELAY = `${STATE}/relay.py`;

export const RELAY_LOG = `${STATE}/relay.log`;

/** The header a relay's WebSocket presents the gang's token in (`gangToken`). */
export const RELAY_HEADER = 'armada-relay';

/** The bytes either end of a link may have sent and not yet had counted: at a 5 ms round trip, 200 MB/s a link. */
export const RELAY_WINDOW = 1 << 20;

/** How often, in bytes taken, each end counts them back to the other. */
export const RELAY_ACK = 1 << 18;

/** How long, in seconds, an end waits for a link that dropped to come back: as long as its job waits for a working
 *  vessel's word (`SILENT_MS`). */
export const RELAY_GRACE = SILENT_MS.working / 1000;

/** The most a relay lets one open of a WebSocket to a hub take, in seconds, from connecting to its pairing with the
 *  far relay's: the whole of it, not each read of it. One the hub or the network holds past it is closed and made
 *  again on a new connection, each said in the relay's log, instead of held for RELAY_GRACE. */
export const RELAY_OPEN = 20;

/** The most, in seconds, a relay's control socket hears nothing from its hub, not even its heartbeat's answer (sent every
 *  30 s), before it is closed and opened again: a connection that stopped carrying traffic carries no FIN or RST to say
 *  so, and its hub would go on telling it opens nothing takes up. Two heartbeats may be lost, and a third's answer
 *  late. */
export const RELAY_SILENCE = 75;

/** A link's id: the relay names each connection it carries, and opens another WebSocket under it after a drop. */
export const LINK_ID = /^[0-9a-f]{16}$/u;

/** What a relay's open says of itself in its URL, for the Worker's and the hub's logs: its kind (`control`, a `link`'s
 *  own open, or the far relay's `accept` of it), the link, the port, the rank that opens it (`from`) and which of its
 *  opens this is (`n`). Nothing in it is secret, and what the caller wrote is capped. */
export function opening(url: URL, kind: string) {
  const named = ['id', 'port', 'from', 'n'].flatMap((name) => {
    const value = url.searchParams.get(name);

    return value === null ? [] : [[name, value.slice(0, 40)]];
  });

  return { open: url.searchParams.has('accept') ? 'accept' : kind.slice(0, 16), ...Object.fromEntries(named) };
}

/** As root: the gang this container left, if any: its relay stopped, its DNAT rules gone, its hosts file and hostname
 *  the runner's own. The relay is waited out, killed after 2.5 s and given up on after 5: one still holding its ports
 *  would pass the next gang's readiness check while the next relay died unable to bind them, and the gang would wait
 *  on links nothing serves (#22). */
export const GANG_DOWN = String.raw`relay_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  IFS= read -r relay_stat < "/proc/$1/stat" 2>/dev/null || return 1
  case "$relay_stat" in *') Z '*|*') X '*) return 1;; esac
}
if [ -f ${STATE}/relay.pid ]; then
  relay_pid="$(cat ${STATE}/relay.pid)"
  kill "$relay_pid" 2>/dev/null || true
  n=0
  while relay_alive "$relay_pid"; do
    n=$((n + 1))
    [ "$n" -ne 50 ] || kill -KILL "$relay_pid" 2>/dev/null || true
    [ "$n" -lt 100 ] || { echo "the previous gang relay $relay_pid did not stop" >&2; exit 1; }
    sleep 0.05
  done
  rm -f ${STATE}/relay.pid
fi
iptables -t nat -F ARMADA_GANG 2>/dev/null || true
if [ -f ${STATE}/hosts.mounted ]; then umount /etc/hosts; rm -f ${STATE}/hosts.mounted; fi
hostname localhost`;

/** As root: this container as rank $1 of a gang of $2, the relay given the Worker's origin, the job, the gang's token,
 *  the task's index and its attempt ($3...): the ranks' names in the hosts file, a DNAT of each other rank's address to
 *  OUT, and the relay it started listening on OUT itself, or the setup fails with the relay's log. */
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
relay_pid=$!
echo "$relay_pid" > ${STATE}/relay.pid
n=0
while :; do
  relay_alive "$relay_pid" || { cat ${RELAY_LOG} >&2; exit 1; }
  if ss -ltnp | grep ':${String(RELAY_OUT)} ' | grep -q "pid=$relay_pid,"; then break; fi
  n=$((n + 1))
  [ "$n" -lt 200 ] || { cat ${RELAY_LOG} >&2; exit 1; }
  sleep 0.05
done`;

/** The relay: `relay.py <rank> <origin> <job> <token> <index> <attempt>`. Each connection is a `Link`: a thread taking
 *  the far end's messages and one each way to and from the program. A WebSocket frame carries at most 64 KiB and its
 *  offset, under the Workers runtime's message limit. An open of a WebSocket to a hub is bounded as a whole (RELAY_OPEN)
 *  and a failed one is said whatever it was and however often; an open the far rank's hub does not pair (its relay has
 *  not come up yet, or its control socket is coming back) is asked again for up to RELAY_GRACE seconds, as is one whose
 *  WebSocket dropped. */
export const RELAY_PY = String.raw`import base64, collections, hashlib, os, socket, ssl, struct, sys, threading, time
from urllib.parse import urlsplit

OUT = ${String(RELAY_OUT)}
WINDOW, ACK, GRACE, KEEPALIVE, BUDGET, SILENCE = ${String(RELAY_WINDOW)}, ${String(RELAY_ACK)}, ${String(RELAY_GRACE)}, 30, ${String(RELAY_OPEN)}, ${String(RELAY_SILENCE)}
RANK, ORIGIN, JOB, TOKEN, INDEX, ATTEMPT = int(sys.argv[1]), urlsplit(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
OWN = "127.0.1.%d" % (RANK + 1)
LINKS, LINKED = {}, threading.Lock()
# One context for every open: each holds a copy of the trust roots, and a process opens a link's WebSocket often.
TLS_CONTEXT = ssl.create_default_context()


def left(deadline):
    """The seconds to deadline, for the timeout of the next blocking call; a timeout itself once there are none."""
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise socket.timeout("the open's time is spent")
    return seconds


def exact(sock, n, deadline=None):
    """n bytes from sock; with a deadline, by it, however slowly they come."""
    out = bytearray()
    while len(out) < n:
        if deadline is not None:
            sock.settimeout(left(deadline))
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
    """A WebSocket to a rank's hub, which a link or a control socket goes over: text and binary messages, pings
    answered. Its reads go one at a time under self.reading and its writes under self.lock, so that close can wait out
    whichever is in progress. The locks are taken in that order: take writes a pong, under self.lock, while it reads."""

    def __init__(self, ws):
        self.ws, self.lock, self.reading, self.closing = ws, threading.Lock(), threading.Lock(), threading.Lock()

    def put(self, text, data, opcode=None):
        """One message, under the caller's hold of self.lock."""
        opcode, mask, n = opcode or (1 if text else 2), os.urandom(4), len(data)
        size = bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack("!H", n) if n < 65536 else bytes([0xFF]) + struct.pack("!Q", n)
        body = (int.from_bytes(data, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big") if n else b""
        self.ws.sendall(bytes([0x80 | opcode]) + size + mask + body)

    def ping(self):
        with self.lock:
            self.put(False, b"", 9)

    def take(self, deadline=None):
        """The next message, (text, data), its fragments joined, by deadline if there is one; EOFError or
        ConnectionError once the WebSocket is gone."""
        with self.reading:
            text, parts = False, []
            while True:
                head, length = exact(self.ws, 2, deadline)
                n = length & 0x7F
                n = struct.unpack("!H", exact(self.ws, 2, deadline))[0] if n == 126 else struct.unpack("!Q", exact(self.ws, 8, deadline))[0] if n == 127 else n
                data, opcode = exact(self.ws, n, deadline), head & 0x0F
                if opcode in (0, 1, 2):
                    text = opcode == 1 if opcode else text
                    parts.append(data)
                    if head & 0x80:
                        return text, b"".join(parts)
                elif opcode == 9:
                    with self.lock:
                        self.put(False, data, 10)
                elif opcode == 8:
                    code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else 1005
                    raise ConnectionError("closed %d %s" % (code, data[2:].decode(errors="replace")))

    def close(self):
        """Closes the socket once no thread is in a read or a write of it, which this wakes. A socket closed under
        one gives its descriptor's number to the next socket made, and OpenSSL's read or write in progress goes on using
        the number (it takes a record in more than one call): it takes the next socket's bytes and writes its own TLS
        alert into it. SSLSocket.shutdown would clear the SSL state under that thread; the socket's own does not. Waits
        for self.reading and self.lock, so no thread holding either may call it: take and put never do, and every
        caller closes after them. One closer at a time, so no shutdown reaches a descriptor another closer gave up."""
        with self.closing:
            try:
                socket.socket.shutdown(self.ws, socket.SHUT_RDWR)
            except OSError:
                # The socket can be gone already: ENOTCONN once the far end has reset or closed it, EBADF once an earlier
                # close of it came to its end.
                pass
            with self.reading, self.lock:
                self.ws.close()


def dialled(rank, kind, query, deadline):
    """An open of a WebSocket to rank's hub (/hub/<job>/<index>/<attempt>/<rank>/<kind>?<query>), the whole of it from
    connecting to the hub's 101, done by deadline however slowly the network or the hub answers: (the WebSocket,
    stage, status), or (None, the stage it failed in, why): 'connect', 'tls' or 'upgrade', and the status line the hub
    refused with or the exception. The socket of a failed open is closed."""
    stage, sock = "connect", None
    try:
        host, secure = ORIGIN.hostname, ORIGIN.scheme == "https"
        sock = socket.create_connection((host, ORIGIN.port or (443 if secure else 80)), timeout=left(deadline))
        if secure:
            stage = "tls"
            sock.settimeout(left(deadline))
            sock = TLS_CONTEXT.wrap_socket(sock, server_hostname=host)
        stage = "upgrade"
        key = base64.b64encode(os.urandom(16)).decode()
        sock.settimeout(left(deadline))
        sock.sendall(("GET /hub/%s/%s/%s/%d/%s?%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n${RELAY_HEADER}: %s\r\n\r\n"
                      % (JOB, INDEX, ATTEMPT, rank, kind, query, host, key, TOKEN)).encode())
        answer = b""
        while not answer.endswith(b"\r\n\r\n"):
            answer += exact(sock, 1, deadline)
        status, *headers = answer.split(b"\r\n")
        # RFC 6455's proof that the far end took this handshake, not some other upgrade.
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        if status.split(b" ")[1:2] == [b"101"] and any(line.partition(b":")[0].strip().lower() == b"sec-websocket-accept" and line.partition(b":")[2].strip() == accept for line in headers):
            return Frames(sock), stage, status
        sock.close()
        return None, stage, status
    except (EOFError, OSError, ValueError) as error:
        if sock is not None:
            sock.close()
        return None, stage, repr(error).encode()


def paired(carrier, deadline):
    """carrier once the hub has paired it with the far relay's and said so ('r'), before which neither end sends the
    link's messages: (carrier, 'pair', status); or (None, 'pair', why) with carrier closed, by deadline."""
    try:
        text, data = carrier.take(deadline)
    except (EOFError, OSError) as error:
        carrier.close()
        return None, "pair", repr(error).encode()
    if (text, data) != (True, b"r"):
        carrier.close()
        return None, "pair", b"the hub said %r before pairing" % data[:16]
    carrier.ws.settimeout(None)
    return carrier, "pair", b"paired"


def opened(rank, port, link, resume, n, until):
    """This relay's nth open of link to rank's port: (the link's WebSocket, paired at the hub with the far relay's,
    stage, status), or (None, the stage that failed, why), the whole of it within BUDGET and before until, the time
    its caller gives up."""
    deadline = min(until, time.monotonic() + BUDGET)
    carrier, stage, status = dialled(rank, "link", "id=%s&port=%d%s&from=%d&n=%d" % (link, port, "&resume=1" if resume else "", RANK, n), deadline)
    return paired(carrier, deadline) if carrier is not None else (None, stage, status)


class Link:
    """One connection a program opened to another rank, between this end and the far rank's relay. Each end numbers
    the program's bytes it sends (a binary message is their first offset, 8 bytes, and the bytes), counts back the far
    end's it took ('a<n>', every ACK), stops WINDOW ahead of the far end's count, keeps what is not yet counted, and
    ends its stream with 'e<n>'; 'g' says the far end holds no such link. When what carries the link goes, the
    outbound end opens another WebSocket under the link's id (reopen) and the inbound end takes the next one its own
    relay dials for it (handover); each then sends what the other has not counted and drops what it already
    took. Done once both streams ended and each was counted; the inbound end then says 'f', which the outbound end
    waits for (settle).

    'f' is new, and no end asks which relay the other is. The two ends of a link run one deployment's relay.py, since
    the file is written into a container when its vessel joins a gang (vessel.ts, network) from the Worker that
    deploys the gang, unless a vessel that stays in gangs keeps an older one across a deploy of the Worker. Then an
    outbound end with 'f' and an inbound end without it end the link whole: the outbound end sees its carrier close
    as the inbound end finishes, opens again and is told 'g'. An outbound end without 'f' fails on one it reads
    before it has finished, its link's thread ending with the program's connection, which has all it will get."""

    def __init__(self, local, name, carrier, reopen=None, held=None):
        self.local, self.name, self.carrier, self.reopen = local, name, None, reopen or self.handed
        self.changed, self.pending = threading.Condition(), None
        self.sent = self.acked = self.taken = self.received = 0
        self.kept, self.incoming = collections.deque(), collections.deque()
        self.ended = self.peer_ended = None
        self.over = self.delivered = self.cancelled = False
        # Only the end that dialled opens another WebSocket (reopen); see settle.
        self.outbound, self.confirmed = reopen is not None, False
        self.finished = threading.Event()
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
        """carrier takes the link: what the far end has not counted goes first, then where each stream stands. A link
        this end cancelled says only that, until the far end says it back."""
        with carrier.lock:
            with self.changed:
                self.carrier, kept, cancelled = carrier, list(self.kept), self.cancelled
            try:
                if cancelled:
                    carrier.put(True, b"g")
                    return
                for offset, data in kept:
                    carrier.put(False, struct.pack("!Q", offset) + data)
                if self.ended is not None:
                    carrier.put(True, b"e%d" % self.ended)
                carrier.put(True, b"a%d" % self.received)
            except OSError:
                pass

    def handover(self, carrier):
        """The next WebSocket the hub paired for an inbound link: the one before it, and one handed over and not yet
        taken, are closed, which hands over. One that comes once the link is over is closed itself."""
        with self.changed:
            if self.over:
                closing = (carrier,)
            else:
                closing, self.pending = (self.carrier, self.pending), carrier
                self.changed.notify_all()
        for replaced in closing:
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
                elif data == b"f":
                    with self.changed:
                        self.confirmed = True
                    self.settle()
                elif data == b"g":
                    self.log("the far end holds no such link")
                    # Said back, unless this end said it first: the far end's cancellation then knows it arrived.
                    if not self.cancelled:
                        self.send(carrier, True, b"g")
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
                    while self.sent - self.acked > WINDOW and not self.over and not self.cancelled:
                        self.changed.wait()
                    if self.over or self.cancelled:
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
            except OSError as error:
                self.cancel("the program's connection went: %r" % error)
                return
            with self.changed:
                self.received += len(data)
            if self.received - reported >= ACK:
                reported = self.received
                self.send(self.carrier, True, b"a%d" % self.received)

    def cancel(self, why):
        """The program can take nothing more: its connection closes, and the far end is told this end holds the link
        no more ('g'), so it ends too. The link ends here once the far end says it back: a 'g' lost with its carrier
        is said again on the next (attach)."""
        self.log(why)
        with self.changed:
            self.cancelled, carrier = True, self.carrier
            self.changed.notify_all()
        try:
            self.local.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.local.close()
        self.send(carrier, True, b"g")

    def settle(self):
        """Finishes the link once this end is done: its stream ended and counted, the far end's delivered. The inbound
        end is done then, and says 'f' as it goes. The outbound end, the only one that opens another WebSocket, is
        done once 'f' has come too: the count it last sent (the far end's stream, taken) may have been lost with its
        carrier, and the inbound end, which cannot ask for it, waits for GRACE for a carrier no one will open. While
        this end waits for 'f' a lost count is sent again with the next carrier (attach). If 'f' is lost, the next
        open finds no link, and 'g' ends it."""
        with self.changed:
            done = self.ended is not None and self.acked >= self.ended and self.delivered and not self.over
            confirmed = self.confirmed or not self.outbound
        if done and confirmed:
            if not self.outbound:
                self.send(self.carrier, True, b"f")
            self.finish()

    def finish(self):
        with self.changed:
            self.over = True
            carrier, pending, self.pending = self.carrier, self.pending, None
            self.changed.notify_all()
        self.finished.set()
        for each in (carrier, pending):
            if each is not None:
                each.close()
        # Shut down before closing: close() alone neither wakes from_local's recv on it nor sends the program a FIN.
        try:
            self.local.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.local.close()

    def keepalive(self):
        """Pings an idle WebSocket, which Cloudflare closes after 100 s without data: a collective library's
        connections sit idle between collectives, for a compilation, say. Woken when the link ends: a thread asleep
        holds the link, and its sockets, until it wakes."""
        while not self.finished.wait(KEEPALIVE):
            carrier = self.carrier
            try:
                if carrier is not None:
                    carrier.ping()
            except OSError:
                pass


def carry(local, rank, port):
    """local, a program's connection to rank's port, as a link over a WebSocket to rank's hub."""
    link, name, opens = os.urandom(8).hex(), "rank %d port %d" % (rank, port), [0]

    def reopen(resume=True):
        """A WebSocket for the link, asked for every half second up to GRACE. Every failed ask is said, however like the
        one before it: its number, why it failed, in which stage and after how long, so a stall shows when it began,
        where it held and how long each ask took."""
        deadline, failed = time.monotonic() + GRACE, 0
        while True:
            opens[0] += 1
            started = time.monotonic()
            carrier, stage, status = opened(rank, port, link, resume, opens[0], deadline)
            now = time.monotonic()
            if carrier is not None:
                if failed:
                    sys.stderr.write("%s %s: a WebSocket again after %d failed\n" % (time.strftime("%H:%M:%S"), name, failed))
                return carrier
            failed += 1
            sys.stderr.write("%s %s: open %d failed: %s (stage %s, %.2f s)\n"
                             % (time.strftime("%H:%M:%S"), name, opens[0], status.decode(errors="replace"), stage, now - started))
            if now > deadline:
                sys.stderr.write("%s %s: no WebSocket: %s\n" % (time.strftime("%H:%M:%S"), name, status.decode(errors="replace")))
                return None
            time.sleep(0.5)

    carrier = reopen(resume=False)
    if carrier is None:
        local.close()
        return
    Link(local, name, carrier, reopen).run()


def outbound(local):
    port, address = struct.unpack("!2xH4s8x", local.getsockopt(socket.SOL_IP, 80, 16))
    carry(local, int(socket.inet_ntoa(address).rsplit(".", 1)[1]) - 1, port)


def accept(link, port, resume):
    """The far relay's open of link to this rank's port, which the hub said: this end's WebSocket for it, paired; then
    the link's next carrier where this end holds it; else, for a new link, a connection to its port on this rank's
    address, or 'g' when that or the link is gone. Its own open is bounded and said as the far relay's is: the far
    relay asks again, the hub having said it again, when this fails."""
    started = time.monotonic()
    deadline = started + BUDGET
    carrier, stage, status = dialled(RANK, "link", "id=%s&accept=1&from=%d" % (link, RANK), deadline)
    if carrier is not None:
        carrier, stage, status = paired(carrier, deadline)
    if carrier is None:
        sys.stderr.write("%s port %d from link %s: no WebSocket for it: %s (stage %s, %.2f s)\n"
                         % (time.strftime("%H:%M:%S"), port, link, status.decode(errors="replace"), stage, time.monotonic() - started))
        return
    with LINKED:
        held = LINKS.get(link)
    if held is not None:
        held.handover(carrier)
        return
    try:
        if resume:
            raise ConnectionError("the link is gone")
        local = socket.create_connection((OWN, port))
    except OSError:
        try:
            carrier.put(True, b"g")
        finally:
            carrier.close()
        return
    local.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def register(held):
        # Before its first carrier takes it, so a resume that comes at once finds it.
        with LINKED:
            LINKS[link] = held

    held = Link(local, "port %d from link %s" % (port, link), carrier, held=register)
    try:
        held.run()
    finally:
        with LINKED:
            LINKS.pop(link, None)


def control():
    """This rank's control socket at its hub, kept open: each open of a link to this rank it says
    ('o <link> <port> <0|1>') is taken up (accept). One that goes is said and opened again; the hub keeps the opens
    waiting meanwhile, so a far relay's open outlives it. Every open of it is bounded as a link's is, and every failed
    one said. A socket that carries nothing either way, with no FIN or RST to say so, is found by its heartbeat
    (heartbeat): one that hears nothing for SILENCE seconds is closed and opened again."""
    opens = failed = 0
    while True:
        opens += 1
        started = time.monotonic()
        carrier, stage, status = dialled(RANK, "control", "from=%d&n=%d" % (RANK, opens), started + BUDGET)
        if carrier is None:
            failed += 1
            sys.stderr.write("%s control: open %d failed: %s (stage %s, %.2f s)\n"
                             % (time.strftime("%H:%M:%S"), opens, status.decode(errors="replace"), stage, time.monotonic() - started))
            time.sleep(0.5)
            continue
        # Each read waits SILENCE for a byte: the hub's answer to a heartbeat, or an open it says, or a ping, ends it.
        carrier.ws.settimeout(SILENCE)
        if failed:
            sys.stderr.write("%s control: open %d came back after %d failed\n" % (time.strftime("%H:%M:%S"), opens, failed))
            failed = 0
        beating = threading.Event()
        threading.Thread(target=heartbeat, args=(carrier, beating), daemon=True).start()
        try:
            while True:
                text, data = carrier.take()
                if text and data[:2] == b"o ":
                    _, link, port, resume = data.decode().split()
                    threading.Thread(target=guarded, args=(accept, link, int(port), resume == "1"), daemon=True).start()
        except (EOFError, OSError) as error:
            if isinstance(error, socket.timeout):
                sys.stderr.write("%s control: silent for %g s, not even its heartbeat answered; opening it again\n" % (time.strftime("%H:%M:%S"), SILENCE))
            else:
                sys.stderr.write("%s control: %r; opening it again\n" % (time.strftime("%H:%M:%S"), error))
        finally:
            beating.set()
            carrier.close()


def heartbeat(carrier, over):
    """Says 'p' on a control socket every KEEPALIVE seconds, which its hub says back: the socket is never idle for
    Cloudflare, which closes one after 100 s without data, and what is said back is what control's SILENCE waits for.
    Until the socket goes, which sets over."""
    while not over.wait(KEEPALIVE):
        try:
            with carrier.lock:
                carrier.put(True, b"p")
        except (OSError, ValueError):
            return


def serve(address, handle):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(address)
    server.listen(128)
    while True:
        conn = server.accept()[0]
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=guarded, args=(handle, conn), daemon=True).start()


def guarded(handle, *args):
    """handle(*args) on its own thread: what it raises is said, and a connection it was given closed."""
    try:
        handle(*args)
    except Exception as error:
        sys.stderr.write("%s: %r\n" % (handle.__name__, error))
        for each in args:
            if isinstance(each, socket.socket):
                each.close()


if __name__ == "__main__":
    threading.Thread(target=control, daemon=True).start()
    serve(("127.0.0.1", OUT), outbound)
`;
