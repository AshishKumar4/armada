/**
 * A project's tasks: `armada.config.ts` names the project and its task folders, and `armada push` bundles every task
 * exported from them for `node`, uploads the bundle by its digest, and records each task's id against it. A container
 * runs the bundle with the id of the task to run. Inside a project, `.map` pushes first when the folder changed, so a
 * script needs no separate step.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { Project, type Push } from './protocol';
import { isRunnable } from './runner';
import type { Armada } from './sdk';

export const CONFIG_FILE = 'armada.config.ts';

const ConfigSchema = v.object({
  /** The project's slug, which owns its task ids in a deployment. */
  project: Project,
  /** The folders, from the config's directory, whose files export tasks. Default `armada`. */
  tasks: v.optional(v.array(v.string()), ['armada']),
});

export type ArmadaConfig = v.InferInput<typeof ConfigSchema>;

export function defineConfig(config: ArmadaConfig): ArmadaConfig {
  return config;
}

/** The project above `from`: its root and its config, or null outside one. */
export async function findProject(from: string): Promise<{ readonly root: string; readonly config: v.InferOutput<typeof ConfigSchema> } | null> {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const file = join(directory, CONFIG_FILE);

    if (existsSync(file)) {
      const loaded = v.parse(v.object({ default: v.unknown() }), await import(pathToFileURL(file).href));

      return { root: directory, config: v.parse(ConfigSchema, loaded.default) };
    }

    if (dirname(directory) === directory) return null;
  }
}

/** Every task the project's folders export, each by the file it is in, refusing an id two of them share. */
async function tasksOf(root: string, folders: readonly string[]): Promise<{ readonly files: string[]; readonly ids: string[] }> {
  const files: string[] = [];
  const owners = new Map<string, string>();

  for (const folder of folders) {
    const glob = new Bun.Glob('**/*.{ts,tsx,mts,js,mjs}');

    for (const path of [...glob.scanSync({ cwd: join(root, folder), absolute: true })].sort()) {
      if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(path)) continue;
      // A task file is imported to find its tasks; its module is the user's, known only here.
      const module: Record<string, unknown> = await import(pathToFileURL(path).href);
      const tasks = Object.values(module).filter(isRunnable);

      for (const task of tasks) {
        const owner = owners.get(task.id);

        if (owner !== undefined) throw new Error(`two tasks have the id ${task.id}: in ${relative(root, owner)} and ${relative(root, path)}`);
        owners.set(task.id, path);
      }

      if (tasks.length > 0) files.push(path);
    }
  }

  if (owners.size === 0) throw new Error(`no task is exported from ${folders.join(', ')} under ${root}`);

  return { files, ids: [...owners.keys()].sort() };
}

/** The project's task files bundled for node, with the runner as the entry. */
export async function bundleTasks(root: string, folders: readonly string[]): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly ids: string[] }> {
  const { files, ids } = await tasksOf(root, folders);
  const scratch = mkdtempSync(join(tmpdir(), 'armada-push-'));

  try {
    const entry = join(scratch, 'entry.ts');
    const runner = fileURLToPath(new URL('runner.ts', import.meta.url));

    writeFileSync(entry, [
      ...files.map((file, at) => `import * as m${String(at)} from ${JSON.stringify(file)};`),
      `import { runTasks } from ${JSON.stringify(runner)};`,
      `await runTasks([${files.map((_, at) => `m${String(at)}`).join(', ')}]);`,
    ].join('\n') + '\n');
    const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm' });
    const [output] = built.outputs;

    if (!built.success || output === undefined) throw new Error(`bundling the tasks failed:\n${built.logs.map(String).join('\n')}`);

    return { bytes: new Uint8Array(await output.arrayBuffer()), ids };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Pushes the project above `from`: its bundle, then its ids against it. Null outside a project. */
export async function push(armada: Armada, from: string): Promise<Push | null> {
  const project = await findProject(from);

  if (project === null) return null;
  const { bytes, ids } = await bundleTasks(project.root, project.config.tasks);
  const record: Push = { project: project.config.project, bundle: await armada.uploadBundle(bytes), ids };

  await armada.post('/tasks', record);

  return record;
}

/** Each deployment's push from this process: one per process, so a script's maps share it. */
const pushes = new WeakMap<Armada, Promise<string | null>>();

/** The bundle this process pushed for the project it runs in, or null outside a project, where the deployment's current
 *  push of each id is run. */
export async function pushed(armada: Armada): Promise<string | null> {
  const known = pushes.get(armada) ?? push(armada, process.cwd()).then((record) => record?.bundle ?? null);

  pushes.set(armada, known);

  return await known;
}
