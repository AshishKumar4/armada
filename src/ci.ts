/**
 * `armada run <commit|worktree>`: a project's CI as two maps. The commit's `.armada.json` names the recipe; the
 * commit is packed into R2 (its history from the root the first time its environment is prepared, otherwise only what
 * it adds). One task runs the project's plan command, which prints the tasks; a second job maps the task command over
 * them, longest first, on a pool of containers that each pull task after task. Every task's verdict file is graded
 * (`grade.ts`), every red row printed with its output's tail, and the collected verdict and the green rows' timings
 * stored on the runner. Exits 0 when every planned row ran once and passed, 1 when one was red, 2 when not graded.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { checkoutOf, CONFIG_FILE, environmentOf, parseConfig, type Config } from './config';
import { git, manifestOf, packBase, packOf, resolveCommit, shallowOf } from './git';
import { listSchedule } from './dispatch';
import { expectedOf, fileTimings, grade, outcomeOf, PlanSchema, rowName, taskName, underExit, VerdictFileSchema, type PlanEntry, type TaskAnswer, type VerdictRow } from './grade';
import { ARTIFACTS_PATH, describeUsage, errorOf, FILES_DIR, fill, fitSize, gangOf, itemValues, jsonOf, OUT_PATH, PACKER, TimingsSchema, usageOf, workdirOf, type JobStatus, type Size, type Timings } from './protocol';
import { describeBoots, unconnected, type Armada, type Summary } from './sdk';
import { commandTask, type Job, type Json, type Recipe, type Result } from './task';

const REPORTS = join(homedir(), '.local', 'state', 'armada', 'runs');

/** Lines of a red row's output printed; the whole of it is in the report. */
const TAIL_LINES = 60;

const TIMINGS_FILE = 'timings.json';

/** A plan run on this machine: the checkout and commit it runs in, its command, the run's target and timings, and the
 *  config's env. */
interface LocalPlan {
  readonly repo: string;
  readonly sha: string;
  readonly command: readonly string[];
  readonly target: number;
  readonly timings: Timings;
  readonly env: Readonly<Record<string, string>>;
  readonly deadlineAt?: number;
}

/** Each job gets only what remains of the CI run's deadline, in whole seconds: a slow plan must not reset the task
 *  job's clock. Null once it has passed, when no job may start, and the run is ungraded (#37). */
export function remainingDeadline(deadlineAt: number): number | null {
  const remaining = Math.ceil((deadlineAt - Date.now()) / 1000);

  return remaining > 0 ? remaining : null;
}

/** Why a run that could start no further job is ungraded. */
const PASSED = (next: string) => `CiDeadlineExceeded: the CI run passed its deadline before its ${next} could start`;

/** The plan's stdout, run in `repo` where its checkout is `sha` and clean, with `{target}` and `{timings}` filled here;
 *  undefined where it is not that commit, and the plan runs in a container. A container's start, cold on a new machine,
 *  was 61 of the 70 seconds Dew's plan took. The plan is the commit's own code, so it runs without the deployment's
 *  bearer this process holds (#33). */
