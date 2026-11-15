/**
 * Where and how a host makes a commit's pack before it is stored (`uploadPack`), so that however many of its
 * processes submit, and whatever they submit, packing cannot exhaust it and one commit is packed once (2026-11-15: 42
 * submissions of one commit from one machine each packed it at once, about 1 GB of git apiece, and the machine ran out
 * of memory).
 *
 * - One pack per commit: a submission packs only holding its pack's lock (`hostlock`), asking the runner again first;
 *   the others wait, asking the runner each second, and take nothing once it holds the pack. A holder that fails, or
 *   ends, lets the lock go, and a waiter then packs.
 * - At most PACK_SLOTS packs at once on the host, whichever commits, each git bounded in memory (git.ts' GIT_BOUNDS).
 * - A pack is written to a file on disk, PACKS, and read from it in parts as it is stored, never held whole in memory;
 *   the file is removed once stored or failed, and one a killed client left is swept at the next submission.
 */
import { readdirSync, rmSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { tried } from './hostlock';
import type { Armada } from './sdk';
import type { Commit } from './protocol';

/** The packs being made: under the user's cache ($XDG_CACHE_HOME, else ~/.cache), on disk, never a /tmp that may be
 *  memory (a tmpfs), which a pack would fill. */
export const PACKS = join(process.env.XDG_CACHE_HOME === undefined || process.env.XDG_CACHE_HOME === '' ? join(homedir(), '.cache') : process.env.XDG_CACHE_HOME, 'armada', 'packs');

const GIB = 2 ** 30;

/** The packs a host makes at once: one per 16 GiB of its memory, at least one (3 on a 64 GB machine, about 3 GiB of
 *  git at most), so packing keeps to a small share of it whatever else runs. */
export const PACK_SLOTS = Math.max(1, Math.floor(totalmem() / (16 * GIB)));

/** How often a waiting submission asks again. */
const POLL_MS = 1000;

/** The host's pack slot, waited for: its release. */
async function slot(): Promise<() => void> {
  for (;;) {
    for (let at = 0; at < PACK_SLOTS; at += 1) {
      const release = tried(join(PACKS, `slot-${String(at)}.lock`));

      if (release !== null) return release;
    }

    await Bun.sleep(POLL_MS);
  }
}

/** Each pack file in PACKS whose lock no process holds: what a client killed while packing or storing left. */
export function sweep(): void {
  let names: string[];

  try {
    names = readdirSync(PACKS);
  } catch {
    return;
  }

  for (const name of names.filter((found) => found.endsWith('.pack'))) {
    const release = tried(join(PACKS, `${name.slice(0, -'.pack'.length)}.lock`));

    if (release === null) continue;

    try {
      rmSync(join(PACKS, name), { force: true });
    } finally {
      release();
    }
  }
}

/** A git pack made within a host slot: `make` writes it to the file it is given, under PACKS. */
export async function slotted<T>(make: () => Promise<T>): Promise<T> {
  const release = await slot();

  try {
    return await make();
  } finally {
    release();
  }
}

/** What storing one pack needs: whether the runner holds it, its making into a file, and its storing from that file
 *  (null where the runner held it by then). */
export interface Storing {
  readonly held: () => Promise<boolean>;
  readonly make: (file: string) => Promise<void>;
  readonly store: (file: string) => Promise<number | null>;
}

/** The pack `key` names (a runner's path for it) stored once from this host: null where the runner holds it, else
 *  what `store` answered. Only the holder of its lock makes it, within a slot, into its own file under PACKS, which is
 *  removed however it ends; every other waits, asking the runner each `pollMs`, and asks once more on taking the lock,
 *  since the holder it waited on may just have stored it. */
export async function packedOnce(key: string, { held, make, store }: Storing, pollMs = POLL_MS): Promise<number | null> {
  sweep();
  const name = new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32);
  const file = join(PACKS, `${name}.pack`);

  if (await held()) return null;

  for (let waited = false; ; waited = true) {
    const release = tried(join(PACKS, `${name}.lock`));

    if (release === null) {
      await Bun.sleep(pollMs);

      if (await held()) return null;
      continue;
    }

    try {
      if (waited && await held()) return null;
      await slotted(async () => { await make(file); });

      return await store(file);
    } finally {
      rmSync(file, { force: true });
      release();
    }
  }
}

/** A commit's pack stored once from this host (`packedOnce`): `make` writes it to the file it is given, only where the
 *  runner lacks it; its size, or null where none was stored here. */
export async function uploadPack(armada: Armada, project: string, commit: Pick<Commit, 'sha' | 'base' | 'shallow'>, make: (file: string) => Promise<void>): Promise<number | null> {
  const path = armada.packPath(project, commit);

  return await packedOnce(`${armada.connection.url} ${path}`, { held: async () => await armada.packHeld(path), make, store: async (file) => await armada.storePack(path, file) });
}
