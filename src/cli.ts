#!/usr/bin/env bun
/**
 * armada: fast, mappable compute on Cloudflare Containers.
 *
 *   armada map [--env=<recipe.json> | --commit=<rev>] (--items=<file|-> | --times=N) [--pool=N] [--output] [--idempotent] [--timeout=s] -- <command with {item}>
 *   armada run <commit|worktree> [--label=<text>]     a project's CI from its `.armada.json`; exits 0, 1 red, 2 not graded
 *   armada status <job-id>
 *   armada deploy --account=<id>                      with this machine's wrangler login
 *   armada prune [--keep=3]                           needs ARMADA_REGISTRY_TOKEN (Containers: Edit)
 *
 * `map` items are a JSON array, or one item per line; `--times=N` maps over 1..N. `--commit` runs in the commit's checkout,
 * in the environment its `.armada.json` names, as `armada run` does. A recipe file is `{"base", "setup", "install", "smoke",
 * "instance"}`, its scripts given as paths relative to it. Each outcome is printed as it lands (`--json` for JSON
 * lines), then a summary; `map` exits 0 when every task exited 0, 1 when one did not, 2 when one could not run.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { onCommit, runCI } from './ci';
import { deleteSnapshot } from './registry';
import { CONFIG_DIR, connect, ConnectionSchema } from './sdk';
import { INSTANCES } from './protocol';

const ROOT = join(import.meta.dir, '..');

const option = (name: string): string | undefined => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const RecipeFileSchema = v.object({
  base: v.optional(v.string()), setup: v.optional(v.string()), install: v.optional(v.string()), smoke: v.optional(v.string()), instance: v.optional(v.picklist(INSTANCES)),
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

function itemsFrom(source: string): unknown[] {
  const text = readFileSync(source === '-' ? 0 : source, 'utf8').trim();

  if (text.startsWith('[')) return v.parse(v.array(v.unknown()), JSON.parse(text));

  return text.split('\n').filter((line) => line.trim() !== '');
}

async function map(): Promise<number> {
  const dash = process.argv.indexOf('--');
  const command = dash < 0 ? [] : process.argv.slice(dash + 1);
  const items = option('items');
  const times = option('times');

  if (command.length === 0 || (items === undefined && times === undefined)) throw new Error('usage: armada map [--env=<recipe.json> | --commit=<rev>] (--items=<file|-> | --times=N) [--pool=N] [--output] [--idempotent] -- <command with {item}>');
  const armada = connect();
  const began = Date.now();
  const target = option('commit');
  const where = target === undefined ? { recipe: recipeFrom(option('env')) } : await onCommit(armada, target);
  const job = await armada.map({
    ...where, items: items === undefined ? Array.from({ length: Number(times) }, (_, index) => index + 1) : itemsFrom(items),
    run: { command }, output: flag('output'), idempotent: flag('idempotent'),
    pool: Number(option('pool') ?? '50'), timeout: Number(option('timeout') ?? '3600'), label: option('label') ?? '',
  });
  let worst = 0;

  console.error(`job ${job.id}`);

  for await (const outcome of job.outcomes()) {
    if (flag('json')) console.log(JSON.stringify(outcome));
    else console.log(`${String(outcome.index).padStart(6)}  ${outcome.kind === 'failed' ? 'FAILED' : `exit ${String(outcome.exitCode)}`}  ${outcome.seconds.toFixed(2)} s  ${outcome.vessel}`);

    if (outcome.kind === 'failed') worst = 2;
    else if (outcome.exitCode !== 0 && worst === 0) worst = 1;
  }

  const summary = await job.summary();

  console.error(`${String(summary.tasks)} tasks: ${String(summary.green)} green, ${String(summary.red)} red, ${String(summary.failed)} failed; wall ${((Date.now() - began) / 1000).toFixed(1)} s, `
    + `map ${(summary.mapMs / 1000).toFixed(1)} s on ${String(summary.vessels)} containers (${summary.tasksPerSecond.toFixed(1)} tasks/s); `
    + `first answers ${((summary.bootMs[0] ?? 0) / 1000).toFixed(1)} to ${((summary.bootMs.at(-1) ?? 0) / 1000).toFixed(1)} s`);

  return worst;
}

function wrangler(args: readonly string[], account: string, stdin?: string): string {
  const ran = Bun.spawnSync([join(ROOT, 'node_modules', '.bin', 'wrangler'), ...args], {
    cwd: ROOT, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account }, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
  });
  const output = ran.stdout.toString() + ran.stderr.toString();

  if (ran.exitCode !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} exited ${String(ran.exitCode)}:\n${output.slice(-3000)}`);

  return output;
}

/** The bucket (packs and job artifacts expire after 7 days), the Worker, its bearer, and the connection file. */
function deploy(account: string): number {
  const bucket = 'armada-artifacts';

  if (!wrangler(['r2', 'bucket', 'list'], account).includes(bucket)) wrangler(['r2', 'bucket', 'create', bucket], account);
  const rules = wrangler(['r2', 'bucket', 'lifecycle', 'list', bucket], account);

  for (const prefix of ['packs/', 'jobs/']) {
    const name = `expire-${prefix.slice(0, -1)}`;

    if (!rules.includes(name)) wrangler(['r2', 'bucket', 'lifecycle', 'add', bucket, name, prefix, '--expire-days', '7', '--force'], account);
  }

  const config = join(tmpdir(), `armada-wrangler-${String(process.pid)}.jsonc`);

  writeFileSync(config, readFileSync(join(ROOT, 'worker', 'wrangler.jsonc'), 'utf8').replace('"name": "armada",', `"name": "armada",\n  "account_id": "${account}",`)
    .replace('"main": "src/worker.ts"', `"main": "${join(ROOT, 'worker', 'src', 'worker.ts')}"`).replace('"$schema": "../node_modules/wrangler/config-schema.json",', ''));
  const deployed = wrangler(['deploy', '-c', config], account);
  const url = /https:\/\/armada\.[a-z0-9-]+\.workers\.dev/u.exec(deployed)?.[0];

  if (url === undefined) throw new Error(`the deploy printed no workers.dev URL:\n${deployed.slice(-2000)}`);
  const file = join(CONFIG_DIR, 'connection.json');
  const token = existsSync(file) ? v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8'))).token : [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  wrangler(['secret', 'put', 'ARMADA_TOKEN', '-c', config], account, token);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ url, token, account }, null, 2) + '\n');
  chmodSync(file, 0o600);
  console.log(`armada: ${url}`);

  return 0;
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

async function main(): Promise<number> {
  const dash = process.argv.indexOf('--');
  const words = (dash < 0 ? process.argv : process.argv.slice(0, dash)).slice(2).filter((argument) => !argument.startsWith('--'));
  const [command, target] = words;

  if (command === 'map') return await map();

  if (command === 'run' && target !== undefined) return await runCI(connect(), target, option('label') ?? '');

  if (command === 'status' && target !== undefined) {
    console.log(JSON.stringify(await connect().job(target).status(), null, 2));

    return 0;
  }

  if (command === 'deploy' && option('account') !== undefined) return deploy(option('account') ?? '');

  if (command === 'prune') return await prune(Number(option('keep') ?? '3'));
  throw new Error('usage: armada map … | armada run <commit|worktree> | armada status <job-id> | armada deploy --account=<id> | armada prune [--keep=3]');
}

try {
  process.exit(await main());
} catch (cause) {
  console.error(`armada: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(2);
}
