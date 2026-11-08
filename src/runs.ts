/**
 * The CLI's local run records, and the bound on them. `armada run` writes each run's report to
 * `~/.local/state/armada/runs/<project>-<job>.json` and extracts its tasks' artifacts beside it, under `<project>-<job>/`.
 *
 * A record is a run's report with every artifacts directory the run made, taken as one unit, aged by the newest of
 * their mtimes and removed whole, so no report left names evidence that is gone: its own directory, and in a run of
 * several environments each other job's (`<project>-<job>`, which its report's `jobs` names). A directory no report
 * owns is a record of its own.
 *
 * Pruning removes the oldest records first, while one is older than the age bound or the records together take more
 * than the size bound, except a record that is
 *   - the newest green report of its project, which other tools read to balance their work;
 *   - named in the holds file (`~/.local/state/armada/holds`, one record name per line), which a receipt keeps the run
 *     it cites by, through `armada runs hold`, its one writer;
 *   - one a run is extracting artifacts into now: the run names its directories in a marker under
 *     `~/.local/state/armada/active` from before its first extraction until its report is written (`producing`), which
 *     a prune reads again before each removal;
 *   - under an hour old.
 *
 * One lock (flock on a lock file, which the kernel lets go of when its holder dies) serialises prunes and every edit of
 * the holds file; a record that vanishes mid-scan, to a person, is skipped. A file hard-linked under several names is
 * counted once.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as v from 'valibot';
import { JOB_ID } from './protocol';

const STATE = join(homedir(), '.local', 'state', 'armada');

/** Where `armada run` writes its reports and the artifacts of their tasks. */
export const RUNS = join(STATE, 'runs');

/** The records no prune removes beyond those it names itself: one name per line. */
const HOLDS = join(STATE, 'holds');

/** Locked (flock) while one armada prunes or edits the holds file. */
const LOCK = join(STATE, 'retention.lock');

/** The markers of the runs extracting artifacts now (`producing`): each a file of its process's pid, listing names. */
const ACTIVE = join(STATE, 'active');

const REPORT_SUFFIX = '.json';

/** A record younger than this is not removed. */
const MIN_AGE_MS = 60 * 60_000;

const LOCK_POLL_MS = 100;

/** flock(2)'s exclusive lock. */
const LOCK_EX = 2;

/** flock(2)'s operation that answers at once rather than waiting. */
const LOCK_NB = 4;

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
  jobs: v.optional(v.array(v.looseObject({ job: v.string() })), []),
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

/** `path`'s usage, each file of several hard links counted once across a scan: `seen` holds the (device, inode) of
 *  those already counted. */
function usage(path: string, seen: Set<string>): Usage | undefined {
  const own = present(() => lstatSync(path));

  if (own === undefined) return undefined;
  const linked = !own.isDirectory() && own.nlink > 1;
  const inode = `${String(own.dev)}:${String(own.ino)}`;
  const counted = linked && seen.has(inode) ? 0 : own.blocks * BLOCK;

  if (linked) seen.add(inode);

  return { bytes: counted + (own.isDirectory() ? within(path, seen) : 0), mtimeMs: own.mtimeMs };
}

/** What a directory's entries take on disk. Symlinks count as themselves, and are never followed. */
function within(directory: string, seen: Set<string>): number {
  return (present(() => readdirSync(directory)) ?? []).reduce((sum, entry) => sum + (usage(join(directory, entry), seen)?.bytes ?? 0), 0);
}

/** A record: a report (`hasReport`) and the artifacts directories the run made (`directories`, its own name's among
 *  them where it has one), named by the report, or a directory no report owns by its own name. */
interface RunRecord {
  readonly name: string;
  readonly hasReport: boolean;
  readonly directories: readonly string[];
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** The artifacts directories the run of report `name` made: its own name's, each other job's in a run of several
 *  environments (`<project>-<job>`, as its report's `jobs` names them) and each its tasks' artifacts lie under. */
function ownedBy(name: string): string[] {
  const view = viewOf(reportPath(name));
  const project = projectOf(name);
  const jobs = project === undefined ? [] : (view?.jobs ?? []).map(({ job }) => `${project}-${job}`);
  const listed = Object.values(view?.artifacts ?? {}).map((directory) => basename(dirname(directory)));

  return [...new Set([name, ...jobs, ...listed])];
}

/** Every record under RUNS. A directory whose name no report has is read against the reports of its project written
 *  within MIN_AGE_MS of it (a run writes its report once it has extracted every job's artifacts), each of which owns
 *  the directories it names (`ownedBy`); one no report owns is a record of its own. Files that are not reports, and
 *  anything that is not a plain file or directory, are not records, and are left alone. */
function scan(): RunRecord[] {
  const entries = present(() => readdirSync(RUNS, { withFileTypes: true })) ?? [];
  const reports = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith(REPORT_SUFFIX)).map((entry) => recordName(entry.name)));
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const seen = new Set<string>();

  const reportUsage = new Map([...reports].flatMap((name) => {
    const found = usage(reportPath(name), seen);

    return found === undefined ? [] : [[name, found] as const];
  }));

  const directoryUsage = new Map([...directories].flatMap((name) => {
    const found = usage(join(RUNS, name), seen);

    return found === undefined ? [] : [[name, found] as const];
  }));

  // Each directory a report of another name owns: read only for the reports a directory without one could be part of.
  const owner = new Map<string, string>();

  for (const [directory, { mtimeMs }] of directoryUsage) {
    if (reportUsage.has(directory) || owner.has(directory)) continue;
    const project = projectOf(directory);
    const candidates = [...reportUsage].filter(([name, report]) => projectOf(name) === project && Math.abs(report.mtimeMs - mtimeMs) <= MIN_AGE_MS);

    for (const [name] of candidates) {
      for (const owned of ownedBy(name)) {
        if (owned !== name && directoryUsage.has(owned) && !reportUsage.has(owned)) owner.set(owned, name);
      }
    }
  }

