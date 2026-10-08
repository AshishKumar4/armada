/**
 * `armada run <commit|worktree>`: a project's CI as two maps. The commit's `.armada.json` names the recipe; the
 * commit is packed into R2 (its history from the root the first time its environment is prepared, otherwise only what
 * it adds). One task runs the project's plan command, which prints the tasks; a second job maps the task command over
 * them, longest first, on a pool of containers that each pull task after task. Every task's verdict file is graded
 * (`grade.ts`), every red row printed with its output's tail, and the collected verdict and the green rows' timings
 * stored on the runner. Exits 0 when every planned row ran once and passed, 1 when one was red, 2 when not graded.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { checkoutOf, CONFIG_FILE, matches, parseConfig, type Config } from './config';
import { grade, PlanSchema, rowName, taskName, underExit, VerdictFileSchema, type PlanEntry, type TaskAnswer, type VerdictRow } from './grade';
import { describeUsage, FILES_DIR, fill, fitSize, itemValues, jsonOf, OUT_PATH, PACKER, TimingsSchema, usageOf, workdirOf, type Manifest, type Size, type Timings } from './protocol';
import type { Armada } from './sdk';
import { commandTask, type Job, type Json, type Recipe, type Result } from './task';

const REPORTS = join(homedir(), '.local', 'state', 'armada', 'runs');

/** Lines of a red row's output printed; the whole of it is in the report. */
const TAIL_LINES = 60;

const TIMINGS_FILE = 'timings.json';

