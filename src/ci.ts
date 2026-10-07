/**
 * `armada run <commit|worktree>`: a project's CI as two maps. The commit's `.armada.json` names the recipe; the
 * commit is packed into R2 (its history from the root the first time its environment is prepared, otherwise only what
 * it adds). One task runs the project's plan command, which prints the tasks; a second job maps the task command over
 * them, longest first, on a pool of containers that each pull task after task. Every task's verdict file is graded
 * (`grade.ts`), every red row printed with its output's tail, and the collected verdict and the green rows' timings
 * stored on the runner. Exits 0 when every planned row ran once and passed, 1 when one was red, 2 when not graded.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { checkoutOf, CONFIG_FILE, matches, parseConfig, type Config } from './config';
import { grade, PlanSchema, rowName, taskName, underExit, VerdictFileSchema, type TaskAnswer, type VerdictRow } from './grade';
import { PACKER, TimingsSchema, type JobSpec, type Manifest, type Outcome, type Recipe } from './protocol';
import type { Armada, Job } from './sdk';

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
export function resolveCommit(target: string): Commit {
  if (existsSync(target) && statSync(target).isDirectory()) {
    const dirty = git(target, ['status', '--porcelain']).toString().trim();

    if (dirty !== '') throw new Error(`${target} has uncommitted changes; armada proves a commit, so commit them first:\n${dirty}`);

    return { sha: git(target, ['rev-parse', 'HEAD']).toString().trim(), repo: target };
  }

  return { sha: git(process.cwd(), ['rev-parse', '--verify', `${target}^{commit}`]).toString().trim(), repo: process.cwd() };
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
function recipeOf(repo: string, sha: string, config: Config): Recipe {
  const text = (path: string | undefined) => path === undefined ? '' : git(repo, ['show', `${sha}:${path}`]).toString();

  return {
    base: config.environment.base, setup: text(config.environment.setup), install: text(config.environment.install), smoke: config.environment.smoke,
    instance: config.instance, repo: { project: config.name, checkout: checkoutOf(config), history: config.history, manifest: manifestOf(repo, sha, config) },
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

/** `body`, while it follows `job`: interrupting the CLI (Ctrl-C, or a CI job cancelled) cancels the job, rather than
 *  leaving its containers to run for an answer nobody reads, and exits 2. */
