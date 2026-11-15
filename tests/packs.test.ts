import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tried } from '../src/hostlock';

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

        for await (const chunk of request.body ?? []) bytes += (chunk as Uint8Array).byteLength;

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

  return { url: `http://127.0.0.1:${String(server.port)}`, stored, packsPut: () => packsPut, stop: () => { void server.stop(true); } };
}

/** A repository whose one commit packs to about `megabytes` MiB (incompressible), and its sha. */
function repository(at: string, megabytes: number): string {
  const run = (...args: string[]) => {
    const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: at, stdout: 'pipe', stderr: 'pipe' });

    if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());

    return ran.stdout.toString().trim();
  };

  run('init', '-q');
  writeFileSync(join(at, 'blob.bin'), random(megabytes));
  run('add', '-A');
  run('commit', '-q', '-m', 'c');

  return run('rev-parse', 'HEAD');
}

/** `megabytes` MiB of random bytes, filled 64 KiB at a time (getRandomValues' limit). */
function random(megabytes: number): Uint8Array {
  const bytes = new Uint8Array(megabytes * 2 ** 20);

  for (let at = 0; at < bytes.length; at += 65_536) crypto.getRandomValues(bytes.subarray(at, at + 65_536));

  return bytes;
}

/** A submitter: its own process, the real client (`Armada.uploadPack`, `packTo`), against `url`; it prints what it
 *  stored, whether it packed, and its peak resident memory (VmHWM). */
const SUBMITTER = `
import { appendFileSync, readFileSync } from 'node:fs';
import { Armada } from '${ROOT}/src/sdk';
import { packTo } from '${ROOT}/src/git';
const [url, repo, sha, made] = process.argv.slice(2);
const armada = new Armada({ url, token: 't', account: 'a' });
const stored = await armada.uploadPack('app', { sha, base: 'root' }, async (file) => {
  appendFileSync(made, sha + '\\n');
  await packTo(repo, sha, 'root', 'full', file);
});
const hwm = Number(/VmHWM:\\s+(\\d+)/u.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) * 1024;
console.log(JSON.stringify({ stored, hwm }));
`;

/** Each submitter's process started against `url` with its own environment (its cache under `cache`). */
function submit(url: string, repo: string, sha: string, made: string, script: string, cache: string) {
  return Bun.spawn(['bun', script, url, repo, sha, made], { env: { ...process.env, XDG_CACHE_HOME: cache }, stdout: 'pipe', stderr: 'pipe' });
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
      const submitters = Array.from({ length: 42 }, () => submit(served.url, repo, sha, made, script, join(scratch, 'cache')));
      const ends = await Promise.all(submitters.map(async (running) => {
        const [code, out, err] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);

        if (code !== 0) throw new Error(err);

        return JSON.parse(out) as { stored: number | null; hwm: number };
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
      expect(new Bun.Glob('*.pack').scanSync(join(scratch, 'cache', 'armada', 'packs')).toArray()).toEqual([]);
    } finally {
      served.stop();
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

      const waiting = submit(served.url, repo, sha, made, script, cache);
      const packs = join(cache, 'armada', 'packs');
      const holding = () => new Bun.Glob('*.lock').scanSync(packs).toArray().some((name) => !name.startsWith('slot-'));

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
      served.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
