import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { gone, passed } from '../src/pairing';
import { RELAY_PY } from '../src/relay';
import { admit, BunSockets, opening, type Opened } from './relay-hub';

/** How long the driver may run, in milliseconds: far past the seconds it takes, under the tests' own timeout. */
const BOUND = 45_000;

/** The driver runs the shipped relay in a Python process of its own, over TLS to what a test serves; its modes are
 *  described in it. */
const DRIVER = join(import.meta.dir, 'relay-tls.py');

const ChurnSchema = v.object({
  counts: v.record(v.string(), v.number()),
  errors: v.array(v.string()),
});

const BlockedSchema = v.object({ stalled: v.boolean(), closed: v.boolean(), gone: v.boolean(), read: v.boolean(), write: v.boolean() });

/** A temporary CA, and a server certificate it signs for 127.0.0.1: the paths of the CA's certificate, which the relay
 *  trusts, and of the server's certificate and key. */
interface Authority {
  readonly trust: string;
  readonly cert: string;
  readonly key: string;
}

/** `use` given a temporary CA in a directory of its own, removed after it. */
async function withAuthority<T>(use: (pki: Authority, scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'armada-relay-tls-'));

  const openssl = async (...args: string[]) => {
    const run = Bun.spawn(['openssl', ...args], { cwd: scratch, stdout: 'ignore', stderr: 'pipe' });
    const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);

    if (code !== 0) throw new Error(`openssl ${args.join(' ')} exited ${String(code)}: ${err}`);
  };

  try {
    writeFileSync(join(scratch, 'server.ext'), [
      'subjectAltName=IP:127.0.0.1,DNS:localhost', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth', 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid', '',
    ].join('\n'));

    const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

    await openssl('req', '-x509', ...curve, '-days', '1', '-subj', '/CN=armada relay test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.pem');
    await openssl('req', '-new', ...curve, '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr');
    await openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'server.ext', '-out', 'server.pem');

    return await use({ trust: join(scratch, 'ca.pem'), cert: join(scratch, 'server.pem'), key: join(scratch, 'server.key') }, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The driver in `mode` with `args`, the relay on its stdin and only the temporary CA trusted (no root of this
 *  machine's, and no directory of them), ended past BOUND: what it printed and said, and its exit. */
async function drive(mode: 'churn' | 'blocked', args: readonly string[], pki: Authority, scratch: string) {
  const run = Bun.spawn(['python3', DRIVER, mode, ...args], {
    stdin: new TextEncoder().encode(RELAY_PY), stdout: 'pipe', stderr: 'pipe', timeout: BOUND,
    env: { ...process.env, SSL_CERT_FILE: pki.trust, SSL_CERT_DIR: scratch },
  });

  try {
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

    return { out: out.trim(), err, code };
  } finally {
    run.kill();
  }
}

/** `workers` threads each making `cycles` links through the relay and a hub that pairs them as `ArmadaHub` does and
 *  serves TLS under the temporary CA. */
async function churn(workers: number, cycles: number) {
  return await withAuthority(async (pki, scratch) => {
    const hub = new BunSockets();

    const server = Bun.serve<Opened>({
      port: 0,
      tls: { key: Bun.file(pki.key), cert: Bun.file(pki.cert) },
      fetch(request, bun) {
        return bun.upgrade(request, { data: opening(request) }) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          admit(hub, ws);
        },
        message(ws, message) {
          const bytes = message instanceof Uint8Array ? message : null;

          passed(hub, ws, bytes === null ? String(message) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        },
        close(ws) {
          hub.gone(ws);
          gone(hub, ws);
        },
      },
    });

    try {
      const { out, err, code } = await drive('churn', [`https://127.0.0.1:${String(server.port)}`, String(workers), String(cycles)], pki, scratch);

      return { ...v.parse(ChurnSchema, JSON.parse(out)), err, code };
    } finally {
      await server.stop(true);
    }
  });
}

describe('a relay\'s links over TLS', () => {
  // A link closed its TLS socket while another thread of it was still inside a read of it. OpenSSL keeps the descriptor's
  // number, which the next link's socket took: the old read then took that connection's bytes and wrote a TLS alert into
  // it, and the echoes came back short and the opens failed in their handshake.
  test('carries every echo whole, and fails no TLS handshake, while links open and close in parallel', async () => {
    const { counts, errors, err, code } = await churn(8, 25);

    expect({ code, counts, errors }).toEqual({ code: 0, counts: { ok: 8 * 25 }, errors: [] });
    expect(err.split('\n').filter((line) => /ssl/iu.test(line))).toEqual([]);
  }, 60_000);

  test('closes a carrier at once whose read and write are both blocked, closed from two threads at once', async () => {
    const { out, code } = await withAuthority(async (pki, scratch) => await drive('blocked', [pki.cert, pki.key], pki, scratch));

    // The hub never reads: the write has filled its window and every buffer, and the read waits for a word.
    expect({ code, ...v.parse(BlockedSchema, JSON.parse(out)) }).toEqual({ code: 0, stalled: true, closed: true, gone: true, read: true, write: true });
  }, 60_000);
});
