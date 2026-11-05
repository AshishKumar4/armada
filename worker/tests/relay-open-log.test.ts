import { describe, expect, test } from 'bun:test';
import { RELAY_PY } from '../src/relay';

/** Executes the shipped carrier with only its clock, dial and Link replaced: no listeners, containers or sleeps.
 *  Three identical refusals must remain three observations, not disappear behind status-change throttling, each with
 *  the stage it failed in and how long it took. */
const OPENS = String.raw`
import json, sys, types
source = sys.stdin.read()
sys.argv = ["relay.py", "3", "http://relay.invalid", "job", "token", "v6", "v12", "v10", "v8"]
relay = {"__name__": "relay_test"}
exec(source, relay)
clock, calls = [0.0], [0]
def sleep(seconds):
    clock[0] += seconds
def opened(*args):
    calls[0] += 1
    return (None, "upgrade", b"HTTP/1.1 503 Service Unavailable") if calls[0] <= 3 else (object(), "pair", b"paired")
class Link:
    def __init__(self, *args):
        pass
    def run(self):
        pass
relay["time"] = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=sleep, strftime=lambda _: "08:26:17")
relay["opened"], relay["Link"] = opened, Link
relay["carry"](None, 2, 33133)
print(json.dumps({"calls": calls[0]}))
`;

/** The carrier's real opens, against a hub a test plays as a socket: each of the open's stages, with its budget
 *  (0.3 s) short. A silent hub, one that never answers a handshake, one that trickles its answer a byte at a time, and
 *  one that never pairs must each end the open at the budget, not a read's, with the stage it was in, and leave its
 *  connection closed. */
const BOUNDS = String.raw`
import base64, hashlib, json, socket, sys, threading, time
from urllib.parse import urlsplit
source = sys.stdin.read()
sys.argv = ["relay.py", "3", "http://127.0.0.1:1", "job", "token", "1", "1"]
relay = {"__name__": "relay_test"}
exec(source, relay)
BUDGET = 0.3

def hub(behave):
    """A hub that takes one connection and behaves as behave says; its port, and an event set once it saw the connection close."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    closed = threading.Event()
    def run():
        conn = listener.accept()[0]
        request = b""
        while not request.endswith(b"\r\n\r\n"):
            chunk = conn.recv(1)
            if not chunk:
                closed.set()
                return
            request += chunk
        try:
            behave(conn, request)
            while conn.recv(1):
                pass
        except OSError:
            pass
        closed.set()
    threading.Thread(target=run, daemon=True).start()
    return listener.getsockname()[1], closed

def silent(conn, request):
    pass

def trickle(conn, request):
    while True:
        for byte in b"HTTP/1.1 101 Switching Protocols\r\n":
            conn.sendall(bytes([byte]))
            time.sleep(0.05)

def refusing(conn, request):
    conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\n\r\n")

def unpaired(conn, request):
    key = [line.split(b":")[1].strip() for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key")][0]
    proof = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
    conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: " + proof + b"\r\n\r\n")

def attempt(port, scheme="http"):
    relay["ORIGIN"] = urlsplit("%s://127.0.0.1:%d" % (scheme, port))
    started = time.monotonic()
    deadline = started + BUDGET
    carrier, stage, status = relay["dialled"](3, "link", "id=0123456789abcdef&port=9000", deadline)
    if carrier is not None:
        carrier, stage, status = relay["paired"](carrier, deadline)
    return started, carrier, stage, status

results = {}
free = socket.socket()
free.bind(("127.0.0.1", 0))
gone = free.getsockname()[1]
free.close()
started, carrier, stage, status = attempt(gone)
results["refused"] = {"stage": stage, "why": status.decode(), "within": time.monotonic() - started < 1.5, "left": carrier is None}
for name, behave, scheme in (("silent", silent, "http"), ("handshake", silent, "https"), ("trickle", trickle, "http"), ("refusing", refusing, "http"), ("unpaired", unpaired, "http")):
    port, closed = hub(behave)
    started, carrier, stage, status = attempt(port, scheme)
    took = time.monotonic() - started
    results[name] = {"stage": stage, "why": status.decode(), "within": took < 1.5, "spent": took >= BUDGET - 0.05, "left": carrier is None, "closed": closed.wait(3)}
print(json.dumps(results))
`;

async function python(script: string) {
  const run = Bun.spawn(['python3', '-c', script], { stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

  return { out: out.trim(), err, code };
}

describe('the carrier reports each relay open (Dew ledger 1401)', () => {
  test('says the attempt, status, stage and duration even when consecutive failures have the same status', async () => {
    const { out, err, code } = await python(OPENS);

    expect({ code, out }).toEqual({ code: 0, out: '{"calls": 4}' });
    expect(err.split('\n').filter((line) => line.includes(' failed: '))).toEqual([1, 2, 3].map((attempt) =>
      `08:26:17 rank 2 port 33133: open ${String(attempt)} failed: HTTP/1.1 503 Service Unavailable (stage upgrade, 0.00 s)`));
  });

  test('ends an open at its budget as a whole, in the stage it was in, and closes its connection', async () => {
    const { out, err, code } = await python(BOUNDS);

    expect({ code, err }).toEqual({ code: 0, err: '' });
    const results: Record<string, { stage: string; why: string; within: boolean; spent?: boolean; left: boolean; closed?: boolean }> = JSON.parse(out);

    expect(Object.fromEntries(Object.entries(results).map(([name, each]) => [name, [each.stage, each.within, each.spent, each.left, each.closed]]))).toEqual({
      refused: ['connect', true, undefined, true, undefined],
      // A trickling hub resets a read's timeout with each byte; only the open's budget ends it.
      silent: ['upgrade', true, true, true, true], handshake: ['tls', true, true, true, true], trickle: ['upgrade', true, true, true, true],
      refusing: ['upgrade', true, false, true, true], unpaired: ['pair', true, true, true, true],
    });
    expect([results['refused']?.why, results['refusing']?.why]).toEqual([expect.stringContaining('ConnectionRefusedError'), 'HTTP/1.1 503 Service Unavailable']);
    expect([results['silent']?.why, results['handshake']?.why, results['trickle']?.why, results['unpaired']?.why].every((why) => why?.includes('timed out') === true || why?.includes('time is spent') === true)).toBe(true);
  });
});