function git(cwd: string, args: readonly string[], stdin?: Uint8Array): Buffer {
  const ran = Bun.spawnSync(['git', ...args], { cwd, stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString().trim()}`);

  return ran.stdout;
}

interface Commit {
  readonly sha: string;
  /** A repository holding it, to read and pack it from. */
  readonly repo: string;
}

/** The commit a target names; a worktree must be committed, since the commit is what is proved. */
function resolveCommit(target: string): Commit {
  if (existsSync(target) && statSync(target).isDirectory()) {
    const dirty = git(target, ['status', '--porcelain']).toString().trim();

    if (dirty !== '') throw new Error(`${target} has uncommitted changes; armada proves a commit, so commit them first:\n${dirty}`);

    return { sha: git(target, ['rev-parse', 'HEAD']).toString().trim(), repo: target };
  }

  return { sha: git(process.cwd(), ['rev-parse', '--verify', `${target}^{commit}`]).toString().trim(), repo: process.cwd() };
}

/** The plan's stdout, run in `repo` where its checkout is `sha` and clean, with `{target}` and `{timings}` filled here;
 *  undefined where it is not that commit, and the plan runs in a container. A container's start, cold on a new machine,
 *  was 61 of the 70 seconds Dew's plan took. */
export function localPlan(repo: string, sha: string, command: readonly string[], target: number, timings: Timings,
  env: Readonly<Record<string, string>>): string | undefined {
  if (git(repo, ['rev-parse', 'HEAD']).toString().trim() !== sha || git(repo, ['status', '--porcelain']).toString().trim() !== '') return undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'armada-plan-'));

  try {
    writeFileSync(join(scratch, TIMINGS_FILE), JSON.stringify(timings));
    const argv = command.map((word) => word.replaceAll('{target}', String(target)).replaceAll('{timings}', join(scratch, TIMINGS_FILE)));
    const filled = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value.replaceAll('{workdir}', repo)]));
    const ran = Bun.spawnSync(argv, { cwd: repo, env: { ...process.env, ...filled }, stdout: 'pipe', stderr: 'pipe' });

    if (ran.exitCode !== 0) throw new Error(`the plan exited ${String(ran.exitCode)}: ${ran.stderr.toString().slice(-2000)}`);

    return ran.stdout.toString();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The commit's paths that key its environment: the `key` globs and the two recipe scripts. */
function manifestOf(repo: string, sha: string, config: Config): Manifest {
  const globs = [...config.environment.key, config.environment.setup ?? '', config.environment.install ?? ''].filter((glob) => glob !== '');

  return git(repo, ['ls-tree', '-r', '--full-tree', sha]).toString().split('\n').flatMap((line) => {
    const [meta = '', path = ''] = line.split('\t');
    const id = meta.split(' ')[2] ?? '';

    return path !== '' && globs.some((glob) => matches(glob, path)) ? [{ path, id }] : [];
  });
}

/** The recipe the commit names, its scripts read from the commit as text. */
function recipeOf(repo: string, sha: string, config: Config, size: Size): Omit<Recipe, 'commit'> {
  const text = (path: string | undefined) => path === undefined ? '' : git(repo, ['show', `${sha}:${path}`]).toString();

  return {
    base: config.environment.base, setup: text(config.environment.setup), install: text(config.environment.install),
    size, repo: { project: config.name, checkout: checkoutOf(config), history: config.history, manifest: manifestOf(repo, sha, config) },
  };
}

/** What the commit is packed against: the environment's commit, where this repository has it. A shallow clone (a CI
 *  runner's checkout) does not, and a pack from the root carries the whole commit. */
export function packBase(repo: string, environment: string): string {
  return environment !== 'root' && Bun.spawnSync(['git', 'cat-file', '-e', `${environment}^{commit}`], { cwd: repo }).exitCode === 0 ? environment : 'root';
}

/** The commit from the root (with its history, or alone), or what it adds to the environment's commit. A `commit`
 *  checkout holds the environment commit's tree and nothing of its history, so the pack is every object of the
 *  commit's tree that tree lacks: `--not <base>` would also leave out what the commit shares with an ancestor of the
 *  base, which the checkout never received. */
export function packOf(repo: string, sha: string, base: string, history: Config['history']): Blob {
  const listed = (...args: string[]) => git(repo, ['rev-list', '--objects', ...args]).toString().split('\n').filter((line) => line !== '');
  const id = (line: string) => line.split(' ')[0] ?? '';
  const held = new Set(history === 'commit' && base !== 'root' ? listed('--no-walk', base).map(id) : []);
  const objects = history === 'commit' ? listed('--no-walk', sha).filter((line) => !held.has(id(line))) : listed(sha, ...base === 'root' ? [] : ['--not', base]);

  return new Blob([new Uint8Array(git(repo, ['-c', 'pack.threads=4', 'pack-objects', '--stdout', '-q'], new TextEncoder().encode(objects.map((line) => `${line}\n`).join(''))))]);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const clock = (ms: number): string => `${String(Math.floor(ms / 60_000))}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** `body`, while it follows job `id`: interrupting the CLI (Ctrl-C, or a CI job cancelled) cancels the job, rather than
 *  leaving its containers to run for an answer nobody reads, and exits 2. */
export async function cancelOnInterrupt<T>(job: { cancel(): Promise<void> }, id: string, body: () => Promise<T>): Promise<T> {
  // Once interrupted, the cancel's end is the CLI's: a job that finishes meanwhile does not answer for it.
  let cancelling: Promise<never> | null = null;
  const interrupted = (signal: NodeJS.Signals): void => {
    console.error(`armada: ${signal}: cancelling job ${id}`);
    cancelling ??= job.cancel().then(() => process.exit(2), (cause: unknown) => {
      console.error(`armada: cancelling job ${id} failed: ${String(cause)}`);
      process.exit(2);
    });
  };

  process.once('SIGINT', interrupted).once('SIGTERM', interrupted);

  try {
    const result = await body();

    return cancelling === null ? result : await cancelling;
  } finally {
    process.off('SIGINT', interrupted).off('SIGTERM', interrupted);
  }
}

/** A result's word by its exit: green, RED with the exit code, or FAILED with why it never finished. */
function exitWord(result: Result<Json, string | null>): string {
  return result.kind === 'lost' || result.kind === 'cancelled' ? `FAILED: ${result.reason.slice(-300)}` : result.kind === 'ok' ? 'green' : `RED (exit ${String(result.meta.exitCode)})`;
}

/** A command template's argv for one item: `{item}`, an object item's scalar keys, `{index}`, `{out}`, `{files}`,
 *  `{workdir}` and `{commit}` filled; any other placeholder is an error, never an empty string. */
export function argvOf(template: readonly string[], recipe: Recipe): (item: Json, at: { readonly index: number }) => string[] {
  const fixed = { out: OUT_PATH, files: FILES_DIR, workdir: workdirOf(recipe), commit: recipe.commit?.sha ?? '' };

  return (item, { index }) => template.map((word) => fill(word, { ...itemValues(item, index), ...fixed }));
}

/** Follows a job to its end, saying each phase once and each outcome as it lands, in the words `say` finds for it. */
async function follow<O extends string | null>(job: Job<Json, O>, began: number, name: (index: number) => string, say: (result: Result<Json, O>) => Promise<string> | string = exitWord): Promise<Result<Json, O>[]> {
  const results: Result<Json, O>[] = [];
  const id = await job.id;
  let phase = '';
  const watcher = setInterval(() => {
    void job.status().then((status) => {
      if (status.phase === phase) return;
      phase = status.phase;
      print(`${clock(Date.now() - began).padStart(6)}  ${phase === 'preparing' ? `preparing environment ${status.key.slice(0, 12)}` : phase}`);
    }, () => undefined);
  }, 3_000);

  try {
    return await cancelOnInterrupt(job, id, async () => {
      for await (const result of job) {
        results.push(result);
        print(`${clock(Date.now() - began).padStart(6)}  ${name(result.index).padEnd(14)} ${await say(result)} in ${clock(result.meta.seconds * 1000)} on ${result.meta.container}`);
      }

      return results;
    });
  } finally {
    clearInterval(watcher);
  }
}

function printReds(reds: readonly VerdictRow[]): void {
  for (const row of reds) {
    print(`\nRED  ${rowName(row)}  (exit ${String(row.exitCode)}, ${seconds(row.seconds * 1000)})`);
    print(row.output.split('\n').slice(-TAIL_LINES).map((line) => `  | ${line}`).join('\n'));
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
    printReds(reds);
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

/** A commit and its `.armada.json`: its environment, its job fields, and the upload of its pack, which sends nothing
 *  when the runner has it. */
async function commitOf(armada: Armada, target: string) {
  const { sha, repo } = resolveCommit(target);
  const config = parseConfig(git(repo, ['show', `${sha}:${CONFIG_FILE}`]).toString());
  const timings = v.parse(TimingsSchema, await (await armada.call(`/timings/${config.name}`)).json());
  const size = config.size !== 'auto' ? config.size : timings.usage === null || timings.usage === undefined ? 'medium' : fitSize(timings.usage);
  const recipe = recipeOf(repo, sha, config, size);
  const environment = await armada.resolve(recipe);
  const base = packBase(repo, environment.base);
  const spec: OnCommit = { recipe: { ...recipe, commit: { sha, base, packer: PACKER } }, env: config.env, tmpfs: config.tmpfs };

  return { sha, repo, config, timings, environment, spec, upload: async () => await armada.uploadPack(config.name, sha, base, () => packOf(repo, sha, base, config.history)) };
}

/** A commit's job fields, its pack uploaded. */
export async function onCommit(armada: Armada, target: string): Promise<OnCommit> {
  const commit = await commitOf(armada, target);

  await commit.upload();

  return commit.spec;
}

/** A task's seconds: its plan entry's `weight`, else the last runs' medians of the rows it names, or of the task. */
function estimateOf(entry: PlanEntry, name: string, timings: Timings): number | undefined {
  const rows = entry.rows?.map((row) => timings.rows[typeof row === 'string' ? row : row.name]) ?? [timings.rows[name]];

  return entry.weight ?? (rows.every((seconds) => seconds !== undefined) ? rows.reduce((sum, seconds) => sum + seconds, 0) : undefined);
}

/** The fewest containers, up to `most`, that finish these tasks as soon as `most` would, queued longest first: every
 *  container that runs more than one task must finish a fifth of the longest task's time before it does. */
export function poolFor(estimates: readonly number[], most: number): number {
  const longest = Math.max(0, ...estimates);
  const queue = [...estimates].sort((left, right) => right - left);

  for (let pool = 1; pool < most; pool += 1) {
    const loads = Array.from({ length: pool }, () => ({ seconds: 0, tasks: 0 }));

    for (const seconds of queue) {
      const next = loads.reduce((least, load) => load.seconds < least.seconds ? load : least);

      next.seconds += seconds;
      next.tasks += 1;
    }

    if (loads.every((load) => load.tasks === 1 || load.seconds <= longest * 0.8)) return pool;
  }

  return most;
}

/** `planArgs` narrow the run: they follow the plan command (a tier, a few files), and the verdict of a narrowed run is
 *  printed and reported but never stored as the commit's. */
/** Where `armada run` prints its progress: stdout, or stderr when `--json` keeps stdout for its one result. */
let print = (line: string): void => {
  console.log(line);
};

/** What `armada run --json` prints when it ends: one object, whose `graded` is what its exit code says. */
interface RunResult {
  readonly sha: string;
  readonly planJob: string | null;
  readonly job: string | null;
  readonly report: string | null;
  readonly graded: 'pass' | 'fail' | 'not graded';
  readonly problems: readonly string[];
  readonly rows: readonly VerdictRow[];
}

/** `armada run`: progress as it goes, and with `json` one {@link RunResult} on stdout at the end. Exits 0 when every
 *  row is green, 1 when one is red, and 2 when the run cannot be graded. */
export async function runCI(armada: Armada, target: string, label: string, planArgs: readonly string[] = [], secrets: readonly string[] = [], json = false): Promise<number> {
  if (json) print = (line) => { console.error(line); };
  const result = await runGraded(armada, target, label, planArgs, secrets);

  if (json) console.log(JSON.stringify(result));

  return result.graded === 'pass' ? 0 : result.graded === 'fail' ? 1 : 2;
}

async function runGraded(armada: Armada, target: string, label: string, planArgs: readonly string[], secrets: readonly string[]): Promise<RunResult> {
  const began = Date.now();
  const { sha, repo, config, timings, environment, spec, upload } = await commitOf(armada, target);

  print(`${config.name} ${sha}, environment ${environment.key.slice(0, 12)}${environment.base === 'root' ? ' (to prepare)' : ''}`);

  if (config.size === 'auto') {
    print(`size ${spec.recipe.size}${timings.usage === null || timings.usage === undefined ? ', until a run has measured its tasks' : `: the last runs' tasks used at most ${describeUsage(timings.usage)}`}`);
  }
  const uploaded = await upload();

  if (uploaded !== null) print(`uploaded its pack, ${(uploaded / 1e6).toFixed(1)} MB`);
  const placed = (word: string) => word.replaceAll('{target}', String(config.target)).replaceAll('{timings}', `{files}/${TIMINGS_FILE}`);
  const options = { env: spec.env, tmpfs: spec.tmpfs, files: { [TIMINGS_FILE]: JSON.stringify(timings) }, label, armada };
  const here = config.plan.local ? localPlan(repo, sha, [...config.plan.command, ...planArgs], config.target, timings, config.env) : undefined;
  let planId = 'local';
  let printed: string;
  // The plan's own usage, which a container's plan reports and a local one does not.
  const planRun: { readonly meta: Parameters<typeof usageOf>[0][number] }[] = [];

  if (here === undefined) {
    // The plan's stdout is its output; its stderr stays in its log.
    const planTask = commandTask(spec.recipe, argvOf(['sh', '-c', '"$@" > "$0"', '{out}', ...config.plan.command.map(placed), ...planArgs], spec.recipe), { output: 'text', timeout: 900 });
    const planJob = planTask.stream([{}], { ...options, pool: 1 });

    planId = await planJob.id;
    print(`plan job ${planId}`);
    const [planned] = await follow(planJob, began, () => 'plan');

    if (planned?.kind !== 'ok') {
      const problem = `the plan command did not print a plan\n${planned === undefined ? (await planJob.status()).problems.join('\n') : planned.meta.tail}`;

      print(`\nNOT GRADED: ${problem}`);

      return { sha, planJob: planId, job: null, report: null, graded: 'not graded', problems: [problem], rows: [] };
    }
    printed = planned.value;
    planRun.push(planned);
  } else {
    print(`plan run here, on this checkout of ${sha.slice(0, 12)}`);
    printed = here;
  }

  const plan = v.parse(PlanSchema, JSON.parse(printed));
  const names = plan.include.map((entry, index) => taskName(entry, config.task.name, index));
  const most = Math.min(config.pool, plan.include.length);
  const estimates = plan.include.map((entry, index) => estimateOf(entry, names[index] ?? '', timings));
  const pool = estimates.every((seconds) => seconds !== undefined) ? poolFor(estimates, most) : most;
  // This run's own secrets beside the config's: a deploy's narrowed run passes what its rows read, and the config's
  // whole tier never sees them.
  const taskOptions = { timeout: config.task.timeout, speculative: config.task.speculative, secrets: [...new Set([...config.task.secrets, ...secrets])] };
  const argv = argvOf(config.task.command.map(placed), spec.recipe);
  // A matrix entry came from JSON, so it is JSON.
  const entries = plan.include as Json[];
  const job = config.task.verdict ? commandTask(spec.recipe, argv, { ...taskOptions, output: 'text' }).stream(entries, { ...options, pool }) : commandTask(spec.recipe, argv, taskOptions).stream(entries, { ...options, pool });
  const jobId = await job.id;

  print(`task job ${jobId}: ${String(plan.include.length)} tasks on ${String(pool)} containers${pool < most ? `, which the plan's estimates say finish as soon as ${String(most)} would` : ''}`);
  const nameOf = (index: number) => names[index] ?? String(index);
  // Each task's rows, read from its verdict file as its result lands, and graded as read: a task that reports many rows
  // exits 0 with red ones among them, so its exit alone would say green. Null for a file missing or malformed.
  const verdicts = new Map<number, VerdictRow[] | null>();
  const say = async (result: Result<Json, string | null>): Promise<string> => {
    if (!config.task.verdict || result.kind === 'lost' || result.kind === 'cancelled') return exitWord(result);
    // A task that exited nonzero may still have written its verdict, whose rows its exit then fails.
    const written = result.kind === 'ok' ? null : await job.output(result.index);
    const text = result.kind === 'ok' ? result.value : written === null ? null : new TextDecoder().decode(written);
    const parsed = text === null ? null : v.safeParse(VerdictFileSchema, jsonOf(text));
    const rows = parsed?.success === true ? underExit(parsed.output.rows, result.meta, nameOf(result.index)) : null;

    verdicts.set(result.index, rows);

    if (rows === null) return `${exitWord(result)}, with no verdict it can be graded by`;
    const reds = rows.filter((row) => row.exitCode !== 0).map(rowName);

    return reds.length === 0 ? exitWord(result) : `RED: ${String(reds.length)} of ${String(rows.length)} rows (${reds.slice(0, 3).join(', ')}${reds.length > 3 ? ', …' : ''})`;
  };
  const results = await follow(job, began, nameOf, say);
  const status = await job.status();
  const answers: TaskAnswer[] = plan.include.map((entry, index) => {
    const name = nameOf(index);
    const result = results.find((each) => each.index === index);

    if (result === undefined || result.kind === 'lost' || result.kind === 'cancelled') return { name, entry, rows: null };

    if (!config.task.verdict) return { name, entry, rows: [{ name, exitCode: result.meta.exitCode, seconds: result.meta.seconds, output: result.meta.tail }] };

    return { name, entry, rows: verdicts.get(index) ?? null };
  });
  const graded = grade(answers);
  const file = { sha, part: 'all', rows: graded.rows };
  const report = join(REPORTS, `${config.name}-${jobId}.json`);
  const summary = await job.summary();

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(report, JSON.stringify({ sha, planJob: planId, job: jobId, status, summary, problems: graded.problems, verdicts: file }, null, 2));

  for (const problem of status.problems) print(`problem: ${problem}`);

  if (graded.problems.length > 0) {
    print(`\nNOT GRADED:\n${graded.problems.map((problem) => `  ${problem}`).join('\n')}`);
    printReds(graded.reds);
    print(`report: ${report}`);

    return { sha, planJob: planId, job: jobId, report, graded: 'not graded', problems: graded.problems, rows: graded.rows };
  }

  if (planArgs.length === 0) await armada.call(`/verdicts/${config.name}/${sha}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) });
  else print(`the plan was narrowed (${planArgs.join(' ')}), so this verdict is not stored as ${sha.slice(0, 12)}'s`);
  const green = graded.rows.filter((row) => row.exitCode === 0 && row.cached === undefined);

  const usage = usageOf([...planRun, ...results].map((result) => result.meta));

  await armada.post(`/timings/${config.name}`, {
    rows: Object.fromEntries(green.map((row) => [rowName(row), row.seconds])), files: Object.assign({}, ...green.map((row) => row.timings ?? {})), usage,
  });
  printReds(graded.reds);
  const boots = summary.bootMs;

  print(`\n${graded.reds.length === 0 ? 'PASS' : 'FAIL'}: ${String(graded.rows.length - graded.reds.length)} of ${String(graded.rows.length)} rows green, wall ${clock(Date.now() - began)} (tasks ${clock(summary.mapMs)})`);
  print(`${String(summary.vessels)} containers; first answers ${seconds(boots[0] ?? 0)} to ${seconds(boots.at(-1) ?? 0)} (median ${seconds(boots[Math.floor(boots.length / 2)] ?? 0)})`);

  if (usage !== null) print(`one task used at most ${describeUsage(usage)} on size ${spec.recipe.size}`);
  print(`report: ${report}`);

  return { sha, planJob: planId, job: jobId, report, graded: graded.reds.length === 0 ? 'pass' : 'fail', problems: [], rows: graded.rows };
}
