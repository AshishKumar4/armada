/**
 * The CLI's local run records, and the bound on them. `armada run` writes each run's report to
 * `~/.local/state/armada/runs/<project>-<job>.json` and extracts its tasks' artifacts beside it, under `<project>-<job>/`.
 *
 * A record is a report with its artifacts directory, when it has one, taken as one unit and aged by the newer of the
 * two's mtimes. A run of several environments extracts each job's artifacts under that job's own name, and only the first
 * job names the report: each other directory is a record of its own, kept whenever the report that lists it is.
 *
 * Pruning removes the oldest records first, while one is older than the age bound or the records together take more
 * than the size bound, except a record that is
 *   - the newest green report of its project, which other tools read to balance their work;
 *   - named in the holds file (`~/.local/state/armada/holds`, one record name per line), which other tools append to so
 *     a receipt can keep the run it cites;
 *   - under an hour old: the CLI keeps no marker of a run in progress, and a run's artifacts are extracted just before
 *     its report is written.
 *
 * One lock file serialises prunes and `armada` edits of the holds file; a record that vanishes mid-scan, to another
 * prune or a person, is skipped. A tool that appends to the holds file takes no lock, so a prune reads the file again
 * before each removal.
 */
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as v from 'valibot';
import { JOB_ID } from './protocol';

const STATE = join(homedir(), '.local', 'state', 'armada');

/** Where `armada run` writes its reports and the artifacts of their tasks. */
export const RUNS = join(STATE, 'runs');

/** The records no prune removes beyond those it names itself: one name per line. */
const HOLDS = join(STATE, 'holds');

/** Held while one armada prunes or edits the holds file: it holds the pid of the process that made it. */
const LOCK = join(STATE, 'retention.lock');

const REPORT_SUFFIX = '.json';

/** A record younger than this is not removed. */
const MIN_AGE_MS = 60 * 60_000;

/** A lock older than this is taken as left by a process that died, whatever its pid says. */
const LOCK_STALE_MS = 60 * 60_000;

const LOCK_POLL_MS = 100;

/** How long a command waits for another armada's prune or hold edit to end. */
const LOCK_WAIT_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** A gigabyte is 10^9 bytes. */
const GB = 1e9;

/** The size on disk of one block, which `lstat` counts a file in: what a full disk is spent in, not the file's length. */
const BLOCK = 512;

/** The most of a report's start that is read to find its `graded`, which is its fourth key. */
const HEAD_BYTES = 1024;

const Bound = v.pipe(v.number(), v.minValue(0));

/** The `retention` of a connection file: each bound it sets, as `--days` and `--gb` set them for one command. */
export const RetentionSchema = v.strictObject({ days: v.optional(Bound), gb: v.optional(Bound) });

export type Retention = v.InferOutput<typeof RetentionSchema>;

/** The bounds a prune applies: records older than `days`, and records beyond `gb` (10^9 bytes) in all, are removed. */
export interface Bounds {
  readonly days: number;
  readonly gb: number;
}

export const DEFAULT_BOUNDS: Bounds = { days: 14, gb: 20 };

/** The bounds of one command: its flags, else the connection file's, else the defaults. */
export function boundsOf(configured: Retention, given: Retention): Bounds {
  return { days: given.days ?? configured.days ?? DEFAULT_BOUNDS.days, gb: given.gb ?? configured.gb ?? DEFAULT_BOUNDS.gb };
}

/** What a report file holds that a prune reads. A report from before `graded` has none, and is read by its rows. */
const ReportSchema = v.looseObject({
  graded: v.optional(v.string()),
  problems: v.optional(v.array(v.string()), []),
  artifacts: v.optional(v.record(v.string(), v.string()), {}),
  verdicts: v.optional(v.object({ rows: v.array(v.looseObject({ exitCode: v.number() })) }), { rows: [] }),
});

const ErrnoSchema = v.looseObject({ code: v.string() });

/** The errno code of a failed system call; undefined for any other failure. */
function codeOf({ cause }: { readonly cause: unknown }): string | undefined {
  const failure = v.safeParse(ErrnoSchema, cause);

  return failure.success ? failure.output.code : undefined;
}

/** What `read` returns, or undefined when what it reads is gone: ENOENT, and no other failure. */
function present<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (cause) {
    if (codeOf({ cause }) === 'ENOENT') return undefined;

    throw cause;
  }
}

