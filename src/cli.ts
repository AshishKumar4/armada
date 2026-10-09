#!/usr/bin/env bun
/** The armada CLI; `armada --help` prints its usage. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { argvOf, cancelOnInterrupt, extractTar, onCommit, runCI, verdictCI } from './ci';
import { buildDashboard, dashboardUrl, openInBrowser, serveDashboard } from './dashboard';
import { registryCredentials } from './registry';
import { findProject, push } from './push';
import { Armada, CONFIG_DIR, connect, connectionFile, ConnectionSchema } from './sdk';
import { BaseSchema, describeUsage, errorOf, jsonOf, JsonSchema, KEPT_ENVIRONMENTS, mustDrain, SizeSchema, usageOf, WebhooksSchema, type Health, type Push } from './protocol';
import { commandTask, recipe, type Json, type Meta } from './task';

const ROOT = join(import.meta.dir, '..');

const USAGE = `armada runs a command over many inputs at once, on Cloudflare Containers.

Usage:
  armada deploy [--account=<id>] [--name=<name>] [--vcpus=N] [--drain] [--keep=N]
                                       deploy armada to your Cloudflare account, logging in if needed
  armada map [options] -- <command>    run the command once per item
  armada run <commit|worktree> [--label=<text>] [--secrets=<A,B>] [--json] [-- <plan args>]
                                       run a project's CI from the commit's .armada.json; --json prints the
                                       progress to stderr and one JSON verdict object to stdout
  armada verdict <commit|worktree> [--json]
                                       print the verdict armada run stored for the commit
  armada push                          send this project's tasks (armada.config.ts) to armada
  armada dev                           push them again on every save
  armada status <job-id>               print a job's status as JSON
  armada dashboard [--serve=<port>]    open the deployment's dashboard in your browser, signed in;
                                       --serve serves it from this machine instead
  armada secret set <NAME>             set a secret from stdin, for the tasks that name it
  armada secret list | delete <NAME>   list the secrets' names, or delete one
  armada webhook add <project> --repo=<owner/name> [--branches=a,b] [--pull-requests] [--token-secret=NAME]
                                       run pushes and pull requests through the deployment's own armada run
  armada webhook list                  list the configured projects
  armada webhook remove <project>      remove one, and its GitHub hook when the CLI made it
  armada prune [--keep=N]              delete now the snapshots past the N most recently used environments
                                       (default the deployment's own); an open job's environment stays

map options:
  --times=N            the items are 1 to N
  --items=<file|->     a JSON array, or one item per line
  --env=<recipe.json>  {"base", "setup", "install", "size"}, scripts relative to it
  --commit=<rev>       run in the commit's checkout, in the environment its .armada.json names
  --size=<size>        each container's size: micro, mini, small or medium (default medium)
  --pool=N             the most containers at once (default 50)
  --slots=N            the tasks one container runs at once, each in its own slot (default 1)
  --timeout=S          a task's limit, in seconds (default 3600)
  --output             keep each task's {out} file
  --artifacts=<dir>    extract each task's {artifacts} directory under <dir>/<index>
  --speculative        let an idle container run a straggler again
  --hedge=N            run the N heaviest items twice from the start, first answer kept
  --secrets=<A,B>      give each task these secrets (armada secret set) in its environment
  --json               print each outcome as a JSON line
  --label=<text>       name the job

deploy options:
  --account=<id>       the account to use, if your login has more than one
  --name=<name>        a separate armada with its own Worker, <name>-artifacts bucket, fleet
                       and connection file, ~/.config/armada/<name>.json (default armada)
  --vcpus=N            the most vCPUs its fleet runs at once (default 1500)
  --drain              wait for the open jobs first; automatic when this Worker would refuse a
                       client the deployed one serves, or its driver differs
  --keep=N             the environments whose snapshots stay beyond those open jobs use: the N most recently
                       used (default 3), and any used in the last hour; the rest are deleted

Every command takes --connection=<file>, or ARMADA_CONNECTION, to use another deployment.
The command's {item}, {index}, {out}, {files} and {artifacts} are filled per item.
map exits 1 when a task exits nonzero, and 2 when one could not run.
run exits 1 when a row is red, and 2 when the run can't be graded.
verdict exits 1 when a row is red, and 2 when the commit has none; with --json it then prints null.`;

/** Each command's options, where a name ending in `=` takes a value, and how many words it takes before `--`. Every
 *  command also takes `--connection=`. */
