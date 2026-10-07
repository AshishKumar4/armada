/**
 * A gang's network. Containers have outbound internet and no inbound address, and a Durable Object can open TCP into
 * its own container (`getTcpPort`). So each rank r of a gang is host `rank<r>` at 127.0.1.<r + 1> in every container,
 * and a connection to another rank's address goes: a DNAT to this relay's OUT port, a WebSocket to the Worker's
 * `/relay/<job>/<vessel>` (`relayed`), that rank's vessel, which opens the relay's IN port in its container and names
 * the port, and a connection there to the port on the rank's own address. Any TCP a program speaks runs over it
 * unchanged: jax.distributed's coordinator, gloo's collectives, a database.
 */
import { STATE } from './container';

/** Where a rank's peers' connections arrive (loopback, DNAT'd to) and where its vessel connects in (every address). */
export const RELAY_OUT = 7911;

export const RELAY_IN = 7912;

/** The relay's script in a container. */
export const RELAY = `${STATE}/relay.py`;

/** The header a relay's WebSocket presents the gang's token in. */
export const RELAY_HEADER = 'armada-relay';

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
setsid python3 ${RELAY} "$rank" "$@" > ${STATE}/relay.log 2>&1 < /dev/null &
echo $! > ${STATE}/relay.pid
n=0
until ss -ltn | grep -q ':${String(RELAY_OUT)} ' && ss -ltn | grep -q ':${String(RELAY_IN)} '; do
  n=$((n + 1))
  [ "$n" -lt 200 ] || { cat ${STATE}/relay.log >&2; exit 1; }
  sleep 0.05
done`;

/** The relay: `relay.py <rank> <origin> <job> <token> <vessel of rank 0> <vessel of rank 1> ...`. Each connection is a
 *  thread pair; a WebSocket frame carries at most 64 KiB, under the Workers runtime's message limit. A rank whose
 *  vessel refuses (it has not taken up the gang yet) is asked again for up to a minute. */
export const RELAY_PY = String.raw`import base64, os, socket, ssl, struct, sys, threading, time
from urllib.parse import urlsplit

OUT, IN = ${String(RELAY_OUT)}, ${String(RELAY_IN)}
PATIENCE = 60
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


def frame(ws, lock, opcode, data):
    mask, n = os.urandom(4), len(data)
    size = bytes([0x80 | n]) if n < 126 else bytes([0xFE]) + struct.pack("!H", n) if n < 65536 else bytes([0xFF]) + struct.pack("!Q", n)
    body = (int.from_bytes(data, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big") if n else b""
    with lock:
        ws.sendall(bytes([0x80 | opcode]) + size + mask + body)


def close(sock):
    try:
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def from_ws(ws, lock, local):
    try:
        while True:
            head, length = exact(ws, 2)
            n = length & 0x7F
            n = struct.unpack("!H", exact(ws, 2))[0] if n == 126 else struct.unpack("!Q", exact(ws, 8))[0] if n == 127 else n
            data, opcode = exact(ws, n), head & 0x0F
            if opcode in (0, 1, 2):
                local.sendall(data)
            elif opcode == 9:
                frame(ws, lock, 10, data)
            elif opcode == 8:
                break
    except (EOFError, OSError):
        pass
    close(local)


def opened(rank, port):
    """A WebSocket to rank's vessel for its port, or the status line it was refused with."""
    host, secure = ORIGIN.hostname, ORIGIN.scheme == "https"
    raw = socket.create_connection((host, ORIGIN.port or (443 if secure else 80)), timeout=30)
    ws = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if secure else raw
    ws.sendall(("GET /relay/%s/%s?port=%d HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n${RELAY_HEADER}: %s\r\n\r\n"
                % (JOB, VESSELS[rank], port, host, base64.b64encode(os.urandom(16)).decode(), TOKEN)).encode())
    answer = b""
    while not answer.endswith(b"\r\n\r\n"):
        answer += exact(ws, 1)
    status = answer.split(b"\r\n", 1)[0]
    if b" 101 " in status:
        ws.settimeout(None)
        return ws, status
    ws.close()
    return None, status


def outbound(local):
    port, address = struct.unpack("!2xH4s8x", local.getsockopt(socket.SOL_IP, 80, 16))
    rank = int(socket.inet_ntoa(address).rsplit(".", 1)[1]) - 1
    # A rank whose vessel has not taken up the gang yet refuses: the ranks start within seconds of each other.
    deadline = time.monotonic() + PATIENCE
    ws, status = opened(rank, port)
    while ws is None and time.monotonic() < deadline:
        time.sleep(0.5)
        ws, status = opened(rank, port)
    if ws is None:
        sys.stderr.write("rank %d port %d: %s\n" % (rank, port, status.decode(errors="replace")))
        local.close()
        return
    lock = threading.Lock()
    threading.Thread(target=from_ws, args=(ws, lock, local), daemon=True).start()
    try:
        while True:
            data = local.recv(65536)
            if not data:
                break
            frame(ws, lock, 2, data)
        frame(ws, lock, 8, struct.pack("!H", 1000))
    except OSError:
        pass


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