/** A record as a hold or a command spells it: the report's file name with or without `.json`, or a path to either. */
export function recordName(text: string): string {
  const name = basename(text.trim());

  return name.endsWith(REPORT_SUFFIX) ? name.slice(0, -REPORT_SUFFIX.length) : name;
}

const reportPath = (name: string): string => join(RUNS, `${name}${REPORT_SUFFIX}`);

/** The project a record's name says: the name is `<project>-<job>`, a job's id, or `local-<ms>` for a run no job made. */
function projectOf(name: string): string | undefined {
  const parts = name.split('-');
  const run = parts.slice(-2).join('-');

  return parts.length > 2 && (JOB_ID.test(run) || /^local-\d+$/u.test(run)) ? parts.slice(0, -2).join('-') : undefined;
}

/** What a path takes on disk, a directory with all it holds, and when it itself last changed, which a prune ages it by:
 *  the mtime of what is inside is the task's, which a task can set to any time. Undefined once it is gone. */
interface Usage {
  readonly bytes: number;
  readonly mtimeMs: number;
}

function usage(path: string): Usage | undefined {
  const own = present(() => lstatSync(path));

  if (own === undefined) return undefined;

  return { bytes: own.blocks * BLOCK + (own.isDirectory() ? within(path) : 0), mtimeMs: own.mtimeMs };
}

/** What a directory's entries take on disk. Symlinks count as themselves, and are never followed. */
function within(directory: string): number {
  return (present(() => readdirSync(directory)) ?? []).reduce((sum, entry) => sum + (usage(join(directory, entry))?.bytes ?? 0), 0);
}

interface RunRecord {
  readonly name: string;
  readonly hasReport: boolean;
  readonly hasArtifacts: boolean;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** Every record under RUNS. Files that are not reports, and anything that is not a plain file or directory, are not
 *  records, and are left alone. */
function scan(): RunRecord[] {
  const entries = present(() => readdirSync(RUNS, { withFileTypes: true })) ?? [];
  const reports = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith(REPORT_SUFFIX)).map((entry) => recordName(entry.name)));
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));

  return [...new Set([...reports, ...directories])].flatMap((name) => {
    const report = reports.has(name) ? usage(reportPath(name)) : undefined;
    const artifacts = directories.has(name) ? usage(join(RUNS, name)) : undefined;

    if (report === undefined && artifacts === undefined) return [];

    return [{
      name, hasReport: report !== undefined, hasArtifacts: artifacts !== undefined,
      bytes: (report?.bytes ?? 0) + (artifacts?.bytes ?? 0), mtimeMs: Math.max(report?.mtimeMs ?? 0, artifacts?.mtimeMs ?? 0),
    }];
  });
}

