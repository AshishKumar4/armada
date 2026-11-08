import { describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchEnv } from './fakes';

const DAY_MS = 86_400_000;

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** A job's id, as the Worker makes them, from a number. */
const id = (n: number): string => `20261001${String(n).padStart(6, '0')}-${n.toString(16).padStart(8, '0')}`;

const stateOf = (home: string): string => join(home, '.local', 'state', 'armada');

const runsOf = (home: string): string => join(stateOf(home), 'runs');

/** Bytes a file system cannot make small: no run of equal ones, which one that compresses would store in nothing. */
function noise(bytes: number): Uint8Array {
  const made = new Uint8Array(bytes);

  for (let at = 0; at < bytes; at += 65_536) crypto.getRandomValues(made.subarray(at, Math.min(at + 65_536, bytes)));

  return made;
}

/** How a seeded record's report grades: its `graded`, or for a report from before `graded`, its one row; `orphan` has no
 *  report, as the extra jobs' directories of a run of several environments have none. */
type Kind = 'pass' | 'fail' | 'not graded' | 'legacy-pass' | 'legacy-fail' | 'orphan';

interface Seeding {
  /** How its report grades: red by default. */
  readonly kind?: Kind;
  /** What its artifacts directory takes; none is made for 0. */
  readonly bytes?: number;
  /** The names of other records' directories that its report lists as artifacts. */
  readonly lists?: readonly string[];
  /** The ids of its run's jobs, in a run of several environments: its own first. */
  readonly jobs?: readonly string[];
}

/** A report as `writeReport` (src/ci.ts) writes it, key for key. */
function reportText(kind: Kind, artifacts: Readonly<Record<string, string>>, jobs: readonly string[]): string {
  const head = { sha: 'a'.repeat(40), planJob: 'local', job: 'j' };
  const red = kind === 'fail' || kind === 'legacy-fail';
  const rows = [{ name: 'unit', exitCode: red ? 1 : 0, seconds: 1, output: '' }];
  const each = jobs.length === 0 ? undefined : jobs.map((job, at) => ({ environment: `env-${String(at)}`, size: 'medium', job, status: { id: job, phase: 'done' } }));
  const tail = { status: { id: 'j', phase: 'done' }, summary: null, problems: kind === 'not graded' ? ['a row was short'] : [], artifacts, jobs: each, verdicts: { sha: head.sha, part: 'all', rows } };

  if (kind === 'legacy-pass' || kind === 'legacy-fail') return JSON.stringify({ ...head, ...tail }, null, 2);

  return JSON.stringify({ ...head, graded: kind, ...tail }, null, 2);
}

/** Record `name` in `home`, last changed `days` ago. */
function seed(home: string, name: string, days: number, { kind = 'fail', bytes = 10_000, lists = [], jobs = [] }: Seeding = {}): void {
  const runs = runsOf(home);
  const when = (Date.now() - days * DAY_MS) / 1000;
  const directory = bytes > 0 || kind === 'orphan';
  // Its own directory is the report's first artifact; the directories it lists follow.
  const artifacts = Object.fromEntries((directory ? [name, ...lists] : lists).map((owner, at) => [String(at), join(runs, owner, '0-task')]));

  mkdirSync(runs, { recursive: true });

  if (kind !== 'orphan') writeFileSync(join(runs, `${name}.json`), reportText(kind, artifacts, jobs));

  if (directory) {
    mkdirSync(join(runs, name, '0-task'), { recursive: true });
    writeFileSync(join(runs, name, '0-task', 'blob'), noise(Math.max(bytes, 1)));
    utimesSync(join(runs, name), when, when);
  }

  if (kind !== 'orphan') utimesSync(join(runs, `${name}.json`), when, when);
}

