"""A gang's relay, measured: rank 0 serves an echo on rank0, and rank 1 reaches it by name, then times 100 round
trips and a 20 MB transfer. It fails past bounds a working relay is far inside: the Worker is in every round trip,
so this proves the path, not a speed."""
import os
import socket
import sys
import time

RANK = int(os.environ["ARMADA_RANK"])
PORT = 9000
MAX_P50_MS, MIN_MB_PER_S = 250, 1

if RANK == 0:
    server = socket.create_server(("0.0.0.0", PORT))
    for _ in range(2):
        conn = server.accept()[0]
        while data := conn.recv(1 << 16):
            # Round trips are echoed, and the bulk transfer is drained.
            if len(data) <= 64:
                conn.sendall(data)
        conn.close()
    sys.exit(0)

conn = socket.create_connection(("rank0", PORT), timeout=60)
conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
times = []
for _ in range(100):
    start = time.perf_counter()
    conn.sendall(b"x" * 64)
    got = b""
    while len(got) < 64:
        got += conn.recv(64 - len(got))
    times.append(time.perf_counter() - start)
conn.close()
times.sort()
bulk = socket.create_connection(("rank0", PORT), timeout=60)
start = time.perf_counter()
bulk.sendall(b"x" * (20 << 20))
bulk.shutdown(socket.SHUT_WR)
bulk.recv(1)
rate = 20 / (time.perf_counter() - start)
p50 = 1000 * times[50]
print(f"round trip p50 {p50:.1f} ms, p90 {1000 * times[90]:.1f} ms; {rate:.1f} MB/s")
sys.exit(0 if p50 < MAX_P50_MS and rate > MIN_MB_PER_S else 1)