/** The start of a file. */
function headOf(path: string): string {
  const fd = openSync(path, 'r');

  try {
    const head = Buffer.alloc(HEAD_BYTES);

    return head.toString('utf8', 0, readSync(fd, head, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/** A report file as a prune reads it; undefined when it is gone, or is no report: a half-written or foreign file. */
function viewOf(path: string): v.InferOutput<typeof ReportSchema> | undefined {
  const text = present(() => readFileSync(path, 'utf8'));

  if (text === undefined) return undefined;

  try {
    const view = v.safeParse(ReportSchema, JSON.parse(text));

    return view.success ? view.output : undefined;
  } catch (cause) {
    if (cause instanceof SyntaxError) return undefined;

    throw cause;
  }
}

/** The key `writeReport` (ci.ts) writes fourth, at the top level's indent, so a report's verdict is read without parsing
 *  the megabytes of rows it may hold. */
const GRADED = /^ {2}"graded": "([^"]*)"/mu;

/** Whether the run the report at `path` holds graded green: every row passed, and nothing ungraded. */
function isGreen(path: string): boolean {
  const graded = GRADED.exec(present(() => headOf(path)) ?? '')?.[1];

  if (graded !== undefined) return graded === 'pass';
  const view = viewOf(path);

  if (view === undefined) return false;

  // A report from before `graded`: green when it had no problem and every row it graded passed.
  if (view.graded === undefined) return view.problems.length === 0 && view.verdicts.rows.length > 0 && view.verdicts.rows.every((row) => row.exitCode === 0);

  return view.graded === 'pass';
}

/** The names of the artifact directories a report lists: each task's is `<project>-<job>/<index>-<name>`. */
function listedBy(name: string): string[] {
  return Object.values(viewOf(reportPath(name))?.artifacts ?? {}).map((directory) => basename(dirname(directory)));
}

/** The names the holds file lists, each as a record's name. */
function held(): Set<string> {
  return new Set((present(() => readFileSync(HOLDS, 'utf8')) ?? '').split('\n').map(recordName).filter((name) => name !== ''));
}

/** Each record a prune keeps, and why. */
function kept(records: readonly RunRecord[]): Map<string, string> {
  const why = new Map<string, string>();
  const named = new Set(records.map((record) => record.name));
  const reports = records.filter((record) => record.hasReport).toSorted((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));

  for (const [project, ofProject] of Map.groupBy(reports, (record) => projectOf(record.name))) {
    if (project === undefined) continue;
    const green = ofProject.find((record) => isGreen(reportPath(record.name)));

    if (green !== undefined) why.set(green.name, `the newest green run of ${project}`);
  }

  for (const name of held()) {
    if (named.has(name) && !why.has(name)) why.set(name, 'held');
  }

  // A kept run keeps every directory its report lists, as a run of several environments has one for each job; a directory
  // added here has no report to list more.
  for (const name of why.keys()) {
    for (const directory of listedBy(name)) {
      if (named.has(directory) && !why.has(directory)) why.set(directory, `its artifacts are ${name}'s`);
    }
  }

  return why;
}

/** One record a prune removed, or in a dry run would. */
interface Removed {
  readonly name: string;
  readonly bytes: number;
  readonly ageMs: number;
}

/** What a prune did: the records it removed, and what it left. */
export interface Pruned {
  readonly removed: readonly Removed[];
  readonly scanned: number;
  readonly left: number;
  readonly leftBytes: number;
  /** The records it kept for being the newest green run of their project, held, or a held run's. */
  readonly kept: number;
  /** Whether what is left is still past a bound, as every record that could go is gone: the rest are kept or new. */
  readonly past: boolean;
}

/** A prune of the records, which removes none with `dry`. The caller holds the lock. */
function pruneUnder(bounds: Bounds, dry: boolean): Pruned {
  const now = Date.now();
  const records = scan();
  const why = kept(records);
  const oldestFirst = records.filter((record) => !why.has(record.name) && now - record.mtimeMs >= MIN_AGE_MS).toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  const removed: Removed[] = [];
  const gone = new Set<string>();
  let bytes = records.reduce((sum, record) => sum + record.bytes, 0);

  for (const record of oldestFirst) {
    const tooOld = now - record.mtimeMs > bounds.days * DAY_MS;

    if (!tooOld && bytes <= bounds.gb * GB) break;

    // A hold another tool has appended since the scan.
    if (held().has(record.name)) continue;

    if (!dry) {
      if (record.hasReport) rmSync(reportPath(record.name), { force: true });

      if (record.hasArtifacts) rmSync(join(RUNS, record.name), { recursive: true, force: true });
    }

    removed.push({ name: record.name, bytes: record.bytes, ageMs: now - record.mtimeMs });
    gone.add(record.name);
    bytes -= record.bytes;
  }

  const left = records.filter((record) => !gone.has(record.name));

  return {
    removed, scanned: records.length, left: left.length, leftBytes: bytes, kept: why.size,
    past: bytes > bounds.gb * GB || left.some((record) => now - record.mtimeMs > bounds.days * DAY_MS),
  };
}

/** Whether nothing alive holds the lock: no file, a file of a dead process, or one too old to be a prune's. */
function unheld(): boolean {
  const own = present(() => lstatSync(LOCK));

  if (own === undefined || Date.now() - own.mtimeMs > LOCK_STALE_MS) return true;
  const pid = Number.parseInt(present(() => readFileSync(LOCK, 'utf8')) ?? '', 10);

  // A lock whose pid is not yet written is one being made.
  return Number.isInteger(pid) && !running(pid);
}

function running(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (cause) {
    const code = codeOf({ cause });

    if (code === 'ESRCH') return false;

    if (code === 'EPERM') return true;

    throw cause;
  }
}

/** Takes the lock, waiting up to `patienceMs` for its holder; the release, or null when it is held still. A lock whose
 *  holder has died is broken. Two processes that find the same dead lock at once may both break it and both go on: a
 *  prune twice over is harmless, and an edit of the holds file is a whole line. */
async function lock(patienceMs: number): Promise<(() => void) | null> {
  mkdirSync(STATE, { recursive: true });
  const until = Date.now() + patienceMs;
  const mine = `${String(process.pid)}\n`;

  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx', 0o600);

      writeSync(fd, mine);
      closeSync(fd);

      return () => {
        if (present(() => readFileSync(LOCK, 'utf8')) === mine) rmSync(LOCK, { force: true });
      };
    } catch (cause) {
      if (codeOf({ cause }) !== 'EEXIST') throw cause;
    }

    if (unheld()) {
      rmSync(LOCK, { force: true });
      continue;
    }

    if (Date.now() >= until) return null;
    await Bun.sleep(LOCK_POLL_MS);
  }
}