const COMMANDS: ReadonlyMap<string, { readonly options: readonly string[]; readonly words: number }> = new Map([
  ['deploy', { options: ['account=', 'name=', 'vcpus=', 'drain', 'keep='], words: 0 }],
  ['map', { options: ['times=', 'items=', 'env=', 'commit=', 'size=', 'pool=', 'slots=', 'timeout=', 'output', 'speculative', 'hedge=', 'secrets=', 'json', 'label=', 'artifacts='], words: 0 }],
  ['run', { options: ['label=', 'secrets=', 'json'], words: 1 }],
  ['verdict', { options: ['json'], words: 1 }],
  ['push', { options: [], words: 0 }],
  ['dev', { options: [], words: 0 }],
  ['status', { options: [], words: 1 }],
  ['dashboard', { options: ['serve='], words: 0 }],
  ['secret', { options: [], words: 2 }],
  ['webhook', { options: ['repo=', 'branches=', 'pull-requests', 'token-secret='], words: 2 }],
  ['prune', { options: ['keep='], words: 0 }],
]);

const dash = process.argv.indexOf('--');

/** The arguments before `--`, which are armada's, and the words after it, which are the command's. */
const args = (dash < 0 ? process.argv : process.argv.slice(0, dash)).slice(2);

const rest = dash < 0 ? [] : process.argv.slice(dash + 1);

const option = (name: string): string | undefined => args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);

const flag = (name: string): boolean => args.includes(`--${name}`);

/** `--name=N` as a whole number no less than `least`, or undefined when it is not given. */
function whole(name: string, least = 1): number | undefined {
  const text = option(name);

  if (text === undefined) return undefined;
  const value = Number(text);

  if (!Number.isInteger(value) || value < least) throw new Error(`--${name} takes a ${least > 0 ? 'positive ' : ''}whole number, not ${text}`);

  return value;
}

const RecipeFileSchema = v.object({
  base: v.optional(BaseSchema), setup: v.optional(v.string()), install: v.optional(v.string()), size: v.optional(SizeSchema),
});

/** A recipe file, its scripts read as text relative to it. */
function recipeFrom(path: string | undefined): v.InferOutput<typeof RecipeFileSchema> {
  if (path === undefined) return {};
  const file = v.parse(RecipeFileSchema, JSON.parse(readFileSync(path, 'utf8')));
  const text = (script: string | undefined) => script === undefined ? undefined : readFileSync(resolve(dirname(path), script), 'utf8');
  const read = { ...file };

  if (file.setup !== undefined) read.setup = text(file.setup);

  if (file.install !== undefined) read.install = text(file.install);

  return read;
}

function itemsFrom(source: string): Json[] {
  const text = readFileSync(source === '-' ? 0 : source, 'utf8').trim();

  // Parsed from JSON, so JSON.
  if (text.startsWith('[')) return v.parse(v.array(JsonSchema), JSON.parse(text));

  return text.split('\n').filter((line) => line.trim() !== '');
}