  const records: RunRecord[] = [...reportUsage].map(([name, report]) => {
    const mine = [...directoryUsage.keys()].filter((directory) => directory === name || owner.get(directory) === name);
    const parts = [report, ...mine.map((directory) => directoryUsage.get(directory)).filter((found) => found !== undefined)];

    return { name, hasReport: true, directories: mine, bytes: parts.reduce((sum, part) => sum + part.bytes, 0), mtimeMs: Math.max(...parts.map((part) => part.mtimeMs)) };
  });

  for (const [directory, found] of directoryUsage) {
    if (!reportUsage.has(directory) && !owner.has(directory)) records.push({ name: directory, hasReport: false, directories: [directory], ...found });
  }

  return records;
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

/** The names the holds file lists, each as a record's name. */
function held(): Set<string> {
  return new Set((present(() => readFileSync(HOLDS, 'utf8')) ?? '').split('\n').map(recordName).filter((name) => name !== ''));
}

const MarkerSchema = v.array(v.string());

/** The directories the runs alive now are extracting artifacts into (`producing`); a marker a dead process left is
 *  removed. */
function producingNow(): Set<string> {
  const names = new Set<string>();

  for (const file of present(() => readdirSync(ACTIVE)) ?? []) {
    const pid = Number.parseInt(file, 10);
    const path = join(ACTIVE, file);

    if (!Number.isInteger(pid) || !running(pid)) {
      rmSync(path, { force: true });
      continue;
    }

    const listed = v.safeParse(MarkerSchema, JSON.parse(present(() => readFileSync(path, 'utf8')) ?? '[]'));

    for (const name of listed.success ? listed.output : []) names.add(name);
  }

  return names;
}

/** A run's marker (ACTIVE) naming `directories`, its jobs' artifacts directories, written before it extracts the
 *  first; the remover, to call once its report is written. A prune keeps every record a marker of a process alive
 *  names, and removes the marker of one that has exited, however it ended. */
export function producing(directories: readonly string[]): () => void {
  mkdirSync(ACTIVE, { recursive: true });
  const path = join(ACTIVE, `${String(process.pid)}-${String(Date.now())}`);

  writeFileSync(path, JSON.stringify(directories));

  return () => { rmSync(path, { force: true }); };
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

  return why;
}

/** Whether a run extracting artifacts now (`producingNow`) names any of `record`'s directories. */
function inProgress(record: RunRecord, producingNames: ReadonlySet<string>): boolean {
  return producingNames.has(record.name) || record.directories.some((directory) => producingNames.has(directory));
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
  /** The records it kept for being the newest green run of their project, or held. */
  readonly kept: number;
  /** Whether what is left is still past a bound, as every record that could go is gone: the rest are kept or new. */
  readonly past: boolean;
}

/** A prune of the records, which removes none with `dry`. The caller holds the lock. */
function pruneUnder(bounds: Bounds, dry: boolean): Pruned {
  const now = Date.now();
  const records = scan();
  const why = kept(records);
  const producingNames = producingNow();
  const oldestFirst = records.filter((record) => !why.has(record.name) && !inProgress(record, producingNames) && now - record.mtimeMs >= MIN_AGE_MS).toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  const removed: Removed[] = [];
  const gone = new Set<string>();
  let bytes = records.reduce((sum, record) => sum + record.bytes, 0);

  for (const record of oldestFirst) {
    const tooOld = now - record.mtimeMs > bounds.days * DAY_MS;

    if (!tooOld && bytes <= bounds.gb * GB) break;

    // A run that began extracting into it since the scan.
    if (inProgress(record, producingNow())) continue;

    if (!dry) {
      // The report first: a record that stops halfway leaves directories no report names, a record of their own.
      if (record.hasReport) rmSync(reportPath(record.name), { force: true });

      for (const directory of record.directories) rmSync(join(RUNS, directory), { recursive: true, force: true });
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

/** flock(2), from the C library: the lock a prune and every edit of the holds file take, which the kernel lets go of when
 *  its holder exits however it ends, so none is ever left to break. */
function flock(): (fd: number, operation: number) => number {
  const library = dlopen(process.platform === 'darwin' ? 'libc.dylib' : 'libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });

  return (fd, operation) => library.symbols.flock(fd, operation);
}

/** Takes the lock, waiting up to `patienceMs` for its holder; the release, or null when it is held still. */
async function lock(patienceMs: number): Promise<(() => void) | null> {
  mkdirSync(STATE, { recursive: true });
  const until = Date.now() + patienceMs;
  const fd = openSync(LOCK, 'a', 0o600);
  const locking = flock();

  for (;;) {
    if (locking(fd, LOCK_EX | LOCK_NB) === 0) return () => { closeSync(fd); };

    if (Date.now() >= until) {
      closeSync(fd);

      return null;
    }

    await Bun.sleep(LOCK_POLL_MS);
  }
}

/** `body`, holding the lock; a command waits up to LOCK_WAIT_MS for it. */
async function locked<T>(body: () => T): Promise<T> {
  const release = await lock(LOCK_WAIT_MS);

  if (release === null) throw new Error(`another armada is pruning run records or editing ${HOLDS} (it holds the lock on ${LOCK}); try again once it ends`);

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

    // After a line a person left without its newline.
    appendFileSync(HOLDS, `${current === '' || current.endsWith('\n') ? '' : '\n'}${name}\n`);

    return { added: true, exists };
  });
}

/** Lets a record go to the prunes again; whether it was held. The file is replaced whole, under the lock every edit of
 *  it takes, so it never holds half a line and no other edit is lost. */
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
