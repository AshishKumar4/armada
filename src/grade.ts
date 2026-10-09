/**
 * One verdict from a CI run's tasks. A run grades a commit only when every task answered and, where the plan names
 * rows, every named row was reported exactly once by the task that owns it, with a timing for each file it declares.
 * Anything short of that is ungraded (exit 2), never green. Otherwise every red row is listed (exit 1), or none
 * (exit 0). The collected file keeps each row as its task wrote it, under `{sha, part: "all", rows}`, but for a row a
 * problem names: that one carries the `problem`, and exits 2 where it reported green, so no reader counts it green.
 */
import * as v from 'valibot';
import { JsonSchema } from './protocol';

/** One row a task must report, and the files it must report a timing for, when the project splits rows by file. */
const ExpectedRow = v.union([v.string(), v.object({ name: v.string(), files: v.optional(v.array(v.string())) })]);

/** A row a plan entry names, as a name with the files it times, if it names them. */
export const expectedOf = (want: v.InferOutput<typeof ExpectedRow>): { readonly name: string; readonly files?: readonly string[] | undefined } => v.is(v.string(), want) ? { name: want } : want;

/** The plan: a GitHub-Actions-shaped matrix. */
export const PlanSchema = v.object({
  include: v.pipe(v.array(v.objectWithRest({ rows: v.optional(v.array(ExpectedRow)), weight: v.optional(v.number()) }, JsonSchema)), v.minLength(1)),
});

export type PlanEntry = v.InferOutput<typeof PlanSchema>['include'][number];

/** A row of a verdict file, named by `name`, or by `run`, the command it ran. */
const VerdictRowSchema = v.looseObject({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  exitCode: v.number(),
  seconds: v.optional(v.number(), 0),
  output: v.optional(v.string(), ''),
  timings: v.optional(v.record(v.string(), v.number())),
  /** Files in the task's artifacts directory the row points at as its evidence. */
  artifacts: v.optional(v.array(v.string())),
  /** The revision whose proof an unchanged row reused, where a project caches green rows. */
  cached: v.optional(v.string()),
  /** Why the run could not grade this row, which then reads red. */
  problem: v.optional(v.string()),
});

export type VerdictRow = v.InferOutput<typeof VerdictRowSchema>;

export const VerdictFileSchema = v.looseObject({ rows: v.array(VerdictRowSchema) });

export const rowName = (row: VerdictRow): string => row.name ?? row.run ?? '';

/** A task's name: the configured matrix key, else `name`, else the first string-valued key, else its position. */
export function taskName(entry: PlanEntry, key: string | undefined, index: number): string {
  const strings = Object.entries(entry).flatMap(([name, value]) => v.is(v.string(), value) ? [[name, value] as const] : []);
  const named = strings.find(([name]) => name === (key ?? 'name'))?.[1] ?? strings[0]?.[1];

  return named !== undefined && /^[A-Za-z0-9._-]{1,80}$/u.test(named) ? named : `task-${String(index + 1)}`;
}

/** How a task's own command ended. */
export interface TaskExit {
  readonly exitCode: number;
  /** The end of its output. */
  readonly tail: string;
  readonly seconds?: number;
}

/** A verdict file's rows under its task's exit: a task that exited nonzero failed, so every row it reported green is
 *  red with that exit; a row it already reported red keeps its own. A red row that kept no output shows the task's.
 *  A task that exited nonzero having reported no row, cut off at its timeout or killed before it wrote one, is red in
 *  every row its plan entry names (`expected`), or in a row of its own under its name when the entry names none. */
export function underExit(rows: readonly VerdictRow[], exit: TaskExit, task: string, expected?: PlanEntry['rows']): VerdictRow[] {
  if (rows.length === 0 && exit.exitCode !== 0) {
    const output = `the task exited ${String(exit.exitCode)} and reported no row\n${exit.tail}`;
    const names = expected === undefined || expected.length === 0 ? [task] : expected.map((want) => expectedOf(want).name);

    return names.map((name) => ({ name, exitCode: exit.exitCode, seconds: exit.seconds ?? 0, output }));
  }

  return rows.map((row) => {
    if (row.exitCode === 0 && exit.exitCode !== 0) {
      return { ...row, exitCode: exit.exitCode, output: `the task exited ${String(exit.exitCode)} after reporting this row green\n${exit.tail}` };
    }

    return row.exitCode !== 0 && row.output === '' ? { ...row, output: exit.tail } : row;
  });
}