async function map(): Promise<number> {
  const items = option('items');
  const times = whole('times');

  if (rest.length === 0 || (items === undefined) === (times === undefined)) {
    throw new Error('map needs one of --times=N and --items=<file|->, and a command after --, as in: armada map --times=3 -- echo {item}');
  }

  const armada = connect();
  const began = Date.now();
  const target = option('commit');
  const size = option('size');
  const where = target === undefined ? { recipe: recipe(recipeFrom(option('env'))).spec, env: {}, tmpfs: undefined } : await onCommit(armada, target);
  const base = size === undefined ? where.recipe : { ...where.recipe, size: v.parse(SizeSchema, size) };
  const argv = argvOf(rest, base);
  const taskOptions = { speculative: flag('speculative'), hedge: whole('hedge', 0), timeout: whole('timeout'), secrets: option('secrets')?.split(',').filter(Boolean) };
  const all: Json[] = times === undefined ? itemsFrom(items ?? '-') : Array.from({ length: times }, (_, index) => index + 1);
  const options = { armada, pool: whole('pool'), slots: whole('slots'), label: option('label') ?? '', env: where.env, tmpfs: where.tmpfs };
  const job = flag('output') ? commandTask(base, argv, { ...taskOptions, output: 'text' }).stream(all, options) : commandTask(base, argv, taskOptions).stream(all, options);
  const id = await job.id;
  let worst = 0;
  const metas: Meta[] = [];

  console.error(`job ${id}`);

  // A ready environment starts the job at once; a new one is prepared first, which is a wait worth a word.
  let told: Promise<void> | null = null;

  const tell = async (): Promise<void> => {
    try {
      const status = await job.status();

      if (status.phase === 'preparing') console.error(`preparing environment ${status.key.slice(0, 12)}: once per recipe, and it takes a few minutes`);
    } catch (cause) {
      console.error(`job ${id}'s status did not answer: ${errorOf({ cause }).message}`);
    }
  };

  const preparing = setTimeout(() => { told = tell(); }, 3_000);

  const artifacts = option('artifacts');

  await cancelOnInterrupt(job, id, async () => {
    for await (const result of job) {
      metas.push(result.meta);
      let kept: string | undefined;

      if (artifacts !== undefined && result.meta.artifacts) {
        const archive = await job.artifacts(result.index);

        if (archive !== null) {
          kept = join(artifacts, String(result.index));
          extractTar(archive, kept);
        }
      }

      // JSON leaves out what a result does not have: a value, an error, artifacts kept.
      if (flag('json')) console.log(JSON.stringify({ index: result.index, item: result.item, kind: result.kind, ...result.meta, value: result.ok ? result.value : undefined, error: result.kind === 'error' ? result.error : undefined, artifacts: kept }));
      else console.log(`${String(result.index).padStart(6)}  ${result.kind === 'ok' || result.kind === 'error' ? `exit ${String(result.meta.exitCode)}` : result.kind.toUpperCase()}  ${result.meta.seconds.toFixed(2)} s  ${result.meta.container}`);

      if (result.kind === 'lost' || result.kind === 'cancelled') worst = 2;
      else if (result.kind !== 'ok' && worst === 0) worst = 1;
    }
  });
  clearTimeout(preparing);
  await told;

  for (const problem of (await job.status()).problems) console.error(`problem: ${problem}`);
  const summary = await job.summary();
  const usage = usageOf(metas);

  if (usage !== null) console.error(`one task used at most ${describeUsage(usage)}`);
  console.error(`${String(summary.tasks)} tasks: ${String(summary.green)} green, ${String(summary.red)} red, ${String(summary.failed)} failed; wall ${((Date.now() - began) / 1000).toFixed(1)} s, `
    + `map ${(summary.mapMs / 1000).toFixed(1)} s on ${String(summary.vessels)} containers (${summary.tasksPerSecond.toFixed(1)} tasks/s); `
    + `first answers ${((summary.bootMs[0] ?? 0) / 1000).toFixed(1)} to ${((summary.bootMs.at(-1) ?? 0) / 1000).toFixed(1)} s`);

  return worst;
}

/** The checkout's wrangler, run by the Bun that runs armada, so it needs no Node.js. */
const WRANGLER = [process.execPath, join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')];

function wrangler(words: readonly string[], account: string, stdin?: string): string {
  const ran = Bun.spawnSync([...WRANGLER, ...words], {
    cwd: ROOT, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account }, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
  });

  const output = ran.stdout.toString() + ran.stderr.toString();

  if (ran.exitCode !== 0) throw new Error(`wrangler ${words.slice(0, 3).join(' ')} exited ${String(ran.exitCode)}:\n${output.slice(-3000)}`);

  return output;
}

const WhoamiSchema = v.object({ loggedIn: v.boolean(), accounts: v.optional(v.array(v.object({ id: v.string(), name: v.string() })), []) });