export async function cancelOnInterrupt<T>(job: Job, body: () => Promise<T>): Promise<T> {
  // Once interrupted, the cancel's end is the CLI's: a job that finishes meanwhile does not answer for it.
  let cancelling: Promise<never> | null = null;
  const interrupted = (signal: NodeJS.Signals): void => {
    console.error(`armada: ${signal}: cancelling job ${job.id}`);
    cancelling ??= job.cancel().then(() => process.exit(2), (cause: unknown) => {
      console.error(`armada: cancelling job ${job.id} failed: ${String(cause)}`);
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

/** A task's verdict file as JSON, or null when it is not: the grader names it, and the job runs on. */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An outcome's word by its exit: green, RED with the exit code, or FAILED with what the infrastructure said. */
function exitWord(outcome: Outcome): string {
  return outcome.kind === 'failed' ? `FAILED: ${outcome.tail.slice(-300)}` : outcome.exitCode === 0 ? 'green' : `RED (exit ${String(outcome.exitCode)})`;
}

/** Follows a job to its end, saying each phase once and each outcome as it lands, in the words `say` finds for it. */
async function follow(job: Job, began: number, name: (outcome: Outcome) => string, say: (outcome: Outcome) => Promise<string> = async (outcome) => exitWord(outcome)): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  let phase = '';
  const watcher = setInterval(() => {
    void job.status().then((status) => {
      if (status.phase === phase) return;
      phase = status.phase;
      console.log(`${clock(Date.now() - began).padStart(6)}  ${phase === 'preparing' ? `preparing environment ${status.key.slice(0, 12)}` : phase}`);
    }, () => undefined);
  }, 3_000);

  try {
    return await cancelOnInterrupt(job, async () => {
      for await (const outcome of job.outcomes()) {
        outcomes.push(outcome);
        const verdict = await say(outcome);

        console.log(`${clock(Date.now() - began).padStart(6)}  ${name(outcome).padEnd(14)} ${verdict} in ${clock(outcome.seconds * 1000)} on ${outcome.vessel}`);
      }

      return outcomes;
    });
  } finally {
    clearInterval(watcher);
  }
}

function printReds(reds: readonly VerdictRow[]): void {
  for (const row of reds) {
    console.log(`\nRED  ${rowName(row)}  (exit ${String(row.exitCode)}, ${seconds(row.seconds * 1000)})`);
    console.log(row.output.split('\n').slice(-TAIL_LINES).map((line) => `  | ${line}`).join('\n'));
  }
}

/** The job fields that run a command on a commit in the environment its `.armada.json` names, its pack uploaded. */
export async function onCommit(armada: Armada, target: string): Promise<Pick<JobSpec, 'recipe' | 'commit' | 'env' | 'tmpfs'>> {
  const { sha, repo } = resolveCommit(target);
  const config = parseConfig(git(repo, ['show', `${sha}:${CONFIG_FILE}`]).toString());
  const recipe = recipeOf(repo, sha, config);
  const base = packBase(repo, (await armada.resolve(recipe)).base);

  await armada.uploadPack(config.name, sha, base, () => packOf(repo, sha, base, config.history));

  return { recipe, commit: { sha, base, packer: PACKER }, env: config.env, tmpfs: config.tmpfs };
}

/** `planArgs` narrow the run: they follow the plan command (a tier, a few files), and the verdict of a narrowed run is
 *  printed and reported but never stored as the commit's. */
export async function runCI(armada: Armada, target: string, label: string, planArgs: readonly string[] = []): Promise<number> {
  const began = Date.now();
  const { sha, repo } = resolveCommit(target);
  const config = parseConfig(git(repo, ['show', `${sha}:${CONFIG_FILE}`]).toString());
  const recipe = recipeOf(repo, sha, config);
  const environment = await armada.resolve(recipe);
  const base = packBase(repo, environment.base);

  console.log(`${config.name} ${sha}, environment ${environment.key.slice(0, 12)}${environment.base === 'root' ? ' (to prepare)' : ''}`);
  const uploaded = await armada.uploadPack(config.name, sha, base, () => packOf(repo, sha, base, config.history));

  if (uploaded !== null) console.log(`uploaded its pack, ${(uploaded / 1e6).toFixed(1)} MB`);
  const timings = v.parse(TimingsSchema, await (await armada.call(`/timings/${config.name}`)).json());
  const placed = (word: string) => word.replaceAll('{target}', String(config.target)).replaceAll('{timings}', `{files}/${TIMINGS_FILE}`);
  const common = { recipe, commit: { sha, base, packer: PACKER }, env: config.env, tmpfs: config.tmpfs, files: { [TIMINGS_FILE]: JSON.stringify(timings) }, label };
  // The plan's stdout is its output; its stderr stays in its log.
  const planJob = await armada.map({ ...common, items: [{}], run: { command: ['sh', '-c', '"$@" > "$0"', '{out}', ...config.plan.command.map(placed), ...planArgs] }, output: true, pool: 1, timeout: 900 });

  console.log(`plan job ${planJob.id}`);
  const planned = await follow(planJob, began, () => 'plan');
  const planText = await planJob.output(0);

  if (planned[0]?.kind !== 'exited' || planned[0].exitCode !== 0 || planText === null) {
    console.log(`\nNOT GRADED: the plan command did not print a plan\n${planned[0]?.tail ?? (await planJob.status()).problems.join('\n')}`);

    return 2;
  }

  const plan = v.parse(PlanSchema, JSON.parse(planText));
  const names = plan.include.map((entry, index) => taskName(entry, config.task.name, index));
  const job = await armada.map({
    ...common, items: plan.include, run: { command: config.task.command.map(placed) }, output: config.task.verdict,
    pool: config.pool, idempotent: config.task.idempotent, timeout: config.task.timeout,
  });

  console.log(`task job ${job.id}: ${String(plan.include.length)} tasks on up to ${String(config.pool)} containers`);
  const nameOf = (index: number) => names[index] ?? String(index);
  // Each task's rows, read from its verdict file as its outcome lands, and graded as read: a task that reports many rows
  // exits 0 with red ones among them, so its exit alone would say green. Null for a file missing or malformed.
  const verdicts = new Map<number, VerdictRow[] | null>();
  const say = async (outcome: Outcome): Promise<string> => {
    if (!config.task.verdict || outcome.kind !== 'exited') return exitWord(outcome);
    const text = await job.output(outcome.index);
    const parsed = text === null ? null : v.safeParse(VerdictFileSchema, jsonOf(text));
    const rows = parsed?.success === true ? underExit(parsed.output.rows, outcome, nameOf(outcome.index)) : null;

    verdicts.set(outcome.index, rows);

    if (rows === null) return `${exitWord(outcome)}, with no verdict it can be graded by`;
    const reds = rows.filter((row) => row.exitCode !== 0).map(rowName);

    return reds.length === 0 ? exitWord(outcome) : `RED: ${String(reds.length)} of ${String(rows.length)} rows (${reds.slice(0, 3).join(', ')}${reds.length > 3 ? ', …' : ''})`;
  };
  const outcomes = await follow(job, began, (outcome) => nameOf(outcome.index), say);
  const status = await job.status();
  const answers: TaskAnswer[] = plan.include.map((entry, index) => {
    const name = nameOf(index);
    const outcome = outcomes.find((each) => each.index === index);

    if (outcome === undefined || outcome.kind === 'failed') return { name, entry, rows: null };

    if (!config.task.verdict) return { name, entry, rows: [{ name, exitCode: outcome.exitCode, seconds: outcome.seconds, output: outcome.tail }] };

    return { name, entry, rows: verdicts.get(index) ?? null };
  });
  const graded = grade(answers);
  const file = { sha, part: 'all', rows: graded.rows };
  const report = join(REPORTS, `${config.name}-${job.id}.json`);
  const summary = await job.summary();

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(report, JSON.stringify({ sha, planJob: planJob.id, job: job.id, status, summary, problems: graded.problems, verdicts: file }, null, 2));

  for (const problem of status.problems) console.log(`problem: ${problem}`);

  if (graded.problems.length > 0) {
    console.log(`\nNOT GRADED:\n${graded.problems.map((problem) => `  ${problem}`).join('\n')}`);
    printReds(graded.reds);

    return 2;
  }

  if (planArgs.length === 0) await armada.call(`/verdicts/${config.name}/${sha}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) });
  else console.log(`the plan was narrowed (${planArgs.join(' ')}), so this verdict is not stored as ${sha.slice(0, 12)}'s`);
  const green = graded.rows.filter((row) => row.exitCode === 0 && row.cached === undefined);

  await armada.post(`/timings/${config.name}`, { rows: Object.fromEntries(green.map((row) => [rowName(row), row.seconds])), files: Object.assign({}, ...green.map((row) => row.timings ?? {})) });
  printReds(graded.reds);
  const boots = summary.bootMs;

  console.log(`\n${graded.reds.length === 0 ? 'PASS' : 'FAIL'}: ${String(graded.rows.length - graded.reds.length)} of ${String(graded.rows.length)} rows green, wall ${clock(Date.now() - began)} (tasks ${clock(summary.mapMs)})`);
  console.log(`${String(summary.vessels)} containers; first answers ${seconds(boots[0] ?? 0)} to ${seconds(boots.at(-1) ?? 0)} (median ${seconds(boots[Math.floor(boots.length / 2)] ?? 0)})`);
  console.log(`report: ${report}`);

  return graded.reds.length === 0 ? 0 : 1;
}
