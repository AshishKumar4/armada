/**
 * A project's `.armada.json`: how `armada run <commit>` proves a commit. Read from the commit itself, so the recipe
 * that proves a commit is the one it holds.
 *
 *   environment  the recipe: a base image, a root `setup` and a user `install` script from the commit (carried as text,
 *                so the key hashes them), run once per environment and snapshotted. `key` globs name the paths whose
 *                bytes also decide it: the lockfile, the manifests.
 *   plan         a command run once on the commit that prints the tasks as a matrix, `{"include": [{...}, ...]}`, the
 *                shape a GitHub Actions matrix takes. An entry's keys fill the task command's `{placeholders}`; its
 *                optional `rows` name what that task must report, exactly once each; its `weight` (seconds) orders
 *                the queue longest first. Placeholders: `{target}`, `{timings}` (the runner's medians as
 *                `{"rows": {...}, "files": {...}}`).
 *   task         the command each entry runs. With `verdict` (the default) it writes a verdict file to `{out}`:
 *                `{"rows": [{"name" | "run", "exitCode", "seconds"?, "output"?, "timings"?}]}`. Without, its exit
 *                code is its one row.
 */
import * as v from 'valibot';
import { BaseSchema, DEFAULT_BASE, INSTANCES } from './protocol';

const Path = v.pipe(v.string(), v.minLength(1), v.check((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'a path inside the commit'));

const ConfigSchema = v.object({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,39}$/u)),
  environment: v.object({
    base: v.optional(BaseSchema, DEFAULT_BASE),
    setup: v.optional(Path),
    install: v.optional(Path),
    key: v.optional(v.array(v.string()), []),
    smoke: v.optional(v.string(), ''),
  }),
  /** Where the commit is checked out; by default three levels under the user's home, as a GitHub runner's is. */
  checkout: v.optional(v.pipe(v.string(), v.startsWith('/'))),
  history: v.optional(v.picklist(['full', 'commit']), 'full'),
  env: v.optional(v.record(v.string(), v.string()), {}),
  tmpfs: v.optional(v.array(v.pipe(v.string(), v.startsWith('/'))), ['/tmp', '/dev/shm']),
  instance: v.optional(v.picklist(INSTANCES), 'standard-4'),
  target: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10)), 300),
  /** The most containers a run's task job runs at once. */
  pool: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(375)), 40),
  plan: v.object({ command: v.pipe(v.array(v.string()), v.minLength(1)) }),
  task: v.object({
    command: v.pipe(v.array(v.string()), v.minLength(1)),
    /** The matrix key that names a task; `name`, else the first string-valued key, by default. */
    name: v.optional(v.string()),
    verdict: v.optional(v.boolean(), true),
    /** Whether a straggling task may be run again by an idle container, first answer kept. */
    idempotent: v.optional(v.boolean(), false),
    timeout: v.optional(v.pipe(v.number(), v.minValue(1)), 3600),
  }),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

export const CONFIG_FILE = '.armada.json';

export function parseConfig(text: string): Config {
  return v.parse(ConfigSchema, JSON.parse(text));
}

export function checkoutOf(config: Config): string {
  return config.checkout ?? `/home/ci/work/${config.name}/${config.name}`;
}

/** Whether `path` matches a `key` glob: `*` and `?` within a segment, `**` across segments. */
export function matches(glob: string, path: string): boolean {
  let pattern = '';

  for (let at = 0; at < glob.length; at += 1) {
    const rest = glob.slice(at);

    if (rest.startsWith('**/')) {
      pattern += '(?:.*/)?';
      at += 2;
    } else if (rest.startsWith('**')) {
      pattern += '.*';
      at += 1;
    } else if (rest.startsWith('*')) pattern += '[^/]*';
    else if (rest.startsWith('?')) pattern += '[^/]';
    else pattern += rest.charAt(0).replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }

  return new RegExp(`^${pattern}$`, 'u').test(path);
}
