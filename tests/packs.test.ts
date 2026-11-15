import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { tried } from '../src/hostlock';
import { PACK_SLOTS, PACKS, packedOnce } from '../src/packs';
import { git, scratchEnv } from './fakes';

const ROOT = resolve(import.meta.dir, '..');

/** A runner's pack store over HTTP, as the Worker's: HEAD 404 until a pack is stored, then 200; a pack in one PUT or
 *  in parts (POST ?uploads, PUT &part=N, POST &upload=U). Bodies are counted as they stream, never kept. */
function runner() {
  const stored = new Map<string, number>();
  const parts = new Map<string, number>();
  let packsPut = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const key = url.pathname;

      if (request.method === 'HEAD') return new Response(null, { status: stored.has(key) ? 200 : 404 });

      if (request.method === 'POST' && url.searchParams.has('uploads')) return Response.json({ upload: 'u1' });

      if (request.method === 'PUT') {
        let bytes = 0;

        if (request.body !== null) for await (const chunk of request.body) bytes += chunk.byteLength;

        if (url.searchParams.has('part')) {
          parts.set(key, (parts.get(key) ?? 0) + bytes);

          return Response.json({ partNumber: Number(url.searchParams.get('part')), etag: 'e' });
        }

        packsPut += 1;
        stored.set(key, bytes);

        return Response.json({ stored: key });
      }

      if (request.method === 'POST' && url.searchParams.has('upload')) {
        packsPut += 1;
        stored.set(key, parts.get(key) ?? 0);

        return Response.json({ stored: key });
      }

      return new Response('no such route', { status: 404 });
    },
  });

  return { url: `http://127.0.0.1:${String(server.port)}`, stored, packsPut: () => packsPut, stop: async () => { await server.stop(true); } };
}

/** A repository whose one commit packs to about `megabytes` MiB (incompressible), and its sha. */
function repository(at: string, megabytes: number): string {
  git(at, 'init', '-q');
  writeFileSync(join(at, 'blob.bin'), random(megabytes));
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', 'c');

  return git(at, 'rev-parse', 'HEAD');
}

/** `megabytes` MiB of random bytes, filled 64 KiB at a time (getRandomValues' limit). */
function random(megabytes: number): Uint8Array {
  const bytes = new Uint8Array(megabytes * 2 ** 20);

  for (let at = 0; at < bytes.length; at += 65_536) crypto.getRandomValues(bytes.subarray(at, at + 65_536));

  return bytes;
}

/** A submitter: its own process, the real client (`uploadPack`, `packTo`), against `url`; it prints what it
 *  stored, whether it packed, and its peak resident memory (VmHWM). */
const SUBMITTER = `
import { appendFileSync, readFileSync } from 'node:fs';
import { Armada } from '${ROOT}/src/sdk';
import { packTo } from '${ROOT}/src/git';
import { uploadPack } from '${ROOT}/src/packs';
const [url, repo, sha, made] = process.argv.slice(2);
const armada = new Armada({ url, token: 't', account: 'a' });
const stored = await uploadPack(armada, 'app', { sha, base: 'root' }, async (file, held) => {
  appendFileSync(made, sha + '\\n');
  await packTo(repo, { sha, base: 'root', history: 'commit' }, file, held);
});
const hwm = Number(/VmHWM:\\s+(\\d+)/u.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) * 1024;
console.log(JSON.stringify({ stored, hwm }));
`;

/** What a submitter printed: what it stored, and its peak resident memory. */
const EndSchema = v.object({ stored: v.nullable(v.number()), hwm: v.number() });

/** A submission: the runner's address, the commit's repository and sha, the file each packing appends its sha to,
 *  the submitter script, and the home whose ~/.cache/armada/packs (packs and their locks) the submitters share. */
interface Submission {
  readonly url: string;
  readonly repo: string;
  readonly sha: string;
  readonly made: string;
  readonly script: string;
  readonly home: string;
}

/** A submitter's own process, started with this test's environment but git's and armada's own variables. */
function submit({ url, repo, sha, made, script, home }: Submission) {
  return Bun.spawn(['bun', script, url, repo, sha, made], { env: { ...scratchEnv(), HOME: home }, stdout: 'pipe', stderr: 'pipe' });
}

/** Each submitter's end, as it printed it; a submitter that failed throws what it said. */
async function ended(running: ReturnType<typeof submit>) {
  const [code, out, err] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);

  if (code !== 0) throw new Error(err);

  return v.parse(EndSchema, JSON.parse(out));
}

/** This process's descendants as /proc lists them now: each one's resident bytes and command line. */
function descendants(): { rss: number; command: string }[] {
  const children = new Map<number, number[]>();

  for (const entry of new Bun.Glob('[0-9]*').scanSync({ cwd: '/proc', onlyFiles: false })) {
    const stat = readable(`/proc/${entry}/stat`);
    const parent = Number(stat?.split(') ').at(-1)?.split(' ')[1]);

    if (stat !== null) children.set(parent, [...children.get(parent) ?? [], Number(entry)]);
  }

  const found: { rss: number; command: string }[] = [];
  const stack = [...children.get(process.pid) ?? []];

  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    stack.push(...children.get(pid) ?? []);
    const status = readable(`/proc/${String(pid)}/status`);
    const command = readable(`/proc/${String(pid)}/cmdline`);

    if (status !== null && command !== null) found.push({ rss: Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1] ?? 0) * 1024, command: command.replaceAll('\0', ' ') });
  }

  return found;
}