/** `body`, holding the lock; a command waits up to LOCK_WAIT_MS for it. */
async function locked<T>(body: () => T): Promise<T> {
  const release = await lock(LOCK_WAIT_MS);

  if (release === null) throw new Error(`another armada is pruning run records or editing ${HOLDS}: it holds ${LOCK}, which is safe to delete if no armada runs`);

  try {
    return body();
  } finally {
    release();
  }
}

/** Prunes the records to `bounds`, or with `dry` says what it would. */
export async function pruneRuns(bounds: Bounds, dry: boolean): Promise<Pruned> {
  return dry ? pruneUnder(bounds, true) : await locked(() => pruneUnder(bounds, false));
}

/** Prunes after a run wrote its report: null when another armada is pruning, which then applies the bounds itself. */
export async function retainRuns(bounds: Bounds): Promise<Pruned | null> {
  const release = await lock(0);

  if (release === null) return null;

  try {
    return pruneUnder(bounds, false);
  } finally {
    release();
  }
}

function sized(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;

  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;

  return `${(bytes / 1e3).toFixed(0)} KB`;
}

/** A line for each record a prune removed, or in a dry run would. */
export function describeRemoved(pruned: Pruned, dry: boolean): string[] {
  return pruned.removed.map((record) => `${dry ? 'would remove' : 'removed'} ${record.name}  ${sized(record.bytes)}  ${(record.ageMs / DAY_MS).toFixed(1)} days old`);
}

/** One line for the whole of a prune. */
export function describeSummary(pruned: Pruned, dry: boolean): string {
  const freed = pruned.removed.reduce((sum, record) => sum + record.bytes, 0);
  const past = pruned.past ? '; still past a bound: what is left is kept or under an hour old' : '';

  return `${dry ? 'would remove' : 'removed'} ${String(pruned.removed.length)} of ${String(pruned.scanned)} run records, ${sized(freed)}; ${String(pruned.left)} left, ${sized(pruned.leftBytes)}, ${String(pruned.kept)} of them kept as held or newest green${past}`;
}

/** A record's name as `hold` and `release` take it: nothing that could split a line of the holds file. */
function holdName(text: string): string {
  const name = recordName(text);

  if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error(`a run record's name is its report's file name, such as dew-20261108065807-be40ef9e, not ${text}`);

  return name;
}

/** Keeps a record from every prune. Whether the file gained a line, and whether a record of that name is on disk. */
export async function holdRun(text: string): Promise<{ readonly added: boolean; readonly exists: boolean }> {
  const name = holdName(text);

  return await locked(() => {
    const exists = present(() => lstatSync(reportPath(name))) !== undefined || present(() => lstatSync(join(RUNS, name))) !== undefined;

    if (held().has(name)) return { added: false, exists };
    mkdirSync(STATE, { recursive: true });
    const current = present(() => readFileSync(HOLDS, 'utf8')) ?? '';

    // One append, so a tool appending beside it loses nothing; after a line another tool left without its newline.
    appendFileSync(HOLDS, `${current === '' || current.endsWith('\n') ? '' : '\n'}${name}\n`);

    return { added: true, exists };
  });
}

/** Lets a record go to the prunes again; whether it was held. The file is replaced whole, so it never holds half a line,
 *  and a line another tool appends in that instant, to the file this replaces, is lost: a hold is a line to add again. */
export async function releaseRun(text: string): Promise<boolean> {
  const name = holdName(text);

  return await locked(() => {
    const lines = (present(() => readFileSync(HOLDS, 'utf8')) ?? '').split('\n').filter((line) => line !== '');
    const left = lines.filter((line) => recordName(line) !== name);

    if (left.length === lines.length) return false;
    const next = `${HOLDS}.${String(process.pid)}.tmp`;

    writeFileSync(next, left.map((line) => `${line}\n`).join(''));
    renameSync(next, HOLDS);

    return true;
  });
}
