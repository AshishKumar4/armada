import { describe, expect, test } from 'bun:test';
import { RELAY_PY } from '../src/relay';

/** Executes the shipped carrier with only its clock, dial and Link replaced: no listeners, containers or sleeps.
 *  Three identical refusals must remain three observations, not disappear behind status-change throttling. */
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
    return (None, b"HTTP/1.1 503 Service Unavailable") if calls[0] <= 3 else (object(), b"HTTP/1.1 101 Switching Protocols")
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

describe('the carrier reports each relay open (Dew ledger 1401)', () => {
  test('says the attempt and status even when consecutive failures have the same status', async () => {
    const run = Bun.spawn(['python3', '-c', OPENS], {
      stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

    expect({ code, out: out.trim() }).toEqual({ code: 0, out: '{"calls": 4}' });
    expect(err.split('\n').filter((line) => line.includes(' failed: '))).toEqual([1, 2, 3].map((attempt) =>
      `08:26:17 rank 2 port 33133: open ${String(attempt)} failed: HTTP/1.1 503 Service Unavailable`));
  });
});
