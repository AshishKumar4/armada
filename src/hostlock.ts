/**
 * A lock one host's processes take on a file, flock(2)'s: the kernel lets it go when its holder closes the file or ends
 * however it ends, so none is ever left behind and no holder is named by anything a later process could reuse (a pid).
 */
import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/** flock(2)'s exclusive lock. */
const LOCK_EX = 2;

/** flock(2)'s operation that answers at once rather than waiting. */
const LOCK_NB = 4;

let flocked: ((fd: number, operation: number) => number) | undefined;

/** flock(2), from the C library. */
function flock(fd: number, operation: number): number {
  flocked ??= (() => {
    const library = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });

    return (descriptor: number, how: number) => library.symbols.flock(descriptor, how);
  })();

  return flocked(fd, operation);
}

/** A lock held: its open file, which a child process given it holds the lock through as long as it lives, and its
 *  release here. */
export interface Held {
  readonly fd: number;
  readonly release: () => void;
}

/** The lock on `path` where no other open file holds it now, or null. */
export function tried(path: string): Held | null {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);

  if (flock(fd, LOCK_EX | LOCK_NB) === 0) return { fd, release: () => { closeSync(fd); } };

  closeSync(fd);

  return null;
}

/** The lock on `path`, asked again each `pollMs` until it is taken or `patienceMs` have passed: its release, or null. */
export async function taken(path: string, patienceMs: number, pollMs: number): Promise<(() => void) | null> {
  const until = Date.now() + patienceMs;

  for (;;) {
    const held = tried(path);

    if (held !== null) return held.release;

    if (Date.now() >= until) return null;
    await Bun.sleep(pollMs);
  }
}
