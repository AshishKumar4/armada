/**
 * A project's `.armada.json`: how `armada run <commit>` proves a commit. Read from the commit itself, so the recipe
 * that proves a commit is the one it holds.
 *
 *   environment  the recipe: a base image, a root `setup` and a user `install` script from the commit (carried as text,
 *                so the key hashes them), run once per environment and snapshotted. `key` globs name the paths whose
 *                bytes also decide it: the lockfile, the manifests.
 *   environments named recipes, each over `environment`'s fields, for the plan entries that name one in their
 *                `environment`: each is prepared and snapshotted on its own, and its entries run in a task job of their
 *                own, so a container restores only what its tasks need (#31).
 *   plan         a command run once on the commit that prints the tasks as a matrix, `{"include": [{...}, ...]}`, the
 *                shape a GitHub Actions matrix takes. An entry's keys fill the task command's `{placeholders}`; its
 *                optional `rows` name what that task must report, exactly once each; its `weight` (seconds) orders
 *                the queue longest first. Placeholders: `{target}`, `{timings}` (the runner's medians as
 *                `{"rows": {...}, "files": {...}}`).
 *   task         the command each entry runs. With `verdict` (the default) it writes a verdict file to `{out}`:
 *                `{"rows": [{"name" | "run", "exitCode", "seconds"?, "output"?, "timings"?, "artifacts"?}]}`. Without,
 *                its exit code is its one row. A row's `artifacts` name files in the task's `{artifacts}` directory
 *                as its evidence, extracted next to the run's report; one the task did not keep fails the run ungraded.
 */
import * as v from 'valibot';
import { BaseSchema, CI_DEADLINE_SECONDS, DEFAULT_BASE, JobSpecSchema, Project, SizeSchema } from './protocol';

const Path = v.pipe(v.string(), v.minLength(1), v.check((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'a path inside the commit'));

const EnvironmentFields = { base: BaseSchema, setup: Path, install: Path, key: v.array(v.string()) };

const EnvironmentSchema = v.object({
  base: v.optional(EnvironmentFields.base, DEFAULT_BASE),
  setup: v.optional(EnvironmentFields.setup),
  install: v.optional(EnvironmentFields.install),
  key: v.optional(EnvironmentFields.key, []),
});

export type Environment = v.InferOutput<typeof EnvironmentSchema>;

/** A deployment's name, as `armada deploy --name=<name>` takes it: its Worker's own. */
export const DeploymentName = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,40}$/u, "a Worker's name, lowercase letters, digits and dashes"));

/** A plan entry's `environment`: a name of `environments`. */
export const EnvironmentName = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,40}$/u, 'an environment name is letters, digits, dot, dash or underscore'));

const ConfigSchema = v.object({
  name: Project,
  /** The deployment the project's CI runs on: the connection `armada deploy --name=<deployment>` wrote on a machine. A
   *  connection named to the run (`ARMADA_CONNECTION`, `ARMADA_URL`) still comes first; absent, the machine's default. */
  deployment: v.optional(DeploymentName),
  /** The whole CI run's limit, plan and task jobs together, in seconds. */
  deadline: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), CI_DEADLINE_SECONDS),
  environment: EnvironmentSchema,
  /** Each one's fields over `environment`'s: a field it leaves out is the project environment's. */
  environments: v.optional(v.record(EnvironmentName, v.partial(v.object(EnvironmentFields))), {}),
  /** Where the commit is checked out; by default three levels under the user's home, as a GitHub runner's is. */
  checkout: v.optional(v.pipe(v.string(), v.startsWith('/'))),
  history: v.optional(v.picklist(['full', 'commit']), 'full'),
  ...v.pick(JobSpecSchema, ['env', 'tmpfs']).entries,
  /** A size, or `auto`: the smallest the last runs' tasks fit, `medium` until there are any. */
  size: v.optional(v.union([SizeSchema, v.literal('auto')]), 'medium'),
  target: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10)), 300),
  /** The most containers a run's task job runs at once, as a job's pool is, 40 by default. */
  pool: v.optional(v.unwrap(JobSpecSchema.entries.pool), 40),
  /** `local` runs the plan in this checkout where it is the commit itself and clean, as a CI runner's is, rather than
   *  in a container whose start can take a minute; elsewhere the plan runs in a container as ever. */
  plan: v.object({ command: v.pipe(v.array(v.string()), v.minLength(1)), local: v.optional(v.boolean(), false) }),
  /** The task job's own settings (`slots`, `mode`, `cpu`, `speculative`, `hedge`, `timeout`, `secrets`) are a job's, as a
   *  job spec has them. */
  task: v.object({
    command: v.pipe(v.array(v.string()), v.minLength(1)),
    /** The matrix key that names a task; `name`, else the first string-valued key, by default. */
    name: v.optional(v.string()),
    verdict: v.optional(v.boolean(), true),
    ...v.pick(JobSpecSchema, ['slots', 'mode', 'cpu', 'speculative', 'hedge', 'timeout', 'secrets']).entries,
  }),
});

export type Config = v.InferOutput<typeof ConfigSchema>;

export const CONFIG_FILE = '.armada.json';

export function parseConfig(text: string): Config {
  return v.parse(ConfigSchema, JSON.parse(text));
}

/** The deployment a project file names, read alone: a command that only connects needs no more of it. */
export function deploymentNamed(text: string): string | undefined {
  return v.parse(v.looseObject({ deployment: v.optional(DeploymentName) }), JSON.parse(text)).deployment;
}

/** The environment a plan entry runs in: the project's, or the one it names over the project's. */
export function environmentOf(config: Config, name: string | undefined): Environment {
  return name === undefined ? config.environment : { ...config.environment, ...config.environments[name] };
}

export function checkoutOf(config: Config): string {
  return config.checkout ?? `/home/ci/work/${config.name}/${config.name}`;
}