export function localPlan({ repo, sha, command, target, timings, env, deadlineAt }: LocalPlan): string | undefined {
  if (git(repo, ['rev-parse', 'HEAD']).toString().trim() !== sha || git(repo, ['status', '--porcelain']).toString().trim() !== '') return undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'armada-plan-'));

  try {
    writeFileSync(join(scratch, TIMINGS_FILE), JSON.stringify(timings));
    const argv = command.map((word) => word.replaceAll('{target}', String(target)).replaceAll('{timings}', join(scratch, TIMINGS_FILE)));
    const filled = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value.replaceAll('{workdir}', repo)]));
    const left = deadlineAt === undefined ? undefined : remainingDeadline(deadlineAt);

    if (left === null) throw new Error(PASSED('plan'));
    const ran = Bun.spawnSync(argv, { cwd: repo, env: { ...unconnected(process.env), ...filled }, stdout: 'pipe', stderr: 'pipe', timeout: left === undefined ? undefined : left * 1000, killSignal: 'SIGKILL' });

    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error('CiDeadlineExceeded: the local plan passed the CI run\'s deadline');

    if (ran.exitCode !== 0) throw new Error(`the plan exited ${String(ran.exitCode)}: ${ran.stderr.toString().slice(-2000)}`);

    return ran.stdout.toString();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const clock = (ms: number): string => `${String(Math.floor(ms / 60_000))}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** A followed job's interruption: the cancel it started, which the CLI's exit waits on. */
interface Interruption {
  cancelling: Promise<never> | null;
}

/** A job the CLI follows: its id, once its creation answers, and its cancel. */
interface Followed {
  readonly id: Promise<string>;
  cancel(): Promise<void>;
}

/** Cancels each of `jobs` that was created, saying which and why, and saying any a cancel did not reach, whose
 *  containers then run on to their deadline. */
async function cancelEach(jobs: readonly Followed[], why: string): Promise<void> {
  await Promise.all(jobs.map(async (job) => {
    const [created] = await Promise.allSettled([job.id]);

    if (created.status === 'rejected') return;
    console.error(`armada: ${why}: cancelling job ${created.value}`);

    try {
      await job.cancel();
    } catch (cause) {
      console.error(`armada: cancelling job ${created.value} failed: ${errorOf({ cause }).message}`);
    }
  }));
}

/** `body`, while it follows `jobs`: interrupting the CLI (Ctrl-C, or a CI job cancelled) cancels every one of them,
 *  rather than leaving their containers to run for an answer nobody reads, and exits 2 once all are cancelled. `jobs`
 *  is read when the interrupt comes, so a body that starts jobs adds each as it starts it, its creation still in
 *  flight; one whose creation failed has nothing to cancel. */
export async function cancelOnInterrupt<T>(jobs: readonly Followed[], body: () => Promise<T>): Promise<T> {
  // Once interrupted, the cancel's end is the CLI's: a job that finishes meanwhile does not answer for it. Held in an
  // object the handler sets, so the read after `body` is not narrowed to the null it starts as.
  const interruption: Interruption = { cancelling: null };

  const cancel = async (signal: NodeJS.Signals): Promise<never> => {
    await cancelEach(jobs, signal);
    process.exit(2);
  };

  const interrupted = (signal: NodeJS.Signals): void => {
    interruption.cancelling ??= cancel(signal);
  };

  process.once('SIGINT', interrupted).once('SIGTERM', interrupted);

  try {
    const result = await body();

    if (interruption.cancelling !== null) return await interruption.cancelling;

    return result;
  } finally {
    process.off('SIGINT', interrupted).off('SIGTERM', interrupted);
  }
}

/** A result's word by its exit: green, RED with the exit code, or FAILED with why it never finished. */
function exitWord(result: Result<Json, string | null>): string {
  switch (result.kind) {
    case 'ok': return 'green';
    case 'lost':
    case 'cancelled': return `FAILED: ${result.reason.slice(-300)}`;
    case 'error':
    case 'timeout': return `RED (exit ${String(result.meta.exitCode)})`;
  }
}

/** A command template's argv for one item: `{item}`, an object item's scalar keys, `{index}`, `{out}`, `{files}`,
 *  `{artifacts}`, `{workdir}` and `{commit}` filled; any other placeholder is an error, never an empty string. */
export function argvOf(template: readonly string[], recipe: Recipe): (item: Json, at: { readonly index: number }) => string[] {
  const fixed = { out: OUT_PATH, files: FILES_DIR, artifacts: ARTIFACTS_PATH, workdir: workdirOf(recipe), commit: recipe.commit?.sha ?? '' };

  return (item, { index }) => template.map((word) => fill(word, { ...itemValues(item, index), ...fixed }));
}

/** How a followed job is said: each task's name, the words for its outcome, and where each line goes. */
interface Following<O> {
  readonly name: (index: number) => string;
  readonly say: (result: Result<Json, O>) => Promise<string> | string;
  readonly note: (line: string) => void;
}

/** Follows a job to its end, saying each phase once, a status it cannot read once, and each outcome as it lands. Its
 *  caller cancels it on an interrupt (`cancelOnInterrupt`). */
async function follow<O extends string | null>(job: Job<Json, O>, began: number, { name, say, note }: Following<O>): Promise<Result<Json, O>[]> {
  const results: Result<Json, O>[] = [];
  let said = '';
  let polled: Promise<void> | null = null;

  const poll = async (): Promise<void> => {
    let line: string;

    try {
      const status = await job.status();

      line = status.phase === 'preparing' ? `preparing environment ${status.key.slice(0, 12)}` : status.phase;
    } catch (cause) {
      line = `its status is not answering: ${errorOf({ cause }).message}`;
    }

    if (line === said) return;
    said = line;
    note(`${clock(Date.now() - began).padStart(6)}  ${line}`);
  };

  const watcher = setInterval(() => { polled ??= poll().finally(() => { polled = null; }); }, 3_000);

  try {
    for await (const result of job) {
      results.push(result);
      const alone = result.meta.aloneAfter === undefined ? '' : ` alone, after it failed beside other tasks (${result.meta.aloneAfter}),`;

      note(`${clock(Date.now() - began).padStart(6)}  ${name(result.index).padEnd(14)} ${await say(result)}${alone} in ${clock(result.meta.seconds * 1000)} on ${result.meta.container}`);
    }

    return results;
  } finally {
    clearInterval(watcher);
  }
}

/** `archive`, a task's stored tar.gz, extracted under `dir` with the system tar: a member that is absolute or climbs
 *  out of `dir` is refused, so a task's archive cannot write outside where it lands. The members' relative paths,
 *  directories out. */
export function extractTar(archive: Uint8Array, dir: string): string[] {
  const listed = Bun.spawnSync(['tar', '-tzf', '-'], { stdin: archive, stdout: 'pipe', stderr: 'pipe' });

  if (listed.exitCode !== 0) throw new Error(`listing the artifacts: ${listed.stderr.toString().trim()}`);
  const members = listed.stdout.toString().split('\n').map((member) => member.startsWith('./') ? member.slice(2) : member).filter((member) => member !== '');

  for (const member of members) {
    if (member.startsWith('/') || member.split('/').includes('..')) throw new Error(`the artifacts hold ${member}, which escapes ${dir}`);
  }

  mkdirSync(dir, { recursive: true });
  const ran = Bun.spawnSync(['tar', '-xzf', '-', '-C', dir], { stdin: archive, stdout: 'pipe', stderr: 'pipe' });

  if (ran.exitCode !== 0) throw new Error(`extracting the artifacts: ${ran.stderr.toString().trim()}`);

  return members.filter((member) => !member.endsWith('/'));
}

function printReds(reds: readonly VerdictRow[], evidence: ReadonlyMap<VerdictRow, string>, note: (line: string) => void = console.log): void {
  for (const row of reds) {
    note(`\nRED  ${rowName(row)}  (exit ${String(row.exitCode)}, ${seconds(row.seconds * 1000)})`);
    note(row.output.split('\n').slice(-TAIL_LINES).map((line) => `  | ${line}`).join('\n'));
    const dir = evidence.get(row);

    if (dir !== undefined) for (const path of row.artifacts ?? []) note(`  evidence: ${join(dir, path)}`);
  }
}

/** The verdict `armada run` stored for a commit: 0 when every row is green, 1 when a row is red, and 2 when the commit
 *  has none. `json` prints the verdict file itself, `{sha, part, rows}`, or `null` for none, so a caller tells none
 *  from an error, which exits 2 too. */
export async function verdictCI(armada: Armada, target: string, json: boolean): Promise<number> {
  const { sha, repo } = resolveCommit(target);
  const config = parseConfig(git(repo, ['show', `${sha}:${CONFIG_FILE}`]).toString());
  const answer = await armada.call(`/verdicts/${config.name}/${sha}`);

  if (answer.status === 404) {
    if (json) console.log('null');
    console.error(`${config.name} ${sha} has no verdict; armada run ${sha.slice(0, 12)} grades one`);

    return 2;
  }

  const text = await answer.text();
  const { rows } = v.parse(VerdictFileSchema, JSON.parse(text));
  const reds = rows.filter((row) => row.exitCode !== 0);

  if (json) console.log(text);
  else {
    printReds(reds, new Map());
    console.log(`${reds.length === 0 ? 'PASS' : 'FAIL'}: ${String(rows.length - reds.length)} of ${String(rows.length)} rows green, ${config.name} ${sha}`);
  }

  return reds.length === 0 ? 0 : 1;
}

/** What runs a command on a commit: its recipe, and the env and tmpfs its `.armada.json` names. */
interface OnCommit {
  readonly recipe: Recipe;
  readonly env: Readonly<Record<string, string>>;
  readonly tmpfs: readonly string[];
}

/** A run's container size: the config's, or with `auto` the smallest the last runs' usage fits, medium until a run has
 *  measured its tasks. */
function sizeOf(config: Config, timings: Timings): Size {
  if (config.size !== 'auto') return config.size;

  return timings.usage === null || timings.usage === undefined ? 'medium' : fitSize(timings.usage);
}

/** A commit and its `.armada.json`: its environment, its job fields, and the upload of its pack, which sends nothing
 *  when the runner has it. */
async function commitOf(armada: Armada, target: string) {
  const { sha, repo } = resolveCommit(target);
  const config = parseConfig(git(repo, ['show', `${sha}:${CONFIG_FILE}`]).toString());
  const timings = v.parse(TimingsSchema, await (await armada.call(`/timings/${config.name}`)).json());
  const size = sizeOf(config, timings);
  const of = async (name: string | undefined) => await prepared(armada, { repo, sha, config, size, name });

  return { sha, repo, config, timings, of, ...await of(undefined) };
}

/** One of the commit's environments, the project's or one `environments` names: its key and base as the deployment
 *  resolves them, its job fields, and the upload of its pack against that base, which sends nothing when the runner has
 *  it. */
async function prepared(armada: Armada, { repo, sha, config, size, name }: { readonly repo: string; readonly sha: string; readonly config: Config; readonly size: Size; readonly name: string | undefined }) {
  const environment = environmentOf(config, name);
  // The recipe, its scripts read from the commit as text.
  const text = (path: string | undefined) => path === undefined ? '' : git(repo, ['show', `${sha}:${path}`]).toString();

  const recipe: Omit<Recipe, 'commit'> = {
    base: environment.base, setup: text(environment.setup), install: text(environment.install),
    size, repo: { project: config.name, checkout: checkoutOf(config), history: config.history, manifest: manifestOf(repo, sha, environment) },
  };

  const resolved = await armada.resolve(recipe);
  const base = packBase(repo, resolved.base);
  const commit = { sha, base, packer: PACKER, shallow: shallowOf(repo, sha, config.history) };
  const spec: OnCommit = { recipe: { ...recipe, commit }, env: config.env, tmpfs: config.tmpfs };

  return { environment: resolved, spec, upload: async () => await armada.uploadPack(config.name, commit, () => packOf(repo, sha, base, config.history)) };
}

/** A commit's job fields, its pack uploaded. */
export async function onCommit(armada: Armada, target: string): Promise<OnCommit> {
  const commit = await commitOf(armada, target);

  await commit.upload();

  return commit.spec;
}

/** The containers each of a run's environments' task jobs runs on, all at once within the pool: each on at least its
 *  widest gang (and 1), and the rest of the pool given to them in proportion to their estimated seconds (their tasks'
 *  count where any has no estimate), D'Hondt, up to what each can use. One job gets the pool as `lanesFor` would. When
 *  more than one job's widest gangs together pass the pool, how many containers they need instead. */
export function sharesFor(pool: number, slots: number, groups: readonly { readonly estimates: readonly (number | undefined)[]; readonly ranks: readonly number[] }[]): number[] | { readonly need: number } {
  const known = groups.every(({ estimates }) => estimates.every((estimate) => estimate !== undefined));

  const sized = groups.map(({ estimates, ranks }) => {
    const widest = Math.max(1, ...ranks);
    const least = Math.min(pool, widest);
    const total = ranks.reduce((sum, each) => sum + each, 0);
    const weight = known ? estimates.reduce((sum: number, estimate, at) => sum + (estimate ?? 0) * (ranks[at] ?? 1), 0) : total;

    return { widest, least, most: Math.max(least, Math.ceil(total / slots)), weight };
  });

  const need = sized.reduce((sum, job) => sum + job.widest, 0);

  // One job's gang past the pool is the Worker's to refuse, by name, as in a run of one environment.
  if (sized.length > 1 && need > pool) return { need };
  const shares = sized.map((job) => job.least);

  for (let left = pool - shares.reduce((sum, each) => sum + each, 0); left > 0; left -= 1) {
    // The next container goes to the job with the most weight for each container it would then hold.
    const next = sized.reduce((best, job, at) => {
      const held = shares[at] ?? job.least;

      return held < job.most && (best < 0 || job.weight / (held + 1) > (sized[best]?.weight ?? 0) / ((shares[best] ?? 0) + 1)) ? at : best;
    }, -1);

    if (next < 0) break;
    shares[next] = (shares[next] ?? 0) + 1;
  }

  return shares;
}

/** A run's task jobs' summaries as one: its counts and containers summed, its times the longest. One job's is its own. */
function together(summaries: readonly Summary[]): Summary {
  const [only] = summaries;

  if (only !== undefined && summaries.length === 1) return only;
  const sum = (field: 'tasks' | 'green' | 'red' | 'failed' | 'vessels') => summaries.reduce((total, summary) => total + summary[field], 0);
  const mapMs = Math.max(0, ...summaries.map((summary) => summary.mapMs));
  const done = sum('green') + sum('red') + sum('failed');

  return {
    tasks: sum('tasks'), green: sum('green'), red: sum('red'), failed: sum('failed'), wallMs: Math.max(0, ...summaries.map((summary) => summary.wallMs)), mapMs, vessels: sum('vessels'),
    bootMs: summaries.flatMap((summary) => summary.bootMs).toSorted((left, right) => left - right), boots: summaries.flatMap((summary) => summary.boots),
    tasksPerSecond: mapMs > 0 ? done / (mapMs / 1000) : 0,
  };
}

/** A task's seconds: its plan entry's `weight`, else the last runs' medians of the rows it names, or of the task. */
function estimateOf(entry: PlanEntry, name: string, timings: Timings): number | undefined {
  const rows = entry.rows?.map((row) => timings.rows[expectedOf(row).name]) ?? [timings.rows[name]];

  return entry.weight ?? (rows.every((estimate) => estimate !== undefined) ? rows.reduce((sum, estimate) => sum + estimate, 0) : undefined);
}

/** The fewest containers, up to `most`, that finish these tasks as soon as `most` would, queued longest first: every
 *  container that runs more than one task must finish a fifth of the longest task's time before it does. */
export function poolFor(estimates: readonly number[], most: number): number {
  const longest = Math.max(0, ...estimates);
  const queue = [...estimates].sort((left, right) => right - left);

  for (let pool = 1; pool < most; pool += 1) {
    const { lanes, loads } = listSchedule(queue, Array.from({ length: pool }, () => 0));

    if (loads.every((load, machine) => (lanes[machine]?.length ?? 0) === 1 || load <= longest * 0.8)) return pool;
  }

  return most;
}

/** A run's lanes and the containers that carry them: `poolFor` sizes the lanes, and each container carries `slots`
 *  of them. */
export function lanesFor(estimates: readonly (number | undefined)[], weights: readonly number[], containers: number, slots: number) {
  const most = Math.min(containers * slots, weights.reduce((sum, each) => sum + each, 0));
  // A gang's every rank takes a container at once: it weighs as many lanes, and the pool holds the widest it can.
  const widest = Math.min(most, Math.max(0, ...weights));

  const lanes = estimates.every((estimate) => estimate !== undefined)
    ? Math.max(widest, poolFor(estimates.flatMap((estimate, index) => Array<number>(weights[index] ?? 1).fill(estimate ?? 0)), most))
    : most;

  return { lanes, pool: Math.max(widest, Math.ceil(lanes / slots)) };
}

/** What `armada run` was asked: its label, the plan's narrowing args, its own secrets, and whether it answers as JSON. */
export interface RunOptions {
  /** The whole run's bound in seconds; the commit's config (1800 by default) when absent. */
  readonly deadline?: number;
  readonly label: string;
  readonly planArgs: readonly string[];
  readonly secrets: readonly string[];
  readonly json: boolean;
}

/** A failed task's verdict file, which it may have written before it failed, as text; null when it wrote none. */
async function verdictText(job: Job<Json, string | null>, index: number): Promise<string | null> {
  const written = await job.output(index);

  return written === null ? null : new TextDecoder().decode(written);
}

/** A task's rows: none for a task that never finished, its verdict file's (`verdict`, null for none it can be graded
 *  by) when the config grades by verdict, else one row of its own exit. */
function rowsOf(result: Result<Json, string | null> | undefined, name: string, verdict: VerdictRow[] | null | undefined): VerdictRow[] | null {
  if (result === undefined || result.kind === 'lost' || result.kind === 'cancelled') return null;

  return verdict === undefined ? [{ name, exitCode: result.meta.exitCode, seconds: result.meta.seconds, output: result.meta.tail }] : verdict;
}

/** What `armada run --json` prints when it ends: one object, whose `graded` is what its exit code says. */
interface RunResult {
  readonly sha: string;
  readonly planJob: string | null;
  /** The task job, or the first of a run of more than one environment, which `jobs` names each of. */
  readonly job: string | null;
  readonly jobs?: readonly string[];
  readonly report: string | null;
  readonly graded: 'pass' | 'fail' | 'not graded';
  readonly problems: readonly string[];
  readonly rows: readonly VerdictRow[];
}

const EXITS = { pass: 0, fail: 1, 'not graded': 2 } as const;

/** What a run's report file holds beside its commit: written for every run that knows its commit, graded or not. */
interface Report {
  readonly planJob: string;
  readonly job: string | null;
  readonly graded: RunResult['graded'];
  readonly status: JobStatus | null;
  readonly summary: Summary | null;
  readonly problems: readonly string[];
  readonly rows: readonly VerdictRow[];
  /** Each task's extracted artifacts, by the task's index in the plan. */
  readonly artifacts: Readonly<Record<string, string>>;
  /** Each environment's task job and its status, in a run of more than one (#31); `job` and `status` are the first's. */
  readonly jobs?: readonly { readonly environment: string; readonly job: string; readonly status: JobStatus }[];
}

/** `armada run`: progress as it goes, and with `json` one {@link RunResult} on stdout at the end, the progress then on
 *  stderr. Exits 0 when every row is green, 1 when one is red, and 2 when the run cannot be graded. */
export async function runCI(armada: Armada, target: string, options: RunOptions): Promise<number> {
  const note = (line: string) => { (options.json ? console.error : console.log)(line); };

  const result = await runGraded(armada, target, options, note);

  if (options.json) console.log(JSON.stringify(result));

  return EXITS[result.graded];
}

/** `planArgs` narrow the run: they follow the plan command (a tier, a few files), and the verdict of a narrowed run is
 *  printed and reported but never stored as the commit's. */
async function runGraded(armada: Armada, target: string, { deadline, label, planArgs, secrets }: RunOptions, note: (line: string) => void): Promise<RunResult> {
  const began = Date.now();
  const { sha, repo, config, timings, environment, spec, upload, of } = await commitOf(armada, target);
  const deadlineAt = began + (deadline ?? config.deadline) * 1000;

  note(`${config.name} ${sha}, environment ${environment.key.slice(0, 12)}${environment.base === 'root' ? ' (to prepare)' : ''}`);

  if (config.size === 'auto') {
    note(`size ${spec.recipe.size}${timings.usage === null || timings.usage === undefined ? ', until a run has measured its tasks' : `: the last runs' tasks used at most ${describeUsage(timings.usage)}`}`);
  }

  const uploaded = await upload();

  if (uploaded !== null) note(`uploaded its pack, ${(uploaded / 1e6).toFixed(1)} MB`);
  const placed = (word: string) => word.replaceAll('{target}', String(config.target)).replaceAll('{timings}', `{files}/${TIMINGS_FILE}`);
  const options = { env: spec.env, tmpfs: spec.tmpfs, files: { [TIMINGS_FILE]: JSON.stringify(timings) }, label, armada, slots: config.task.slots, mode: config.task.mode };

  let planId = 'local';
  // The plan's job, when it ran in a container: an ungraded run reports its status.
  let planJob: Job<Json, string> | null = null;
  let printed: string;

  /** Writes the report, named by the task job, or by the plan when no task job started, and says where. */
  const writeReport = (contents: Report): string => {
    const path = join(REPORTS, `${config.name}-${contents.job ?? (planId === 'local' ? `local-${String(began)}` : planId)}.json`);
    const { rows, ...rest } = contents;

    mkdirSync(REPORTS, { recursive: true });
    writeFileSync(path, JSON.stringify({ sha, ...rest, verdicts: { sha, part: 'all', rows } }, null, 2));

    return path;
  };

  /** A run that ended before it had tasks to grade: its plan failed, or printed no plan. */
  const ungraded = async (problem: string): Promise<RunResult> => {
    const report = writeReport({ planJob: planId, job: null, graded: 'not graded', status: planJob === null ? null : await planJob.status(), summary: null, problems: [problem], rows: [], artifacts: {} });

    note(`\nNOT GRADED: ${problem}`);
    note(`report: ${report}`);

    return { sha, planJob: planId, job: null, report, graded: 'not graded', problems: [problem], rows: [] };
  };

  let here: string | undefined;

  try {
    here = config.plan.local ? localPlan({ repo, sha, command: [...config.plan.command, ...planArgs], target: config.target, timings, env: config.env, deadlineAt }) : undefined;
  } catch (cause) {
    return await ungraded(`the plan command failed here: ${errorOf({ cause }).message}`);
  }

  // The plan's own usage, which a container's plan reports and a local one does not.
  const planRun: { readonly meta: Parameters<typeof usageOf>[0][number] }[] = [];

  if (here === undefined) {
    // The plan's stdout is its output; its stderr stays in its log.
    const planDeadline = remainingDeadline(deadlineAt);

    if (planDeadline === null) return await ungraded(PASSED('plan job'));
    const planTask = commandTask(spec.recipe, argvOf(['sh', '-c', '"$@" > "$0"', '{out}', ...config.plan.command.map(placed), ...planArgs], spec.recipe), { output: 'text', timeout: Math.min(900, planDeadline) });
    const remote = planTask.stream([{}], { ...options, deadline: planDeadline, pool: 1 });

    planJob = remote;

    const [planned] = await cancelOnInterrupt([remote], async () => {
      planId = await remote.id;
      note(`plan job ${planId}`);

      return await follow(remote, began, { name: () => 'plan', say: exitWord, note });
    });

    if (planned?.kind !== 'ok') return await ungraded(`the plan command did not print a plan\n${planned === undefined ? (await remote.status()).problems.join('\n') : planned.meta.tail}`);

    printed = planned.value;
    planRun.push(planned);
  } else {
    note(`plan run here, on this checkout of ${sha.slice(0, 12)}`);
    printed = here;
  }

  const printedPlan = v.safeParse(PlanSchema, jsonOf(printed));

  if (!printedPlan.success) return await ungraded(`the plan printed no plan: ${v.summarize(printedPlan.issues)}`);
  const plan = printedPlan.output;
  const names = plan.include.map((entry, index) => taskName(entry, config.task.name, index));
  const nameOf = (index: number) => names[index] ?? String(index);
  const slots = config.task.slots;
  // The environments the plan's entries name: each runs its entries in a task job of its own (#31).
  const named = [...new Set(plan.include.flatMap((entry) => entry.environment === undefined ? [] : [entry.environment]))];
  const unknown = named.filter((name) => !Object.hasOwn(config.environments, name));

  if (unknown.length > 0) return await ungraded(`the plan names ${unknown.join(', ')} as an environment, which .armada.json's environments do not`);

  // Each rank of a gang takes a container at once, so the ranks count toward the lanes the pool carries; a gang that
  // is no whole number counts as one, for the Worker to refuse it by name.
  const ranks = plan.include.map((entry) => {
    const gang = gangOf(entry);

    return Number.isInteger(gang) && gang > 0 ? gang : 1;
  });

  const estimates = plan.include.map((entry, index) => estimateOf(entry, nameOf(index), timings));
  // The project's environment first, then each named one in the plan's order, by their entries' plan indexes.
  const groups = [undefined, ...named].map((name) => ({ name, indexes: plan.include.flatMap((entry, index) => entry.environment === name ? [index] : []) })).filter((group) => group.indexes.length > 0);
  // Its own secrets join the config's only for this run.
  const taskSecrets = [...new Set([...config.task.secrets, ...secrets])];

  // Every named environment resolved and its pack uploaded before any task job starts: one that fails leaves none
  // running.
  const owns = new Map<string | undefined, { readonly environment: typeof environment; readonly spec: OnCommit }>([[undefined, { environment, spec }]]);

  for (const name of named) {
    const own = await of(name);

    note(`environment ${name} ${own.environment.key.slice(0, 12)}${own.environment.base === 'root' ? ' (to prepare)' : ''}`);
    const sent = await own.upload();

    if (sent !== null) note(`uploaded its pack for ${name}, ${(sent / 1e6).toFixed(1)} MB`);
    owns.set(name, own);
  }

  const shares = sharesFor(config.pool, slots, groups.map((group) => ({ estimates: group.indexes.map((index) => estimates[index]), ranks: group.indexes.map((index) => ranks[index] ?? 1) })));

  // Every environment's job runs at once, so none of a run's jobs waits on another's end, deadline or cancel.
  if ('need' in shares) {
    return await ungraded(`the plan's ${String(groups.length)} environments run at once and need ${String(shares.need)} containers for it, one each or their widest gang, past the pool of ${String(config.pool)}: raise pool in .armada.json`);
  }

  // What is left of the run's deadline, read once for every task job, so all of them start or none does.
  const left = remainingDeadline(deadlineAt);

  if (left === null) return await ungraded(PASSED('task jobs'));

  /** Group `at`'s task job, started on `share` containers. Its deadline is what is left of the run's, and bounds its
   *  tasks' timeout. */
  const start = (at: number, share: number) => {
    const group = groups[at] ?? { name: undefined, indexes: [] };
    const own = owns.get(group.name) ?? { environment, spec };
    const groupRanks = group.indexes.map((index) => ranks[index] ?? 1);
    const most = Math.min(share * slots, groupRanks.reduce((sum, each) => sum + each, 0));
    const { lanes, pool } = lanesFor(group.indexes.map((index) => estimates[index]), groupRanks, share, slots);
    const local = argvOf(config.task.command.map(placed), own.spec.recipe);
    // A task's `{index}` is its plan index, as in a run of one environment, not its place in its environment's job.
    const argv = (item: Json, { index }: { readonly index: number }) => local(item, { index: group.indexes[index] ?? index });

    // An entry with no weight of its own dispatches by its estimate.
    const entries = group.indexes.map((index) => {
      const entry = plan.include[index] ?? {};
      const estimate = estimates[index];

      return entry.weight === undefined && estimate !== undefined ? { ...entry, weight: estimate } : entry;
    });

    const taskOptions = { timeout: Math.min(config.task.timeout, left), speculative: config.task.speculative, hedge: config.task.hedge, secrets: taskSecrets };
    const jobOptions = { ...options, deadline: left, pool };
    const job = config.task.verdict ? commandTask(own.spec.recipe, argv, { ...taskOptions, output: 'text' }).stream(entries, jobOptions) : commandTask(own.spec.recipe, argv, taskOptions).stream(entries, jobOptions);

    return { ...group, job, lanes, most, pool, size: entries.length };
  };

  // Each task's rows, by its plan index, read from its verdict file as its result lands, and graded as read: a task
  // that reports many rows exits 0 with red ones among them, so its exit alone would say green. Null for a file missing
  // or malformed.
  const verdicts = new Map<number, VerdictRow[] | null>();
  // Each task's artifacts beside the report, under the task's plan index and name, since two tasks may share a name; a
  // row names one as its evidence.
  const kept = new Map<number, { readonly dir: string; readonly paths: ReadonlySet<string> }>();

  /** A started job followed to its end: its results, by their plan indexes, and its tasks' artifacts kept. */
  const followed = async ({ job, id, indexes }: { readonly job: Job<Json, string | null>; readonly id: string; readonly indexes: readonly number[] }) => {
    const indexOf = (local: number): number => indexes[local] ?? local;

    const say = async (result: Result<Json, string | null>): Promise<string> => {
      if (!config.task.verdict || result.kind === 'lost' || result.kind === 'cancelled') return exitWord(result);
      const index = indexOf(result.index);
      // A task that exited nonzero may still have written its verdict, whose rows its exit then fails.
      const text = result.kind === 'ok' ? result.value : await verdictText(job, result.index);
      const parsed = text === null ? null : v.safeParse(VerdictFileSchema, jsonOf(text));
      // A task that failed before it wrote a verdict reported no row; one that exited 0 without a verdict is ungradable.
      const ungradable = result.meta.exitCode === 0 ? null : [];
      const reported = parsed?.success === true ? parsed.output.rows : ungradable;
      const rows = reported === null ? null : underExit(reported, result.meta, nameOf(index), plan.include[index]?.rows);

      verdicts.set(index, rows);

      if (rows === null) return `${exitWord(result)}, with no verdict it can be graded by`;
      const reds = rows.filter((row) => row.exitCode !== 0).map(rowName);

      return reds.length === 0 ? exitWord(result) : `RED: ${String(reds.length)} of ${String(rows.length)} rows (${reds.slice(0, 3).join(', ')}${reds.length > 3 ? ', …' : ''})`;
    };

    const results = await follow(job, began, { name: (local) => nameOf(indexOf(local)), say, note });

    for (const result of results) {
      if (result.kind === 'lost' || result.kind === 'cancelled' || result.meta.artifacts !== true) continue;
      const archive = await job.artifacts(result.index);

      if (archive === null) continue;
      const index = indexOf(result.index);
      const dir = join(REPORTS, `${config.name}-${id}`, `${String(index)}-${nameOf(index)}`);

      kept.set(index, { dir, paths: new Set(extractTar(archive, dir)) });
    }

    return results.map((result) => ({ ...result, index: indexOf(result.index) }));
  };

  // Every job started, its creation perhaps in flight, for an interrupt to cancel; and those started and followed.
  const started: Job<Json, string | null>[] = [];
  const jobs: { readonly name: string | undefined; readonly id: string; readonly job: Job<Json, string | null>; readonly indexes: readonly number[] }[] = [];

  const tasked = await cancelOnInterrupt(started, async () => {
    const starting = groups.map((_, at) => start(at, shares[at] ?? 1));

    started.push(...starting.map(({ job }) => job));
    const created = await Promise.allSettled(starting.map(async ({ job }) => await job.id));
    const refused = created.find((each) => each.status === 'rejected');

    // A job that did not start leaves the run ungraded, and the others, started with it and not yet followed, end.
    if (refused !== undefined) {
      await cancelEach(started, 'a task job did not start');

      return { refused: errorOf({ cause: refused.reason }).message };
    }

    for (const [place, each] of starting.entries()) {
      const id = created[place]?.status === 'fulfilled' ? created[place].value : '';

      note(`task job ${id}${each.name === undefined ? '' : ` (${each.name})`}: ${String(each.size)} tasks on ${String(each.pool)} containers${slots > 1 ? ` of ${String(slots)} slots` : ''}`
        + `${each.lanes < each.most ? `, which the plan's estimates say finish as soon as ${String(Math.ceil(each.most / slots))} would` : ''}`);
      jobs.push({ ...each, id });
    }

    try {
      return { landed: (await Promise.all(jobs.map(followed))).flat() };
    } catch (cause) {
      // A job that could not be followed to its end leaves the run without an answer: none of its jobs runs on for it.
      await cancelEach(started, 'a task job could not be followed');

      throw cause;
    }
  });

  if ('refused' in tasked) return await ungraded(`a task job did not start, so the run's task jobs were cancelled: ${tasked.refused}`);
  const results = tasked.landed;

  const statuses = await Promise.all(jobs.map(async ({ job }) => await job.status()));
  const [first] = jobs;
  const [status] = statuses;

  if (first === undefined || status === undefined) throw new Error('a graded run has a task job');

  const answers: TaskAnswer[] = plan.include.map((entry, index) => {
    const name = nameOf(index);
    const result = results.find((each) => each.index === index);

    return { name, entry, rows: rowsOf(result, name, config.task.verdict ? verdicts.get(index) ?? null : undefined), artifacts: kept.get(index)?.paths ?? null };
  });

  const graded = grade(answers);
  // `grade` keeps each answer's rows in order, one for one, so each row's evidence is its own task's directory.
  const dirs = answers.flatMap((answer, index) => (answer.rows ?? []).map(() => kept.get(index)?.dir));

  const evidence = new Map(graded.rows.flatMap((row, at) => {
    const dir = dirs[at];

    return dir === undefined ? [] : [[row, dir] as const];
  }));

  const outcome = outcomeOf(graded);
  const file = { sha, part: 'all', rows: graded.rows };
  const summary = together(await Promise.all(jobs.map(async ({ job }) => await job.summary())));
  const problems = statuses.flatMap((each) => each.problems);
  // A run of more than one environment names each job: the report's `job` and `status` are the first's.
  const each = jobs.length === 1 ? undefined : jobs.map(({ name, id }, at) => ({ environment: name ?? '', job: id, status: statuses[at] ?? status }));

  const report = writeReport({
    planJob: planId, job: first.id, graded: outcome, status, summary, problems: graded.problems, rows: graded.rows,
    artifacts: Object.fromEntries([...kept].map(([index, held]) => [String(index), held.dir])), jobs: each,
  });

  const ran = { sha, planJob: planId, job: first.id, jobs: each?.map(({ job }) => job), report, graded: outcome };

  for (const problem of problems) note(`problem: ${problem}`);

  if (graded.problems.length > 0) {
    note(`\nNOT GRADED:\n${graded.problems.map((problem) => `  ${problem}`).join('\n')}`);
    printReds(graded.reds, evidence, note);
    note(`report: ${report}`);

    return { ...ran, problems: [...problems, ...graded.problems], rows: graded.rows };
  }

  const green = graded.rows.filter((row) => row.exitCode === 0 && row.cached === undefined);

  const usage = usageOf([...planRun, ...results].map((result) => result.meta));

  if (planArgs.length === 0) {
    await armada.call(`/verdicts/${config.name}/${sha}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) });
    // The usage of a narrowed run is not the commit's either: it would size the next full run down to a part's needs.
    await armada.post(`/timings/${config.name}`, {
      rows: Object.fromEntries(green.map((row) => [rowName(row), row.seconds])), files: fileTimings(graded.rows), usage,
    });
  } else {
    note(`the plan was narrowed (${planArgs.join(' ')}), so this verdict is not stored as ${sha.slice(0, 12)}'s`);
  }

  printReds(graded.reds, evidence, note);
  note(`\n${graded.reds.length === 0 ? 'PASS' : 'FAIL'}: ${String(graded.rows.length - graded.reds.length)} of ${String(graded.rows.length)} rows green, wall ${clock(Date.now() - began)} (tasks ${clock(summary.mapMs)})`);
  note(describeBoots(summary));

  if (usage !== null) note(`one task used at most ${describeUsage(usage)} on size ${spec.recipe.size}`);
  note(`report: ${report}`);

  return { ...ran, problems, rows: graded.rows };
}
