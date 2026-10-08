"""A gang's relay under the load of a collective: every rank serves, and every rank streams to the next one in a
ring at once, as a ring all-reduce's steps do, ROUNDS times with an idle wait between, each stream checked byte for
byte by its digest. Rank 0 first times round trips to rank 1. It fails past bounds a working relay is far inside:
the Worker is in every round trip, so this proves the path holds under load, not a speed."""
import hashlib
import os
import socket
import sys
import threading
import time

RANK, WORLD = int(os.environ["ARMADA_RANK"]), int(os.environ["ARMADA_WORLD"])
PORT = 9000
ROUNDS, STREAM, IDLE = 3, 256 << 20, 45
BLOCK = hashlib.sha256(b"armada relay").digest() * (1 << 15)
MAX_P50_MS, MIN_MB_PER_S = 250, 1
PEER = f"rank{(RANK + 1) % WORLD}"
streamed = threading.Semaphore(0)


def exactly(conn: socket.socket, size: int) -> bytes:
    got = b""
    while len(got) < size:
        chunk = conn.recv(size - len(got))
        if not chunk:
            raise ConnectionError(f"rank {RANK}: the connection closed {size - len(got)} bytes short")
        got += chunk
    return got


def serve(conn: socket.socket) -> None:
    """An echo of 64-byte round trips, or a stream's digest once it ends."""
    with conn:
        kind = conn.recv(1)
        conn.sendall(b"r")
        if kind == b"e":
            while data := conn.recv(64):
                conn.sendall(data)
            return
        digest = hashlib.sha256()
        while data := conn.recv(1 << 20):
            digest.update(data)
        conn.sendall(digest.digest())
        streamed.release()


def ready(kind: bytes) -> socket.socket:
    """A connection to the next rank's server, which has answered: one the relay took before that server listened
    closes at once, and is opened again."""
    deadline = time.monotonic() + 300
    while True:
        conn = socket.create_connection((PEER, PORT), timeout=300)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn.sendall(kind)
        if conn.recv(1) == b"r":
            return conn
        conn.close()
        if time.monotonic() > deadline:
            raise ConnectionError(f"rank {RANK}: {PEER} never answered")
        time.sleep(0.5)


def accept(server: socket.socket) -> None:
    while True:
        threading.Thread(target=serve, args=(server.accept()[0],), daemon=True).start()


threading.Thread(target=accept, args=(socket.create_server(("0.0.0.0", PORT), backlog=8),), daemon=True).start()
failures = []
if RANK == 0:
    with ready(b"e") as echo:
        times = []
        for _ in range(100):
            start = time.perf_counter()
            echo.sendall(b"x" * 64)
            exactly(echo, 64)
            times.append(time.perf_counter() - start)
    times.sort()
    p50 = 1000 * times[50]
    print(f"round trip p50 {p50:.1f} ms, p90 {1000 * times[90]:.1f} ms", flush=True)
    if p50 > MAX_P50_MS:
        failures.append(f"round trip p50 {p50:.1f} ms")
for round_ in range(ROUNDS):
    expected = hashlib.sha256()
    with ready(b"s") as sink:
        start = time.perf_counter()
        for _ in range(STREAM // len(BLOCK)):
            sink.sendall(BLOCK)
            expected.update(BLOCK)
        sink.shutdown(socket.SHUT_WR)
        digest = exactly(sink, 32)
        rate = STREAM / (time.perf_counter() - start) / 1e6
    if digest != expected.digest():
        failures.append(f"round {round_}: {PEER} received other bytes than were sent")
    if rate < MIN_MB_PER_S:
        failures.append(f"round {round_}: {rate:.1f} MB/s")
    # The previous rank's stream of this round has to have ended here too before the ring idles.
    if not streamed.acquire(timeout=600):
        failures.append(f"round {round_}: the previous rank's stream never ended")
    print(f"rank {RANK} round {round_}: {STREAM >> 20} MB to {PEER} at {rate:.1f} MB/s", flush=True)
    if round_ + 1 < ROUNDS:
        time.sleep(IDLE)
print("\n".join(failures) or f"rank {RANK}: every stream arrived whole", flush=True)
sys.exit(1 if failures else 0)
