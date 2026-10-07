#!/usr/bin/env bun
/** The armada CLI; `armada --help` prints its usage. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { argvOf, cancelOnInterrupt, onCommit, runCI, verdictCI } from './ci';
import { deleteSnapshot } from './registry';
import { Armada, CONFIG_DIR, connect, connectionFile, ConnectionSchema } from './sdk';
import { BaseSchema, describeUsage, SizeSchema, usageOf } from './protocol';
import { cmd, recipe, type Json, type Meta } from './task';

const ROOT = join(import.meta.dir, '..');

const USAGE = `armada runs a command over many inputs at once, on Cloudflare Containers.

Usage:
  armada deploy [--account=<id>] [--name=<name>] [--vcpus=N]
                                       deploy armada to your Cloudflare account, logging in if needed
  armada map [options] -- <command>    run the command once per item
  armada run <commit|worktree> [--label=<text>] [-- <plan args>]
                                       run a project's CI from the commit's .armada.json
  armada verdict <commit|worktree> [--json]
                                       print the verdict armada run stored for the commit
  armada status <job-id>               print a job's status as JSON
  armada prune [--keep=3]              delete the snapshots of all but the newest environments

map options:
  --times=N            the items are 1 to N
  --items=<file|->     a JSON array, or one item per line
  --env=<recipe.json>  {"base", "setup", "install", "size"}, scripts relative to it
  --commit=<rev>       run in the commit's checkout, in the environment its .armada.json names
  --size=<size>        each container's size: micro, mini, small or medium (default medium)
  --pool=N             the most containers at once (default 50)
  --timeout=S          a task's limit, in seconds (default 3600)
  --output             keep each task's {out} file
  --speculative        let an idle container run a straggler again
  --json               print each outcome as a JSON line
  --label=<text>       name the job

deploy options:
  --account=<id>       the account to use, if your login has more than one
  --name=<name>        a separate armada with its own Worker, <name>-artifacts bucket, fleet
                       and connection file, ~/.config/armada/<name>.json (default armada)
  --vcpus=N            the most vCPUs its fleet runs at once (default 1500)

Every command takes --connection=<file>, or ARMADA_CONNECTION, to use another deployment.
The command's {item}, {index}, {out} and {files} are filled per item.
map exits 1 when a task exits nonzero, and 2 when one could not run.
run exits 1 when a row is red, and 2 when the run can't be graded.
verdict exits 1 when a row is red, and 2 when the commit has none; with --json it then prints null.
prune needs ARMADA_REGISTRY_TOKEN, an API token with Containers: Edit.`;

/** Each command's options, where a name ending in `=` takes a value, and how many words it takes before `--`. Every
 *  command also takes `--connection=`. */
