import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { RELAY_PY } from '../src/relay';

/** The carrier's real control socket (`control`) against a hub a test plays in Python, with its heartbeat and its
 *  silence bound shortened to a fraction of a second or two. The hub is `echo`, which says back what a relay says to it,
 *  as `ArmadaHub` does, or `mute`, which hears everything its relay sends and says nothing, and never closes: a
 *  connection that stopped carrying traffic one way, with no FIN or RST on it. The second connection, whichever the
 *  first was, is an echo.
 *
 *  Nothing here waits a guessed time for anything to have happened: the hub's threads say each connection, each frame
 *  heard and each close under one condition, and the script waits on what it needs (`until`) under a deadline far past
 *  any load, then prints what the hub saw. `echo` waits for HEARTBEATS frames on the first connection, which spans more
 *  than the silence bound however slowly they came; `mute` for the relay to close the first connection and its
 *  replacement to be heard. */
const CONTROL = String.raw`
import base64, hashlib, json, socket, sys, threading, time
mode, source = sys.argv[1], sys.stdin.read()
HEARTBEATS = 12
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(8)
sys.argv = ["relay.py", "3", "http://127.0.0.1:%d" % listener.getsockname()[1], "job", "token", "1", "1"]
relay = {"__name__": "relay_test"}
exec(source, relay)
relay["KEEPALIVE"], relay["SILENCE"] = 0.25, 2.0
connections = []
changed = threading.Condition()

def until(predicate, seconds=30):
    with changed:
        return changed.wait_for(predicate, timeout=seconds)

def frames(conn, record, behave):
    """The relay's frames, masked, counted and timed; answered as behave says."""
    held = bytearray()
    while True:
        data = conn.recv(4096)
        if not data:
            with changed:
                record["closed"] = True
                changed.notify_all()
            return
        held += data
        while len(held) >= 6 and len(held) >= 6 + (held[1] & 0x7F):
            opcode, n = held[0] & 0x0F, held[1] & 0x7F
            del held[:6 + n]
            with changed:
                now = time.monotonic()
                record["frames"] += 1
                record["first"] = now if record["first"] is None else record["first"]
                record["last"] = now
                changed.notify_all()
            if behave == "echo":
                # A text frame is answered with the same, as the hub answers a heartbeat; a ping with a pong.
                conn.sendall(b"\x81\x01p" if opcode == 1 else b"\x8a\x00" if opcode == 9 else b"")

def serve():
    while True:
        conn = listener.accept()[0]
        request = b""
        while not request.endswith(b"\r\n\r\n"):
            request += conn.recv(1)
        key = [line.split(b":")[1].strip() for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key")][0]
        proof = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: " + proof + b"\r\n\r\n")
        record = {"frames": 0, "closed": False, "first": None, "last": None}
        with changed:
            connections.append(record)
            behave = mode if len(connections) == 1 else "echo"
            changed.notify_all()
        threading.Thread(target=frames, args=(conn, record, behave), daemon=True).start()

threading.Thread(target=serve, daemon=True).start()
threading.Thread(target=relay["control"], daemon=True).start()
if mode == "echo":
    reached = until(lambda: len(connections) >= 2 or (len(connections) == 1 and connections[0]["frames"] >= HEARTBEATS))
else:
    reached = until(lambda: len(connections) >= 2 and connections[0]["closed"] and connections[1]["frames"] >= 1)
with changed:
    seen = [{"frames": each["frames"], "closed": each["closed"], "span": (each["last"] or 0) - (each["first"] or 0)} for each in connections]
print(json.dumps({"reached": reached, "silence": relay["SILENCE"], "connections": seen}))
`;

const SeenSchema = v.object({
  reached: v.boolean(),
  silence: v.number(),
  connections: v.array(v.object({ frames: v.number(), closed: v.boolean(), span: v.number() })),
});

async function control(mode: 'echo' | 'mute') {
  const run = Bun.spawn(['python3', '-c', CONTROL, mode], { stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

  return { ...v.parse(SeenSchema, JSON.parse(out)), err, code };
}

describe('a relay\'s control socket at its rank\'s hub (Dew ledger 1401)', () => {
  test('stays open, and quiet in the log, while idle for many heartbeats, when its hub answers each', async () => {
    const { reached, silence, connections, err, code } = await control('echo');
    const [first] = connections;

    // Twelve heartbeats, each a keepalive apart, outlast the silence bound; the one connection was never reopened.
    expect({ code, reached, opened: connections.length, heartbeats: (first?.frames ?? 0) >= 12, outlasted: (first?.span ?? 0) > silence, err })
      .toEqual({ code: 0, reached: true, opened: 1, heartbeats: true, outlasted: true, err: '' });
  }, 60_000);

  test('is closed and opened again when its hub, which still hears it, answers nothing, and says why', async () => {
    const { reached, connections, err, code } = await control('mute');
    const [first, second] = connections;

    // The hub heard the relay's heartbeats on the first connection, which the relay closed, and a second took up.
    expect({ code, reached, opened: connections.length, heard: (first?.frames ?? 0) >= 1, closed: first?.closed, next: (second?.frames ?? 0) >= 1 })
      .toEqual({ code: 0, reached: true, opened: 2, heard: true, closed: true, next: true });
    expect(err).toMatch(/control: silent for [\d.]+ s, not even its heartbeat answered; opening it again/u);
  }, 60_000);
});