function whoami(): v.InferOutput<typeof WhoamiSchema> {
  const ran = Bun.spawnSync([...WRANGLER, 'whoami', '--json'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const output = ran.stdout.toString();
  // Not JSON when wrangler printed an error instead, which is said below.
  const parsed = v.safeParse(WhoamiSchema, jsonOf(output));

  if (!parsed.success) throw new Error(`wrangler whoami failed:\n${(output + ran.stderr.toString()).trim().slice(-2000)}`);

  return parsed.output;
}

/** The Cloudflare login's accounts. With no login and no CLOUDFLARE_API_TOKEN, wrangler's own login runs first. */
function accounts(): readonly { readonly id: string; readonly name: string }[] {
  const first = whoami();

  if (first.loggedIn) return first.accounts;

  if (process.env['CLOUDFLARE_API_TOKEN'] !== undefined) throw new Error('Cloudflare did not accept CLOUDFLARE_API_TOKEN');
  console.log('Log in to Cloudflare in your browser to continue.');
  const login = Bun.spawnSync([...WRANGLER, 'login'], { cwd: ROOT, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const after = login.exitCode === 0 ? whoami() : null;

  if (after?.loggedIn !== true) throw new Error('the Cloudflare login did not finish; run armada deploy again');

  return after.accounts;
}

/** `--account`, else the login's one account. */
function accountOf(): string {
  const all = accounts();
  const named = option('account');
  const [only] = all;

  if (named !== undefined) return named;

  if (only !== undefined && all.length === 1) return only.id;

  throw new Error(all.length === 0 ? 'this login has no Cloudflare account; name one with --account=<id>'
    : `this login has ${String(all.length)} accounts; pick one with --account=<id>:${all.map((each) => `\n  ${each.id}  ${each.name}`).join('')}`);
}

/** How often a deploy asks the deployed version whether its open jobs have finished. */
const DRAIN_POLL_MS = 15_000;

/** Drains the deployed version: it admits no new job, which `drained` is told of at once, and this waits for its open
 *  jobs to finish. A Worker too old to drain is said to be, and its running jobs end with the deploy. */
async function drain(armada: Armada, drained: () => void): Promise<void> {
  let jobs = await armada.drain();

  if (jobs === null) {
    console.log('the deployed Worker cannot stop taking jobs, so any job it runs now ends with this deploy');

    return;
  }

  drained();

  // Each ask renews the drain, which lapses by itself if this process dies.
  while (jobs !== null && jobs > 0) {
    console.log(`waiting for ${String(jobs)} open job${jobs === 1 ? '' : 's'} to finish; new jobs are refused until the deploy is done`);
    await Bun.sleep(DRAIN_POLL_MS);
    jobs = await armada.drain();
  }
}

/** The deployed Worker's health, or null, said, when it does not answer one: its jobs are drained first then. */
async function healthOf(name: string, deployed: Armada): Promise<Health | null> {
  try {
    return await deployed.health();
  } catch (cause) {
    console.error(`armada: ${name}'s health did not answer (${errorOf({ cause }).message}), so its open jobs finish before this deploy`);

    return null;
  }
}

/** The bucket (packs and job artifacts expire after 7 days), the Worker, its bearer, its registry credentials, and
 *  the connection file. A version that still serves every client the deployed one does, on the same driver, takes over
 *  the running jobs; `--drain`, an unreachable one, or one this would serve a client less than, is drained first, and
 *  a deploy that fails or is interrupted lets the drained one admit jobs again. */
async function deploy(name: string, vcpus: number | undefined, forceDrain: boolean, keep: number): Promise<number> {
  const account = accountOf();
  // Minted before anything changes, so a login that cannot mint them fails the deploy with the deployment as it was.
  const registry = await mintRegistry(account);
  const file = connectionFile(name);
  const deployed = existsSync(file) ? new Armada(v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8')))) : null;
  let drained = false;

  const admit = async () => {
    if (drained) await deployed?.admit();
  };

  let leaving: Promise<never> | null = null;

  const leave = async (): Promise<never> => {
    await admit();
    process.exit(2);
  };

  const interrupted = (signal: NodeJS.Signals) => {
    console.error(`armada: ${signal}: the deployed version admits jobs again`);
    leaving ??= leave();
  };

  process.once('SIGINT', interrupted).once('SIGTERM', interrupted).once('SIGHUP', interrupted);

  try {
    // A version whose Worker would still serve every client the deployed one does takes over the running jobs:
    // their containers outlive the Worker's update, and each object resumes from storage (measured: six deploys in
    // two minutes over 200 one-minute tasks cut none and refused no job).
    const health = deployed === null ? null : await healthOf(name, deployed);

    if (deployed !== null && mustDrain(health, forceDrain)) await drain(deployed, () => { drained = true; });
    await install(account, name, vcpus, file);
    // The drain names the version it replaced, which may still answer for a moment, so it stays drained.
    drained = false;
    wrangler(['secret', 'put', 'REGISTRY_CREDENTIALS', '--name', name], account, registry.credentials);
    wrangler(['secret', 'put', 'REGISTRY_CREDENTIALS_EXPIRE', '--name', name], account, registry.until);
    wrangler(['secret', 'put', 'KEEP_ENVIRONMENTS', '--name', name], account, String(keep));
    console.log(`${name} keeps the snapshots of its open jobs' environments, its ${String(keep)} most recently used others and any used in the last hour; its registry credentials last until ${registry.until}`);
    await firstLook(name, file);
  } finally {
    process.off('SIGINT', interrupted).off('SIGTERM', interrupted).off('SIGHUP', interrupted);
    await admit();
  }

  return 0;
}

/** The deployed Worker's first look at its environments, which prunes what an earlier version kept and starts the
 *  hourly ones. The deploy is done either way: a look the new version did not answer yet waits for the next new
 *  environment, which the deploy says. */
async function firstLook(name: string, file: string): Promise<void> {
  try {
    await pruneOn(new Armada(v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8')))), undefined);
  } catch (cause) {
    console.warn(`armada: ${name}'s first look at its environments did not answer (${errorOf({ cause }).message}); its next new environment makes it`);
  }
}

/** How long the registry credentials a deploy gives the Worker last; each deploy mints new ones. */
const REGISTRY_DAYS = 365;

/** Registry credentials for the Worker to delete snapshots with, minted through wrangler's login, and when they end. */
async function mintRegistry(account: string): Promise<{ readonly credentials: string; readonly until: string }> {
  const token = wrangler(['auth', 'token'], account).trim().split('\n').at(-1)?.trim() ?? '';
  const credentials = await registryCredentials(account, token, REGISTRY_DAYS * 24 * 60);

  return { credentials, until: new Date(Date.now() + REGISTRY_DAYS * 24 * 60 * 60_000).toISOString() };
}

/** Where a deploy builds the dashboard the Worker serves (wrangler.jsonc's `assets`). */
const DASHBOARD = join(ROOT, 'dist', 'dashboard');

async function install(account: string, name: string, vcpus: number | undefined, file: string): Promise<void> {
  const bucket = `${name}-artifacts`;

  if (!wrangler(['r2', 'bucket', 'list'], account).includes(bucket)) wrangler(['r2', 'bucket', 'create', bucket], account);
  const rules = wrangler(['r2', 'bucket', 'lifecycle', 'list', bucket], account);

  for (const prefix of ['packs/', 'jobs/']) {
    const rule = `expire-${prefix.slice(0, -1)}`;

    if (!rules.includes(rule)) wrangler(['r2', 'bucket', 'lifecycle', 'add', bucket, rule, prefix, '--expire-days', '7', '--force'], account);
  }

  const config = join(tmpdir(), `armada-wrangler-${String(process.pid)}.jsonc`);

  await buildDashboard(DASHBOARD);
  writeFileSync(config, readFileSync(join(ROOT, 'worker', 'wrangler.jsonc'), 'utf8').replace('"name": "armada",', `"name": "${name}",\n  "account_id": "${account}",`)
    .replace('"main": "src/worker.ts"', `"main": "${join(ROOT, 'worker', 'src', 'worker.ts')}"`).replace('"$schema": "../node_modules/wrangler/config-schema.json",', '')
    .replace('"directory": "../dist/dashboard"', `"directory": "${DASHBOARD}"`)
    .replace('"bucket_name": "armada-artifacts"', `"bucket_name": "${bucket}"`)
    .replace(/"FLEET_VCPUS": "\d+"/u, (all) => vcpus === undefined ? all : `"FLEET_VCPUS": "${String(vcpus)}"`)
    // The deployment knows its own source commit: the webhook's driver installs armada at it.
    .replace('"ARMADA_SHA": ""', `"ARMADA_SHA": "${Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', 'HEAD']).stdout.toString().trim()}"`));

  try {
    const deployed = wrangler(['deploy', '-c', config], account);
    const url = new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`, 'u').exec(deployed)?.[0];

    if (url === undefined) throw new Error(`the deploy printed no workers.dev URL:\n${deployed.slice(-2000)}`);
    const token = existsSync(file) ? v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8'))).token : [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    wrangler(['secret', 'put', 'ARMADA_TOKEN', '-c', config], account, token);
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ url, token, account }, null, 2) + '\n');
    chmodSync(file, 0o600);
    console.log(`${name} is deployed at ${url}\ntry it: armada map${name === 'armada' ? '' : ` --connection=${file}`} --times=3 --json -- echo hello {item}`);
  } finally {
    rmSync(config, { force: true });
  }
}

/** Has the Worker delete now, with the registry credentials its deploy minted, the snapshots past those it keeps, or
 *  past the `keep` most recently used with no recent hour spared; an open job's environment stays
 *  (`ArmadaEnvironments.prune`). A later job prepares one again. */
async function pruneOn(armada: Armada, keep: number | undefined): Promise<number> {
  const answer = await armada.call('/environments/prune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keep }) });
  const { pruned } = v.parse(v.object({ pruned: v.array(v.string()) }), await answer.json());

  for (const key of pruned) console.log(`pruned ${key.slice(0, 12)}`);
  console.log(`${String(pruned.length)} pruned`);

  return 0;
}

/** Refuses an option the command does not take, a value given to a flag or missing from an option, and a word too many. */
function checkArguments(command: string, words: readonly string[]): void {
  const { options, words: wanted } = COMMANDS.get(command) ?? { options: [], words: 0 };

  for (const argument of args.filter((each) => each.startsWith('-'))) {
    const name = argument.startsWith('--') ? argument.slice(2).split('=')[0] ?? '' : '';
    const valued = name === 'connection' || options.includes(`${name}=`);

    if (!valued && !options.includes(name)) throw new Error(`${command} has no option ${argument}; see armada --help`);

    if (valued !== argument.includes('=')) throw new Error(valued ? `--${name} takes a value, as in --${name}=<value>` : `--${name} takes no value`);
  }

  if (words.length > wanted) throw new Error(`${command} does not take ${words.slice(wanted).join(' ')}; see armada --help`);
}

async function pushProject(armada: Armada): Promise<Push> {
  const pushed = await push(armada, process.cwd());

  if (pushed === null) throw new Error('no armada.config.ts here or above: a project names its tasks there');

  return pushed;
}

function say(pushed: Push): void {
  console.log(`pushed ${String(pushed.ids.length)} task${pushed.ids.length === 1 ? '' : 's'} of ${pushed.project}, bundle ${pushed.bundle.slice(0, 12)}: ${pushed.ids.join(', ')}`);
}

/** Pushes the project, then again after each save in its task folders, until interrupted. */
async function dev(armada: Armada): Promise<number> {
  const project = await findProject(process.cwd());

  if (project === null) throw new Error('no armada.config.ts here or above: a project names its tasks there');
  let pushing = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A task file is a module this process already imported, so each push runs in a fresh process.
  const again = () => {
    pushing = pushing.then(() => {
      const ran = Bun.spawnSync([process.execPath, import.meta.path, 'push'], { cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' });

      if (ran.exitCode !== 0) console.error('armada: that push failed; the last one stays current');
    });
  };

  say(await pushProject(armada));

  for (const folder of project.config.tasks) {
    watch(join(project.root, folder), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(again, 300);
    });
  }

  console.log('watching for changes; Ctrl-C stops');
  await new Promise<never>(() => undefined);

  return 0;
}

/** `secret set <NAME>` reads the value from stdin, less one trailing newline, so `echo` and a typed line both work. */
async function secret(armada: Armada, verb: string | undefined, name: string | undefined): Promise<number> {
  if (verb === 'list') {
    for (const each of await armada.secrets()) console.log(each);

    return 0;
  }

  if (name === undefined || (verb !== 'set' && verb !== 'delete')) throw new Error('secret takes set <NAME>, list or delete <NAME>; see armada --help');

  if (verb === 'delete') {
    console.log(await armada.deleteSecret(name) ? `deleted ${name}` : `no secret ${name} was set`);

    return 0;
  }

  const value = (await Bun.stdin.text()).replace(/\r?\n$/u, '');

  await armada.setSecret(name, value);
  console.log(`set ${name}; a task gets it with secrets: ['${name}']`);

  return 0;
}

/** `webhook add` makes the project's GitHub hook with `gh` (signed in for the repo), or updates the one the CLI made
 *  before, and then stores the same signing secret on the deployment, so the two never differ. Without gh, a new
 *  project's config is stored and the hook's settings printed, the secret once, to add by hand. `webhook remove`
 *  deletes both. */
async function webhook(armada: Armada, verb: string | undefined, project: string | undefined): Promise<number> {
  const listed = async () => v.parse(WebhooksSchema, await (await armada.call('/webhooks')).json()).webhooks;

  if (verb === 'list') {
    for (const each of await listed()) {
      console.log(`${each.project}  ${each.repo}  ${each.branches?.join(',') ?? 'default branch'}  ${each.pullRequests ? 'push + pull requests' : 'push'}  token: ${each.tokenSecret}${each.hook === undefined ? '' : `  hook ${String(each.hook)}`}`);
    }

    return 0;
  }

  if (project === undefined || (verb !== 'add' && verb !== 'remove')) throw new Error('webhook takes add <project>, list or remove <project>; see armada --help');

  if (verb === 'remove') {
    const removed = v.parse(v.object({ removed: v.string(), repo: v.optional(v.string()), hook: v.optional(v.number()) }), await (await armada.call(`/webhooks/${project}`, { method: 'DELETE' })).json());

    if (removed.hook !== undefined && removed.repo !== undefined && ghOut(['api', `repos/${removed.repo}/hooks/${String(removed.hook)}`, '-X', 'DELETE']) !== null) console.log(`deleted GitHub hook ${String(removed.hook)} on ${removed.repo}`);
    console.log(`removed ${project}`);

    return 0;
  }

  const repo = option('repo');

  if (repo === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error('webhook add needs --repo=<owner/name>');
  const signing = [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const url = `${new URL(armada.connection.url).origin}/webhooks/github/${project}`;
  const pullRequests = flag('pull-requests');
  const events = pullRequests ? ['push', 'pull_request'] : ['push'];
  const settings = ['-F', 'active=true', '-F', 'config[content_type]=json', '-F', `config[url]=${url}`, '-F', `config[secret]=${signing}`, ...events.flatMap((event) => ['-f', `events[]=${event}`])];
  const known = (await listed()).find((each) => each.project === project && each.repo === repo)?.hook;
  const signedIn = ghOut(['auth', 'status']) !== null;

  // A hook GitHub already signs with another secret is updated first, or the deployment would refuse its deliveries.
  if (known !== undefined && !signedIn) throw new Error(`${project} has GitHub hook ${String(known)} on ${repo}: updating its secret needs gh signed in for ${repo} (gh auth login)`);

  const made = known === undefined ? ['api', `repos/${repo}/hooks`, '-F', 'name=web', ...settings, '--jq', '.id'] : ['api', `repos/${repo}/hooks/${String(known)}`, '-X', 'PATCH', ...settings, '--jq', '.id'];
  const answered = signedIn ? ghOut(made) : null;
  const hook = answered === null || !/^\d+$/u.test(answered) ? undefined : Number(answered);

  // A hook whose update failed still signs with its old secret: storing the new one would refuse its deliveries.
  if (known !== undefined && hook === undefined) throw new Error(`updating GitHub hook ${String(known)} on ${repo} failed, as gh said above; the deployment's secret is unchanged`);
  // JSON leaves the options not given out, so the deployment's defaults apply.
  const config = { repo, branches: option('branches')?.split(',').filter(Boolean), pullRequests, tokenSecret: option('token-secret'), secret: signing, hook };

  await armada.call(`/webhooks/${project}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
  console.log(`configured ${project}: ${repo} builds ${pullRequests ? 'pushes and pull requests' : 'pushes'} at ${url}`);

  if (hook !== undefined) {
    console.log(`${known === undefined ? 'created' : 'updated'} GitHub hook ${String(hook)} on ${repo}`);

    return 0;
  }

  console.log(`add the hook by hand: ${repo} → Settings → Webhooks → Add webhook
  payload URL: ${url}
  content type: application/json
  secret: ${signing}
  events: ${events.join(', ')}`);

  return 0;
}

/** What `gh <args>` printed, trimmed, or null when it failed (its error said) or is not installed. */
function ghOut(argv: readonly string[]): string | null {
  const ran = Bun.spawnSync(['gh', ...argv], { stdout: 'pipe', stderr: 'pipe' });

  if (ran.exitCode === 0) return ran.stdout.toString().trim();

  if (argv[0] !== 'auth') console.error(`gh ${argv.slice(0, 2).join(' ')} failed: ${ran.stderr.toString().trim()}`);

  return null;
}

async function main(): Promise<number> {
  const [command, ...words] = args.filter((argument) => !argument.startsWith('-'));

  if (args.length === 0 || command === 'help' || flag('help') || args.includes('-h')) {
    console.log(USAGE);

    return 0;
  }

  if (command === undefined || !COMMANDS.has(command)) throw new Error(`${command === undefined ? 'no command given' : `no command ${command}`}; see armada --help`);
  checkArguments(command, words);
  const [target] = words;
  const connection = option('connection');

  if (connection !== undefined) process.env['ARMADA_CONNECTION'] = resolve(connection);

  switch (command) {
    case 'map':
      return await map();

    case 'run':
      if (target === undefined) throw new Error('run needs a commit or a worktree, as in: armada run HEAD');

      return await runCI(connect(), target, { label: option('label') ?? '', planArgs: rest, secrets: option('secrets')?.split(',').filter(Boolean) ?? [], json: flag('json') });

    case 'verdict':
      if (target === undefined) throw new Error('verdict needs a commit or a worktree, as in: armada verdict HEAD');

      return await verdictCI(connect(), target, flag('json'));

    case 'push':
      say(await pushProject(connect()));

      return 0;

    case 'dev':
      return await dev(connect());

    case 'status':
      if (target === undefined) throw new Error('status needs a job id, which map and run print');
      console.log(JSON.stringify(await connect().status(target), null, 2));

      return 0;

    case 'secret':
      return await secret(connect(), target, words[1]);

    case 'webhook':
      return await webhook(connect(), target, words[1]);

    case 'dashboard': {
      const port = whole('serve');

      if (port !== undefined) return await serveDashboard(connect(), port);
      const url = dashboardUrl(connect());

      // The address holds the bearer, so it is printed only when no browser took it.
      if (openInBrowser(url)) console.log('opened the dashboard in your browser');
      else console.log(`open this address, which signs a browser in to this deployment:\n${url}`);

      return 0;
    }

    case 'deploy': {
      const name = option('name') ?? 'armada';

      if (!/^[a-z][a-z0-9-]{0,40}$/u.test(name)) throw new Error(`--name=${name}: a Worker's name, lowercase letters, digits and dashes`);

      return await deploy(name, whole('vcpus'), flag('drain'), whole('keep', 0) ?? KEPT_ENVIRONMENTS);
    }

    case 'prune':
      return await pruneOn(connect(), whole('keep', 0));

    default:
      throw new Error(`no command ${command}`);
  }
}

try {
  process.exit(await main());
} catch (cause) {
  console.error(`armada: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(2);
}