const COMMANDS: ReadonlyMap<string, { readonly options: readonly string[]; readonly words: number }> = new Map([
  ['deploy', { options: ['account=', 'name=', 'vcpus='], words: 0 }],
  ['map', { options: ['times=', 'items=', 'env=', 'commit=', 'size=', 'pool=', 'timeout=', 'output', 'speculative', 'json', 'label='], words: 0 }],
  ['run', { options: ['label='], words: 1 }],
  ['verdict', { options: ['json'], words: 1 }],
  ['status', { options: [], words: 1 }],
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
  const recipe = { ...file };

  if (file.setup !== undefined) recipe.setup = text(file.setup);

  if (file.install !== undefined) recipe.install = text(file.install);

  return recipe;
}

function itemsFrom(source: string): Json[] {
  const text = readFileSync(source === '-' ? 0 : source, 'utf8').trim();

  // Parsed from JSON, so JSON.
  if (text.startsWith('[')) return v.parse(v.array(v.unknown()), JSON.parse(text)) as Json[];

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
  const where = target === undefined ? { recipe: recipe(recipeFrom(option('env'))), env: {}, tmpfs: undefined } : await onCommit(armada, target);
  const base = size === undefined ? where.recipe : { ...where.recipe, size: v.parse(SizeSchema, size) };
  const argv = argvOf(rest, base);
  const taskOptions = { speculative: flag('speculative'), timeout: whole('timeout') };
  const all: Json[] = times === undefined ? itemsFrom(items ?? '-') : Array.from({ length: times }, (_, index) => index + 1);
  const options = { armada, pool: whole('pool'), label: option('label') ?? '', env: where.env, tmpfs: where.tmpfs };
  const job = flag('output') ? cmd(base, argv, { ...taskOptions, output: 'text' }).map(all, options) : cmd(base, argv, taskOptions).map(all, options);
  const id = await job.id;
  let worst = 0;
  const metas: Meta[] = [];

  console.error(`job ${id}`);
  // A ready environment starts the job at once; a new one is prepared first, which is a wait worth a word.
  const preparing = setTimeout(() => {
    void job.status().then((status) => {
      if (status.phase === 'preparing') console.error(`preparing environment ${status.key.slice(0, 12)}: once per recipe, and it takes a few minutes`);
    }, () => undefined);
  }, 3_000);

  await cancelOnInterrupt(job, id, async () => {
    for await (const result of job) {
      metas.push(result.meta);

      if (flag('json')) console.log(JSON.stringify({ index: result.index, item: result.item, kind: result.kind, ...result.meta, ...'value' in result ? { value: result.value } : {}, ...'error' in result ? { error: result.error } : {} }));
      else console.log(`${String(result.index).padStart(6)}  ${result.kind === 'ok' || result.kind === 'error' ? `exit ${String(result.meta.exitCode)}` : result.kind.toUpperCase()}  ${result.meta.seconds.toFixed(2)} s  ${result.meta.container}`);

      if (result.kind === 'lost' || result.kind === 'cancelled') worst = 2;
      else if (result.kind !== 'ok' && worst === 0) worst = 1;
    }
  });
  clearTimeout(preparing);

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

function wrangler(args: readonly string[], account: string, stdin?: string): string {
  const ran = Bun.spawnSync([...WRANGLER, ...args], {
    cwd: ROOT, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account }, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
  });
  const output = ran.stdout.toString() + ran.stderr.toString();

  if (ran.exitCode !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} exited ${String(ran.exitCode)}:\n${output.slice(-3000)}`);

  return output;
}

const WhoamiSchema = v.object({ loggedIn: v.boolean(), accounts: v.optional(v.array(v.object({ id: v.string(), name: v.string() })), []) });

function whoami(): v.InferOutput<typeof WhoamiSchema> {
  const ran = Bun.spawnSync([...WRANGLER, 'whoami', '--json'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const output = ran.stdout.toString();
  let json: unknown = null;

  try {
    json = JSON.parse(output);
  } catch {
    // Not JSON: wrangler printed an error instead, which is said below.
  }
  const parsed = v.safeParse(WhoamiSchema, json);

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

  while (jobs > 0) {
    console.log(`waiting for ${String(jobs)} open job${jobs === 1 ? '' : 's'} to finish; new jobs are refused until the deploy is done`);
    await Bun.sleep(DRAIN_POLL_MS);
    ({ jobs } = await armada.health());
  }
}

/** Drains the deployed version first; then the bucket (packs, bundles and job artifacts expire after 7 days), the
 *  Worker, its bearer, and the connection file. The version deployed admits jobs at once, and a deploy that fails or
 *  is interrupted lets the drained one admit them again. */
async function deploy(name: string, vcpus: number | undefined): Promise<number> {
  const account = accountOf();
  const file = connectionFile(name);
  const deployed = existsSync(file) ? new Armada(v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8')))) : null;
  let drained = false;
  const admit = async () => {
    if (drained) await deployed?.admit();
  };
  const interrupted = (signal: NodeJS.Signals) => {
    console.error(`armada: ${signal}: the deployed version admits jobs again`);
    void admit().finally(() => process.exit(2));
  };

  process.once('SIGINT', interrupted).once('SIGTERM', interrupted);

  try {
    if (deployed !== null) await drain(deployed, () => { drained = true; });
    install(account, name, vcpus, file);
    // The drain names the version it replaced, which may still answer for a moment, so it stays drained.
    drained = false;
  } finally {
    process.off('SIGINT', interrupted).off('SIGTERM', interrupted);
    await admit();
  }

  return 0;
}

function install(account: string, name: string, vcpus: number | undefined, file: string): void {
  const bucket = `${name}-artifacts`;

  if (!wrangler(['r2', 'bucket', 'list'], account).includes(bucket)) wrangler(['r2', 'bucket', 'create', bucket], account);
  const rules = wrangler(['r2', 'bucket', 'lifecycle', 'list', bucket], account);

  for (const prefix of ['packs/', 'jobs/', 'bundles/']) {
    const rule = `expire-${prefix.slice(0, -1)}`;

    if (!rules.includes(rule)) wrangler(['r2', 'bucket', 'lifecycle', 'add', bucket, rule, prefix, '--expire-days', '7', '--force'], account);
  }

  const config = join(tmpdir(), `armada-wrangler-${String(process.pid)}.jsonc`);

  writeFileSync(config, readFileSync(join(ROOT, 'worker', 'wrangler.jsonc'), 'utf8').replace('"name": "armada",', `"name": "${name}",\n  "account_id": "${account}",`)
    .replace('"main": "src/worker.ts"', `"main": "${join(ROOT, 'worker', 'src', 'worker.ts')}"`).replace('"$schema": "../node_modules/wrangler/config-schema.json",', '')
    .replace('"bucket_name": "armada-artifacts"', `"bucket_name": "${bucket}"`)
    .replace(/"FLEET_VCPUS": "\d+"/u, (all) => vcpus === undefined ? all : `"FLEET_VCPUS": "${String(vcpus)}"`));

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

const EntrySchema = v.object({ key: v.string(), entry: v.looseObject({ state: v.string(), lastUsed: v.optional(v.number()), generation: v.optional(v.object({ snapshot: v.object({ id: v.string() }) })) }) });

/** Deletes the snapshots of all but the `keep` most recently used environments; a later job prepares one again. */
async function prune(keep: number): Promise<number> {
  const token = process.env['ARMADA_REGISTRY_TOKEN'] ?? '';

  if (token === '') throw new Error('pruning deletes registry tags: export ARMADA_REGISTRY_TOKEN, an API token with Containers: Edit');
  const armada = connect();
  const listed = v.parse(v.array(EntrySchema), await (await armada.call('/environments')).json());
  const ready = listed.filter((each) => each.entry.state === 'ready').sort((left, right) => (right.entry.lastUsed ?? 0) - (left.entry.lastUsed ?? 0));

  for (const { key, entry } of ready.slice(keep)) {
    const id = entry.generation?.snapshot.id;
    const deleted = id === undefined ? 'absent' : await deleteSnapshot({ account: armada.connection.account, token, id });

    await armada.call(`/environments/${key}`, { method: 'DELETE' });
    console.log(`pruned ${key.slice(0, 12)} (${deleted})`);
  }

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

      return await runCI(connect(), target, option('label') ?? '', rest);

    case 'verdict':
      if (target === undefined) throw new Error('verdict needs a commit or a worktree, as in: armada verdict HEAD');

      return await verdictCI(connect(), target, flag('json'));

    case 'status':
      if (target === undefined) throw new Error('status needs a job id, which map and run print');
      console.log(JSON.stringify(await connect().status(target), null, 2));

      return 0;

    case 'deploy': {
      const name = option('name') ?? 'armada';

      if (!/^[a-z][a-z0-9-]{0,40}$/u.test(name)) throw new Error(`--name=${name}: a Worker's name, lowercase letters, digits and dashes`);

      return await deploy(name, whole('vcpus'));
    }

    case 'prune':
      return await prune(whole('keep', 0) ?? 3);

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
