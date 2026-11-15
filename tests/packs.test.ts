import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { tried } from '../src/hostlock';
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
const stored = await uploadPack(armada, 'app', { sha, base: 'root' }, async (file) => {
  appendFileSync(made, sha + '\\n');
  await packTo(repo, sha, 'root', 'full', file);
});
const hwm = Number(/VmHWM:\\s+(\\d+)/u.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) * 1024;
console.log(JSON.stringify({ stored, hwm }));
`;

/** What a submitter printed: what it stored, and its peak resident memory. */
const EndSchema = v.object({ stored: v.nullable(v.number()), hwm: v.number() });

/** A submission: the runner's address, the commit's repository and sha, the file each packing appends its sha to,
 *  the submitter script, and the cache whose packs and slots the host's submitters share. */
interface Submission {
  readonly url: string;
  readonly repo: string;
  readonly sha: string;
  readonly made: string;
  readonly script: string;
  readonly cache: string;
}

/** A submitter's own process, started with this test's environment but git's and armada's own variables. */
function submit({ url, repo, sha, made, script, cache }: Submission) {
  return Bun.spawn(['bun', script, url, repo, sha, made], { env: { ...scratchEnv(), XDG_CACHE_HOME: cache }, stdout: 'pipe', stderr: 'pipe' });
}

describe('a host packs one commit once, within its slots, never holding a pack whole', () => {
  // 2026-11-15: 42 submissions of one commit from one machine each packed it at once (about 1 GB of git apiece) and
  // the machine ran out of memory.
  test('42 processes submitting one commit the runner lacks make one pack between them, each within its bound', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-packs-'));
    const served = runner();

    try {
      const repo = join(scratch, 'repo');
      const made = join(scratch, 'made');
      const script = join(scratch, 'submit.ts');

      Bun.spawnSync(['mkdir', '-p', repo]);
      const sha = repository(repo, 96);

      writeFileSync(made, '');
      writeFileSync(script, SUBMITTER);

      const submission = { url: served.url, repo, sha, made, script, cache: join(scratch, 'cache') };
      const submitters = Array.from({ length: 42 }, () => submit(submission));
      const ends = await Promise.all(submitters.map(async (running) => {
        const [code, out, err] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);

        if (code !== 0) throw new Error(err);

        return v.parse(EndSchema, JSON.parse(out));
      }));

      const pack = [...served.stored.values()][0] ?? 0;

      // One pack, by one process, stored once; every other process found it stored.
      expect(readFileSync(made, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
      expect(served.packsPut()).toBe(1);
      expect(ends.filter((end) => end.stored !== null).map((end) => end.stored)).toEqual([pack]);
      // The pack is larger than a part (so it went in parts), yet no process held it whole: each peaked below its
      // runtime and one part's bytes (64 MiB) with room, far below a pack's three copies.
      expect(pack).toBeGreaterThan(64 * 2 ** 20);
      expect(Math.max(...ends.map((end) => end.hwm))).toBeLessThan(256 * 2 ** 20);
      // Nothing is left on disk.
      expect([...new Bun.Glob('*.pack').scanSync(join(scratch, 'cache', 'armada', 'packs'))]).toEqual([]);
    } finally {
      await served.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);

  test('a second commit waits for a free slot: with every slot held, nothing is packed until one is let go', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-slots-'));
    const served = runner();
    const cache = join(scratch, 'cache');
    const held: (() => void)[] = [];

    try {
      const repo = join(scratch, 'repo');
      const made = join(scratch, 'made');
      const script = join(scratch, 'submit.ts');

      Bun.spawnSync(['mkdir', '-p', repo]);
      const sha = repository(repo, 1);

      writeFileSync(made, '');
      writeFileSync(script, SUBMITTER);

      // Every slot this host has, held here, as other packs in progress would hold them.
      for (let at = 0; ; at += 1) {
        const release = tried(join(cache, 'armada', 'packs', `slot-${String(at)}.lock`));

        if (release === null || at >= 64) {
          release?.();
          break;
        }

        held.push(release);
      }

      const waiting = submit({ url: served.url, repo, sha, made, script, cache });
      const packs = join(cache, 'armada', 'packs');
      const holding = () => [...new Bun.Glob('*.lock').scanSync(packs)].some((name) => !name.startsWith('slot-'));

      // The submitter holds its commit's lock, so it waits on a slot alone.
      while (!holding()) await Bun.sleep(50);
      // Across processes, what is shown is that it does not go on: one turn of its slot wait (a second) passes on the
      // platform's clock, which no fake timer reaches in another process.
      await Bun.sleep(1500);
      expect([readFileSync(made, 'utf8'), served.packsPut()]).toEqual(['', 0]);
      held.pop()?.();
      expect(await waiting.exited).toBe(0);
      expect(served.packsPut()).toBe(1);
    } finally {
      for (const release of held) release();
      await served.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