/** A /proc file's text, or null where its process ended while it was read. */
function readable(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ESRCH')) return null;

    throw cause;
  }
}

/** While `running` settles, the peak of every descendant's resident bytes summed and the most `git pack-objects`
 *  alive at once, sampled each 50 ms. */
async function sampled<T>(running: Promise<T>): Promise<{ value: T; peak: number; packers: number }> {
  let done = false;
  let peak = 0;
  let packers = 0;

  const watching = (async () => {
    while (!done) {
      const now = descendants();

      peak = Math.max(peak, now.reduce((sum, each) => sum + each.rss, 0));
      packers = Math.max(packers, now.filter((each) => each.command.includes('pack-objects')).length);
      // Sampling a process tree is reading the platform's clock; no fake timer reaches another process.
      await Bun.sleep(50);
    }
  })();

  try {
    return { value: await running, peak, packers };
  } finally {
    done = true;
    await watching;
  }
}

const MIB = 2 ** 20;

describe('a host packs one commit once, within its slots, never holding a pack whole', () => {
  // 2026-11-15: 42 submissions of one commit from one machine each packed it at once (about 1 GB of git apiece) and
  // the machine ran out of memory.
  test('42 processes submitting one commit the runner lacks make one pack between them, the whole tree within its bound', async () => {
    const scratch = mkdtempSync(join(homedir(), 'armada-packs-'));
    const served = runner();

    try {
      const repo = join(scratch, 'repo');
      const made = join(scratch, 'made');
      const script = join(scratch, 'submit.ts');

      mkdirSync(repo);
      const sha = repository(repo, 96);

      writeFileSync(made, '');
      writeFileSync(script, SUBMITTER);

      const submission = { url: served.url, repo, sha, made, script, home: join(scratch, 'home') };
      const { value: ends, peak } = await sampled(Promise.all(Array.from({ length: 42 }, async () => await ended(submit(submission)))));
      const pack = [...served.stored.values()][0] ?? 0;

      // One pack, by one process, stored once; every other process found it stored.
      expect(readFileSync(made, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
      expect(served.packsPut()).toBe(1);
      expect(ends.filter((end) => end.stored !== null).map((end) => end.stored)).toEqual([pack]);
      // The pack is larger than a part (so it went in parts), yet no process held it whole, and the whole tree (42
      // clients and the one git) stayed within 42 clients of 160 MiB and one bounded git (1 GiB): far below 42
      // packs of a GiB.
      expect(pack).toBeGreaterThan(64 * MIB);
      expect(Math.max(...ends.map((end) => end.hwm))).toBeLessThan(256 * MIB);
      expect(peak).toBeLessThan(42 * 160 * MIB + 1024 * MIB);
      // Nothing is left on disk.
      expect([...new Bun.Glob('*.pack').scanSync(join(scratch, 'home', '.cache', 'armada', 'packs'))]).toEqual([]);
    } finally {
      await served.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);

  test('distinct commits submitted at once pack within the host\'s slots, each once', async () => {
    const scratch = mkdtempSync(join(homedir(), 'armada-slots-'));
    const served = runner();

    try {
      const made = join(scratch, 'made');
      const script = join(scratch, 'submit.ts');

      const commits = Array.from({ length: PACK_SLOTS + 2 }, (_, at) => {
        const repo = join(scratch, `repo-${String(at)}`);

        mkdirSync(repo);

        return { repo, sha: repository(repo, 48) };
      });

      writeFileSync(made, '');
      writeFileSync(script, SUBMITTER);

      const home = join(scratch, 'home');

      const { packers } = await sampled(Promise.all(commits.map(async ({ repo, sha }) => await ended(submit({ url: served.url, repo, sha, made, script, home })))));

      expect(packers).toBeLessThanOrEqual(PACK_SLOTS);
      expect(served.packsPut()).toBe(commits.length);
      expect(readFileSync(made, 'utf8').split('\n').filter(Boolean).toSorted()).toEqual(commits.map(({ sha }) => sha).toSorted());
    } finally {
      await served.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);

  test('a holder that takes the lock just after another stored the pack asks the runner again and makes none', async () => {
    const key = `test ${String(Date.now())} ${String(Math.random())}`;
    const name = new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32);
    const other = tried(join(PACKS, `${name}.lock`));
    let asked = 0;
    let made = 0;

    // The other holder stores the pack and lets the lock go between this one's first ask and its lock.
    const stored = await packedOnce(key, {
      held: async () => {
        asked += 1;

        if (asked === 1) other?.release();

        return await Promise.resolve(asked > 1);
      },
      make: async () => {
        made += 1;
        await Promise.resolve();
      },
      store: async () => await Promise.resolve(1),
    }, 10);

    expect([stored, made, asked]).toEqual([null, 0, 2]);
  });
});