/** `armada <words>` as a user in `home` runs it. */
async function armada(home: string, ...words: string[]) {
  const ran = Bun.spawn(['bun', CLI, ...words], { cwd: home, env: { ...scratchEnv(), HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(ran.stdout).text(), new Response(ran.stderr).text()]);

  return { exit: await ran.exited, out, err };
}

/** `body` with a home that is gone after it. */
async function inHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'armada-runs-'));

  try {
    await body(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const listing = (home: string): string[] => existsSync(runsOf(home)) ? readdirSync(runsOf(home)).toSorted() : [];

/** Every name a record has on disk: its report and its directory. */
const filesOf = (names: readonly string[]): string[] => names.flatMap((name) => [name, `${name}.json`]).toSorted();

/** The names a prune said it removed. */
const removedIn = (out: string): string[] => [...out.matchAll(/^(?:would remove|removed) (\S+) {2}/gmu)].flatMap((found) => found[1] ?? []).toSorted();

/** Records of four projects, which a prune with every bound at its tightest keeps eight of (see `kept`):
 *  - app: the newest green report (1), the directory it lists (2, no report of its own), one held by name (5), and one
 *    under an hour old (12); a red report newer than the green one (3) and an older one (4) go;
 *  - lib-x, a project whose name holds a dash: the newest green report (6) and one held with its `.json` (8); a report
 *    that was not graded, newer than the green (7), goes;
 *  - old: the newest green report of one from before `graded` (9); an older red one (10) goes;
 *  - solo, which never ran green: one held by its path (13); another (11) goes. */
function mixed(home: string) {
  const app = (n: number) => `app-${id(n)}`;
  const lib = (n: number) => `lib-x-${id(n)}`;
  const old = (n: number) => `old-${id(n)}`;
  const solo = (n: number) => `solo-${id(n)}`;

  seed(home, app(1), 30, { kind: 'pass', lists: [app(2)] });
  seed(home, app(2), 30, { kind: 'orphan' });
  seed(home, app(5), 35);
  seed(home, app(12), 0.02);
  seed(home, lib(6), 25, { kind: 'pass' });
  seed(home, lib(8), 50);
  seed(home, old(9), 50, { kind: 'legacy-pass' });
  seed(home, solo(13), 45);
  seed(home, app(3), 20);
  seed(home, app(4), 40);
  seed(home, lib(7), 21, { kind: 'not graded' });
  seed(home, old(10), 60, { kind: 'legacy-fail' });
  seed(home, solo(11), 40);
  // What other tools write: a bare name, a report's file name, a path to one, a record that is gone, a blank line.
  writeFileSync(join(stateOf(home), 'holds'), `${[app(5), `${lib(8)}.json`, join(runsOf(home), `${solo(13)}.json`), `gone-${id(99)}`, ''].join('\n')}\n`);

  return { kept: [app(1), app(5), app(12), lib(6), lib(8), old(9), solo(13)], directoryOnly: [app(2)], removed: [app(3), app(4), lib(7), old(10), solo(11)] };
}

describe('armada runs prune', () => {
  test('removes the records past the age bound, a report with its artifacts as one, and no record within it', async () => {
    await inHome(async (home) => {
      const app = (n: number) => `app-${id(n)}`;

      seed(home, app(1), 20);
      seed(home, app(2), 15, { bytes: 0 });
      seed(home, app(3), 16, { kind: 'orphan' });
      seed(home, app(4), 13);
      seed(home, app(5), 2);

      const pruned = await armada(home, 'runs', 'prune');

      expect({ exit: pruned.exit, removed: removedIn(pruned.out), left: listing(home), summary: /^removed 3 of 5 run records/mu.test(pruned.out) }).toEqual({
        exit: 0, removed: [app(1), app(2), app(3)].toSorted(), left: filesOf([app(4), app(5)]), summary: true,
      });
    });
  });

  test('removes the oldest records first to the size bound, though none is past the age bound', async () => {
    await inHome(async (home) => {
      const app = (n: number) => `app-${id(n)}`;

      // 2 MB of artifacts each: three of them are past 5 MB, two are not.
      for (const [n, days] of [[1, 5], [2, 4], [3, 3], [4, 2]] as const) seed(home, app(n), days, { bytes: 2_000_000 });

      const pruned = await armada(home, 'runs', 'prune', '--gb=0.005');

      expect({ exit: pruned.exit, removed: removedIn(pruned.out), left: listing(home) }).toEqual({ exit: 0, removed: [app(1), app(2)], left: filesOf([app(3), app(4)]) });
    });
  });

  test('keeps the newest green report of each project, every held record and a run in progress, under each bound alone and both', async () => {
    const outcomes: { readonly exit: number; readonly listed: string[]; readonly removed: string[]; readonly kept: string[]; readonly gone: string[]; readonly summary: boolean }[] = [];

    // The age bound alone (every record is past 0 days), the size bound alone (no record is past 100,000 days), then both.
    for (const bounds of [['--days=0', '--gb=1000'], ['--days=100000', '--gb=0'], ['--days=0', '--gb=0']]) {
      await inHome(async (home) => {
        const { kept, directoryOnly, removed } = mixed(home);
        const pruned = await armada(home, 'runs', 'prune', ...bounds);

        outcomes.push({
          exit: pruned.exit, listed: listing(home), removed: removedIn(pruned.out), kept: [...filesOf(kept), ...directoryOnly].toSorted(), gone: removed.toSorted(),
          summary: /^removed 5 of 12 run records/mu.test(pruned.out),
        });
      });
    }

    expect(outcomes.map(({ exit, listed, removed, summary }) => [exit, listed, removed, summary])).toEqual(outcomes.map(({ kept, gone }) => [0, kept, gone, true]));
    expect(outcomes).toHaveLength(3);
  });

  test('a dry run says what it would remove, and removes nothing', async () => {
    await inHome(async (home) => {
      const { removed } = mixed(home);
      const before = listing(home);
      const held = readFileSync(join(stateOf(home), 'holds'), 'utf8');
      const pruned = await armada(home, 'runs', 'prune', '--days=0', '--gb=0', '--dry-run');

      expect({
        exit: pruned.exit, removed: removedIn(pruned.out), said: pruned.out.includes('would remove 5 of 12 run records') && !pruned.out.includes('removed '),
        listing: listing(home), holds: readFileSync(join(stateOf(home), 'holds'), 'utf8'), state: readdirSync(stateOf(home)).toSorted(),
      }).toEqual({ exit: 0, removed: removed.toSorted(), said: true, listing: before, holds: held, state: ['holds', 'retention.lock', 'runs'] });
    });
  });

  test('reads its bounds from the connection file in use, where a flag outranks them, and refuses ones that are not numbers', async () => {
    await inHome(async (home) => {
      const app = (n: number) => `app-${id(n)}`;

      const connection = (retention: Readonly<Record<string, string | number>>) => {
        mkdirSync(join(home, '.config', 'armada'), { recursive: true });
        writeFileSync(join(home, '.config', 'armada', 'connection.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 't', account: '', retention }));
      };

      connection({ days: 1 });
      seed(home, app(1), 3);
      seed(home, app(2), 0.5);
      const configured = await armada(home, 'runs', 'prune');
      const left = listing(home);

      seed(home, app(3), 3);
      const flagged = await armada(home, 'runs', 'prune', '--days=10');
      const kept = listing(home);

      connection({ days: 'a week' });
      const refused = await armada(home, 'runs', 'prune');

      connection({ days: 1, weeks: 2 });
      const unknown = await armada(home, 'runs', 'prune');

      expect({ configured: [configured.exit, removedIn(configured.out), left], flagged: [flagged.exit, removedIn(flagged.out), kept], refused: [refused.exit, refused.err.includes('connection.json')], unknown: [unknown.exit, unknown.err.includes('weeks')] }).toEqual({
        configured: [0, [app(1)], filesOf([app(2)])], flagged: [0, [], filesOf([app(2), app(3)])], refused: [2, true], unknown: [2, true],
      });
    });
  });

  test('refuses a bound that is not a number and a name it does not take, and removes nothing', async () => {
    await inHome(async (home) => {
      seed(home, `app-${id(1)}`, 30);
      const runs = await Promise.all([['runs', 'prune', '--days=soon'], ['runs', 'prune', '--gb=-1'], ['runs', 'prune', '--gb='], ['runs', 'prune', 'app'], ['runs', 'hold', 'app', '--dry-run'], ['runs', 'forget'], ['runs']].map(async (words) => await armada(home, ...words)));

      expect({ exits: runs.map(({ exit }) => exit), left: listing(home) }).toEqual({ exits: [2, 2, 2, 2, 2, 2, 2], left: filesOf([`app-${id(1)}`]) });
    });
  });

  test('takes the lock whatever file a dead process left, and prunes that run at once wait for one another', async () => {
    await inHome(async (home) => {
      const app = (n: number) => `app-${id(n)}`;
      const dead = Bun.spawn(['true'], { env: scratchEnv() });

      await dead.exited;
      mkdirSync(stateOf(home), { recursive: true });
      writeFileSync(join(stateOf(home), 'retention.lock'), `${String(dead.pid)}\n`);
      const held = await armada(home, 'runs', 'hold', app(1));

      for (let n = 1; n <= 30; n += 1) seed(home, app(100 + n), 21, { bytes: 20_000 });
      const both = await Promise.all([armada(home, 'runs', 'prune'), armada(home, 'runs', 'prune')]);

      expect({
        held: [held.exit, readFileSync(join(stateOf(home), 'holds'), 'utf8')],
        exits: both.map(({ exit }) => exit),
        removed: both.map(({ out }) => removedIn(out).length).toSorted((left, right) => left - right),
        left: listing(home),
        state: readdirSync(stateOf(home)).toSorted(),
      }).toEqual({ held: [0, `${app(1)}\n`], exits: [0, 0], removed: [0, 30], left: [], state: ['holds', 'retention.lock', 'runs'] });
    });
  });
});

describe('armada runs prune, a record whole', () => {
  test('removes a run of several environments with every job\'s directory, never one directory of it alone', async () => {
    await inHome(async (home) => {
      const multi = (n: number) => `multi-${id(n)}`;

      // A run of two jobs: its report and its own directory, and its second job's directory, a day older, which a
      // prune removing the oldest first by directory would take alone, leaving the report naming evidence that is gone.
      seed(home, multi(1), 30, { bytes: 1_000_000, jobs: [id(1), id(2)] });
      seed(home, multi(2), 30.0001, { kind: 'orphan', bytes: 1_000_000 });
      seed(home, `other-${id(3)}`, 20, { bytes: 1_000_000 });
      const pruned = await armada(home, 'runs', 'prune', '--days=100000', '--gb=0.0025');

      expect([pruned.exit, removedIn(pruned.out), listing(home)]).toEqual([0, [multi(1)], filesOf([`other-${id(3)}`])]);
    });
  });

  test('keeps a directory a run is extracting into however old, and a dead run\'s marker goes', async () => {
    await inHome(async (home) => {
      const active = join(stateOf(home), 'active');
      const dead = Bun.spawn(['true'], { env: scratchEnv() });

      await dead.exited;
      seed(home, `live-${id(1)}`, 30, { kind: 'orphan' });
      seed(home, `gone-${id(2)}`, 30, { kind: 'orphan' });
      mkdirSync(active, { recursive: true });
      writeFileSync(join(active, `${String(process.pid)}-1`), JSON.stringify([`live-${id(1)}`]));
      writeFileSync(join(active, `${String(dead.pid)}-1`), JSON.stringify([`gone-${id(2)}`]));
      const pruned = await armada(home, 'runs', 'prune', '--days=0');

      expect([pruned.exit, listing(home), readdirSync(active)]).toEqual([0, [`live-${id(1)}`], [`${String(process.pid)}-1`]]);
    });
  });

  test('counts a file hard-linked under several names once', async () => {
    await inHome(async (home) => {
      const name = `linked-${id(1)}`;

      seed(home, name, 30, { bytes: 1_000_000 });
      linkSync(join(runsOf(home), name, '0-task', 'blob'), join(runsOf(home), name, '0-task', 'again'));
      linkSync(join(runsOf(home), name, '0-task', 'blob'), join(runsOf(home), name, '0-task', 'once-more'));
      utimesSync(join(runsOf(home), name), (Date.now() - 30 * DAY_MS) / 1000, (Date.now() - 30 * DAY_MS) / 1000);
      const pruned = await armada(home, 'runs', 'prune', '--days=100000', '--gb=0.0015');

      expect([pruned.exit, removedIn(pruned.out)]).toEqual([0, []]);
    });
  });
});

describe('armada runs hold and release', () => {
  test('add a line to the holds file and take it out, and leave every other line as other tools wrote it', async () => {
    await inHome(async (home) => {
      const app = (n: number) => `app-${id(n)}`;
      const holds = join(stateOf(home), 'holds');

      seed(home, app(1), 3);
      const first = await armada(home, 'runs', 'hold', app(1));
      const written = readFileSync(holds, 'utf8');
      const again = await armada(home, 'runs', 'hold', `${app(1)}.json`);
      const repeated = readFileSync(holds, 'utf8');

      // Another tool appends a line, with no newline after it, and a record the CLI has no report of is held all the same.
      appendFileSync(holds, 'receipt-x');
      const second = await armada(home, 'runs', 'hold', join(runsOf(home), `${app(2)}.json`));
      const appended = readFileSync(holds, 'utf8');
      const released = await armada(home, 'runs', 'release', app(1));
      const remaining = readFileSync(holds, 'utf8');
      const unheld = await armada(home, 'runs', 'release', app(7));
      const unchanged = readFileSync(holds, 'utf8');
      const invalid = await armada(home, 'runs', 'hold', 'two words');

      expect({
        first: [first.exit, first.out.trim(), written], again: [again.exit, again.out.trim(), repeated],
        second: [second.exit, appended, second.err.includes(`no run record named ${app(2)}`)],
        released: [released.exit, released.out.trim(), remaining], unheld: [unheld.exit, unheld.out.trim(), unchanged],
        invalid: [invalid.exit, invalid.err.includes('two words'), readFileSync(holds, 'utf8')],
        state: readdirSync(stateOf(home)).toSorted(),
      }).toEqual({
        first: [0, `holding ${app(1)}`, `${app(1)}\n`], again: [0, `${app(1)} is already held`, `${app(1)}\n`],
        second: [0, `${app(1)}\nreceipt-x\n${app(2)}\n`, true],
        released: [0, `released ${app(1)}`, `receipt-x\n${app(2)}\n`], unheld: [0, `${app(7)} was not held`, `receipt-x\n${app(2)}\n`],
        invalid: [2, true, `receipt-x\n${app(2)}\n`],
        state: ['holds', 'retention.lock', 'runs'],
      });
    });
  });

  test('a held record survives a prune that would remove it, and goes with the next once it is released', async () => {
    await inHome(async (home) => {
      const app = (n: number) => `app-${id(n)}`;

      seed(home, app(1), 40);
      seed(home, app(2), 40);
      await armada(home, 'runs', 'hold', app(1));
      const held = await armada(home, 'runs', 'prune');
      const left = listing(home);

      await armada(home, 'runs', 'release', app(1));
      const released = await armada(home, 'runs', 'prune');

      expect({ held: [held.exit, removedIn(held.out), left], released: [released.exit, removedIn(released.out), listing(home)] }).toEqual({ held: [0, [app(2)], filesOf([app(1)])], released: [0, [app(1)], []] });
    });
  });
});
