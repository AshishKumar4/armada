"""The relay's TLS links, for relay-tls.test.ts. relay.py comes on stdin; argv is a mode and its arguments, and what
the mode saw is one JSON object on stdout.

churn <origin> <workers> <cycles>: both ends of a link in this one process, as two ranks' relays, over the hub at
origin (a TLS WebSocket server the test serves). Each of `workers` threads makes `cycles` links in turn, until one
fails: a program's connection to an echo server on rank 0's address goes out through the relay's `carry`, sends a
pattern of its own and reads it back whole, then closes, by a reset one time in three and by a half-close the rest,
and the next link opens at once, on whatever descriptor the last one gave up. Then it says how many echoes came back
whole and what the rest were, the TLS contexts the process held (the most at any 50 ms, and at the end) and the links
it still holds once every one has ended: a link's own threads end with it, and nothing else may keep it.

blocked <cert> <key>: one carrier over TLS to a hub that never reads and never speaks, a thread blocked in its read and
another in its write (the hub's window full), closed from two threads at once. Then it says whether both threads left
and the close returned."""
import base64
import concurrent.futures
import gc
import hashlib
import json
import socket
import ssl
import struct
import sys
import threading
import time
from urllib.parse import urlsplit

mode, source = sys.argv[1], sys.stdin.read()


def load(origin):
    """relay.py as rank 0 of a gang whose hub is at origin, its definitions in a namespace of their own."""
    sys.argv = ["relay.py", "0", origin, "job", "token", "0", "1"]
    relay = {"__name__": "relay"}
    exec(source, relay)
    return relay


def contexts():
    """The TLS contexts this process holds, however they were made: each is a copy of its trust roots."""
    return sum(isinstance(each, ssl.SSLContext) for each in gc.get_objects())


def churn(origin, workers, cycles):
    relay = load(origin)
    threading.Thread(target=relay["control"], daemon=True).start()
    echo = socket.create_server((relay["OWN"], 0))

    def answer(conn):
        try:
            with conn:
                while data := conn.recv(65536):
                    conn.sendall(data)
        except OSError:
            pass

    def serve():
        while True:
            threading.Thread(target=answer, args=(echo.accept()[0],), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    counts, errors, lock = {}, [], threading.Lock()

    def cycle(worker):
        for i in range(cycles):
            program, local = socket.socketpair()
            threading.Thread(target=relay["carry"], args=(local, 0, echo.getsockname()[1]), daemon=True).start()
            data = hashlib.sha256(("%d:%d" % (worker, i)).encode()).digest() * (1 + i % 200)
            got = bytearray()
            try:
                with program:
                    program.settimeout(5)
                    program.sendall(data)
                    while len(got) < len(data):
                        chunk = program.recv(len(data) - len(got))
                        if not chunk:
                            break
                        got.extend(chunk)
                    if got != data:
                        raise AssertionError("echo %d/%d, prefix %s" % (len(got), len(data), data.startswith(got)))
                    if i % 3 == 0:
                        program.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    else:
                        program.shutdown(socket.SHUT_WR)
                        while program.recv(65536):
                            pass
                status = "ok"
            except Exception as error:
                status = type(error).__name__
                with lock:
                    errors.append("%d:%d %r" % (worker, i, error))
            with lock:
                counts[status] = counts.get(status, 0) + 1
            if status != "ok":
                # One failed link is the finding; the rest of a broken relay's would each wait out its program's timeout.
                return

    peak, sampled = [contexts()], threading.Event()

    def sample():
        while not sampled.wait(0.05):
            peak[0] = max(peak[0], contexts())

    threading.Thread(target=sample, daemon=True).start()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(cycle, range(workers)))
    sampled.set()

    def held():
        gc.collect()
        return sum(isinstance(each, relay["Link"]) for each in gc.get_objects())

    # A link's last thread may still be winding down when its program has its end; what remains after that holds it.
    deadline = time.monotonic() + 5
    while held() and time.monotonic() < deadline:
        time.sleep(0.05)
    print(json.dumps({"counts": counts, "errors": errors, "contexts": {"peak": peak[0], "end": contexts()}, "links": held()}), flush=True)


def blocked(cert, key):
    relay = load("https://127.0.0.1:1")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    listener = socket.create_server(("127.0.0.1", 0))
    kept = []

    def hub():
        """Takes one open and answers its upgrade, then holds the connection and reads nothing."""
        conn = context.wrap_socket(listener.accept()[0], server_side=True)
        request = b""
        while not request.endswith(b"\r\n\r\n"):
            request += conn.recv(1)
        asked = [line.split(b":")[1].strip() for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key")][0]
        proof = base64.b64encode(hashlib.sha1(asked + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: " + proof + b"\r\n\r\n")
        kept.append(conn)

    threading.Thread(target=hub, daemon=True).start()
    relay["ORIGIN"] = urlsplit("https://127.0.0.1:%d" % listener.getsockname()[1])
    carrier, stage, status = relay["dialled"](1, "link", "id=0123456789abcdef&port=9000", time.monotonic() + 20)
    if carrier is None:
        raise SystemExit("no carrier: %s, %r" % (stage, status))
    carrier.ws.settimeout(None)
    block, written = b"w" * 65536, [0]

    def read():
        try:
            carrier.take()
        except (EOFError, OSError):
            pass

    def write():
        try:
            while True:
                with carrier.lock:
                    carrier.put(False, block)
                written[0] += len(block)
        except OSError:
            pass

    reader, writer = threading.Thread(target=read, daemon=True), threading.Thread(target=write, daemon=True)
    reader.start()
    writer.start()
    # The write is blocked once the hub's window and the carrier's buffers are full: no more bytes leave it.
    stalled, seen, deadline = False, -1, time.monotonic() + 20
    while time.monotonic() < deadline:
        time.sleep(0.5)
        if written[0] and written[0] == seen:
            stalled = True
            break
        seen = written[0]
    closers = [threading.Thread(target=carrier.close, daemon=True) for _ in range(2)]
    for each in closers:
        each.start()
    # All four have 5 s between them: a thread that never leaves costs 5 s, not 5 s of each wait for it.
    deadline = time.monotonic() + 5
    for each in closers + [reader, writer]:
        each.join(max(0, deadline - time.monotonic()))
    print(json.dumps({"stalled": stalled, "closed": not any(each.is_alive() for each in closers), "gone": carrier.ws.fileno() == -1,
                      "read": not reader.is_alive(), "write": not writer.is_alive()}), flush=True)


if mode == "churn":
    churn(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
else:
    blocked(sys.argv[2], sys.argv[3])