export interface TaskAnswer {
  readonly name: string;
  readonly entry: PlanEntry;
  /** The task's verdict rows, or null when it wrote no verdict file. */
  readonly rows: readonly VerdictRow[] | null;
  /** The relative paths the task's artifacts directory kept, or null when it kept none. */
  readonly artifacts: ReadonlySet<string> | null;
}

export interface Graded {
  readonly problems: readonly string[];
  /** Every answer's rows, in order, one for one. */
  readonly rows: readonly VerdictRow[];
  readonly reds: readonly VerdictRow[];
}

/** How a run ended: not graded when anything was short, else failed when a row is red, else passed. */
export function outcomeOf({ problems, reds }: Graded): 'pass' | 'fail' | 'not graded' {
  if (problems.length > 0) return 'not graded';

  return reds.length === 0 ? 'pass' : 'fail';
}

/** The exit of a row a problem names that reported green: the run's own when it cannot grade. */
const UNGRADED_EXIT = 2;

/** Records a problem, and the row it names, if any; a row keeps the first that names it. */
type Flag = (problem: string, row?: VerdictRow) => void;

/** Each file's seconds in a run: the sum of the timings its rows report for it, so a file a plan splits over several
 *  rows is timed whole. A file a red row reports, or a row whose proof was reused, is left out: its other rows hold only
 *  part of its time. */
export function fileTimings(rows: readonly VerdictRow[]): Record<string, number> {
  const files: Record<string, number> = {};
  const partial = new Set<string>();

  for (const row of rows) {
    for (const [file, seconds] of Object.entries(row.timings ?? {})) {
      if (row.exitCode !== 0 || row.cached !== undefined) partial.add(file);
      files[file] = (files[file] ?? 0) + seconds;
    }
  }

  return Object.fromEntries(Object.entries(files).filter(([file]) => !partial.has(file)));
}

export function grade(answers: readonly TaskAnswer[]): Graded {
  const problems: string[] = [];
  const named = new Map<VerdictRow, string>();
  const reported: VerdictRow[] = [];
  const seen = new Map<string, string>();

  const flag: Flag = (problem, row) => {
    problems.push(problem);

    if (row !== undefined && !named.has(row)) named.set(row, problem);
  };

  for (const answer of answers) {
    if (answer.rows === null) {
      flag(`${answer.name} wrote no verdict`);
      continue;
    }

    for (const row of answer.rows) {
      const name = rowName(row);
      const owner = seen.get(name);

      if (name === '') flag(`${answer.name} reported a row with no name`, row);
      else if (owner !== undefined) flag(`${name} was reported by both ${owner} and ${answer.name}`, row);
      else seen.set(name, answer.name);
      reported.push(row);

      for (const path of row.artifacts ?? []) {
        if (answer.artifacts?.has(path) !== true) flag(`${answer.name}: ${rowName(row)} names evidence ${path} its task did not keep`, row);
      }
    }

    coverage(answer, flag);
  }

  const rows = reported.map((row) => {
    const problem = named.get(row);

    return problem === undefined ? row : { ...row, exitCode: row.exitCode === 0 ? UNGRADED_EXIT : row.exitCode, problem };
  });

  return { problems, rows, reds: rows.filter((row) => row.exitCode !== 0) };
}

/** A task whose plan entry names its rows reported exactly those, each with exactly its declared files' timings. */
function coverage(answer: TaskAnswer, flag: Flag): void {
  const expected = answer.entry.rows;

  if (expected === undefined || answer.rows === null) return;
  const reported = new Map(answer.rows.map((row) => [rowName(row), row]));

  for (const want of expected.map(expectedOf)) {
    const { name, files } = want;
    const row = reported.get(name);

    if (row === undefined) {
      flag(`${answer.name} has no verdict for ${name}; missing is not green`);
      continue;
    }

    reported.delete(name);
    const timed = Object.keys(row.timings ?? {});

    if (files !== undefined && (timed.length !== files.length || files.some((file) => !timed.includes(file)))) {
      flag(`${answer.name}: ${name} timed ${String(timed.length)} of its ${String(files.length)} files`, row);
    }
  }

  for (const [extra, row] of reported) flag(`${answer.name} reported ${extra}, which its plan entry does not name`, row);
}
