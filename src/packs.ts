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
 *   the file is removed once stored or failed, and one a killed client left is swept at the next submission, once
 *   the git writing it has ended too (it holds the locks it was given).
 */
import { mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { tried, type Held } from './hostlock';
import type { Commit } from './protocol';
import type { Armada } from './sdk';

/** The packs being made and the locks their makers take: one place per user on the host, whatever a process's own
 *  cache settings say, so every submitter's locks meet; on disk, never a tmpfs (`onDisk`), which a pack would fill. */
export const PACKS = join(homedir(), '.cache', 'armada', 'packs');

/** statfs(2)'s f_type of a tmpfs, a filesystem in memory. */
const TMPFS = 0x01_02_19_94;

const GIB = 2 ** 30;

/** The packs a host makes at once: one per 16 GiB of its memory, at least one (3 on a 64 GB machine, about 3 GiB of
 *  git at most), so packing keeps to a small share of it whatever else runs. */
export const PACK_SLOTS = Math.max(1, Math.floor(totalmem() / (16 * GIB)));

/** How often a waiting submission asks again. */
const POLL_MS = 1000;

/** PACKS made, and refused where it is memory: a pack there is the exhaustion packing on disk prevents. */
function onDisk(): void {
  if (statfsSync(PACKS).type === TMPFS) throw new Error(`${PACKS} is on a tmpfs, in memory, where no pack is made: give this user a home on disk`);
}

/** The host's pack slot, waited for. */
async function slot(): Promise<Held> {
  for (;;) {
    for (let at = 0; at < PACK_SLOTS; at += 1) {
      const held = tried(join(PACKS, `slot-${String(at)}.lock`));

      if (held !== null) return held;
    }

    await Bun.sleep(POLL_MS);
  }
}

/** Each pack file in PACKS whose lock no process holds: what a client killed while packing or storing left. A git
 *  still writing one holds its lock (`slotted`'s descriptors), so none is taken from under it. */
export function sweep(): void {
  let names: string[];

  try {
    names = readdirSync(PACKS);
  } catch (cause) {
    // No packs directory yet: nothing was ever left.
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return;

    throw cause;
  }

  for (const name of names.filter((found) => found.endsWith('.pack'))) {
    const held = tried(join(PACKS, `${name.slice(0, -'.pack'.length)}.lock`));

    if (held === null) continue;

    try {
      rmSync(join(PACKS, name), { force: true });
    } finally {
      held.release();
    }
  }
}

/** `make` within one of the host's pack slots, given the descriptors of the locks it holds (the slot's, and `also`),
 *  which the git it starts inherits, so the slot and those locks stay held while that git lives, though this process
 *  ends first. */
export async function slotted<T>(make: (held: readonly number[]) => Promise<T>, also: readonly number[] = []): Promise<T> {
  mkdirSync(PACKS, { recursive: true });
  onDisk();
  const held = await slot();

  try {
    return await make([held.fd, ...also]);
  } finally {
    held.release();
  }
}

/** What storing one pack needs: whether the runner holds it, its making into a file (given the lock descriptors its
 *  git inherits), and its storing from that file (null where the runner held it by then). */
export interface Storing {
  readonly held: () => Promise<boolean>;
  readonly make: (file: string, held: readonly number[]) => Promise<void>;
  readonly store: (file: string) => Promise<number | null>;
}

/** The pack `key` names (a runner's path for it) stored once from this host: null where the runner holds it, else
 *  what `store` answered. Only the holder of its lock makes it, within a slot, into its own file under PACKS, which is
 *  removed however it ends; every other waits, asking the runner each `pollMs`; the holder asks once more on taking
 *  the lock, since one before it may have stored it between its ask and its lock. */
export async function packedOnce(key: string, { held, make, store }: Storing, pollMs = POLL_MS): Promise<number | null> {
  sweep();
  const name = new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32);
  const file = join(PACKS, `${name}.pack`);

  if (await held()) return null;

  for (;;) {
    const locked = tried(join(PACKS, `${name}.lock`));

    if (locked === null) {
      await Bun.sleep(pollMs);

      if (await held()) return null;
      continue;
    }

    try {
      if (await held()) return null;
      await slotted(async (descriptors) => { await make(file, descriptors); }, [locked.fd]);

      return await store(file);
    } finally {
      rmSync(file, { force: true });
      locked.release();
    }
  }
}

/** A commit's pack stored once from this host (`packedOnce`): `make` writes it to the file it is given, only where the
 *  runner lacks it; its size, or null where none was stored here. */
export async function uploadPack(armada: Armada, project: string, commit: Pick<Commit, 'sha' | 'base' | 'shallow'>, make: (file: string, held: readonly number[]) => Promise<void>): Promise<number | null> {
  const path = armada.packPath(project, commit);

  return await packedOnce(`${armada.connection.url} ${path}`, { held: async () => await armada.packHeld(path), make, store: async (file) => await armada.storePack(path, file) });
}
