<p align="center"><img src=".github/banner.svg" alt="armada" width="100%"></p>

Run a command or a TypeScript function over many inputs at once, on Cloudflare Containers.

The CLI and `armada run` run any command, so a task can be written in any language its environment installs. Only the
SDK's typed functions are TypeScript.

For example, you can use it for CI. It takes about 7 seconds to spawn 100 containers and run a 3-second command on
each, all in parallel.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh
armada deploy
armada map --times=3 --json -- echo hello {item}
```

The script installs [Bun](https://bun.sh) if it's missing and puts armada in `~/.armada`. `armada deploy` opens a
Cloudflare login in your browser (or uses `CLOUDFLARE_API_TOKEN`) and deploys armada to your account. Containers need
the Workers Paid plan.

## How a job runs

<p align="center"><img src=".github/job.svg" alt="A recipe becomes a snapshot once; a fleet of containers started from it pulls tasks from one queue, and each result streams back." width="100%"></p>

Each task runs as the user `ci`, in a cgroup of its own (`$ARMADA_CGROUP`), with fresh tmpfs on `/tmp` and `/dev/shm`.
Anything a task leaves running is stopped before the next task starts.

## Architecture

<p align="center"><img src=".github/arch.svg" alt="Clients call the Worker's bearer API. The Worker keeps its state in Durable Objects: ArmadaJob, ArmadaVessel, ArmadaEnvironments, ArmadaPreparer, ArmadaTimings and ArmadaFleet. Vessels start containers from a snapshot, the preparer from the base image, and packs, bundles, outputs, logs and verdicts live in R2." width="100%"></p>

Every client speaks one bearer API to armada's Worker, which keeps its state in Durable Objects. ArmadaJob holds a
job's queue and its outcome events. One ArmadaVessel per container pulls task after task on alarms, and holds its
vCPUs in ArmadaFleet before its container starts. ArmadaFleet belongs to one deployment, so `--vcpus` caps only that
deployment. Packs, bundles, outputs, logs and verdicts live in R2.

### The preparer

Every container of a job has to be the same, and has to start with its tools already installed. So an environment is
prepared once, and every container after that starts from its snapshot. One ArmadaPreparer per environment key starts
a container from the base image, adds armada's runner layer, runs the recipe's `setup` as root, checks out the commit
for a repository, runs `install` as the user, and snapshots the container. That takes a few minutes. A container then
starts from the snapshot in 0.2 to 2 seconds. The key hashes the runner layer's version, the base image, the two
scripts' text, the size and, for a repository, the content of the files `environment.key` lists. Changing any of them
prepares a new environment, and an unchanged recipe reuses its snapshot. If a snapshot does not start, the job's
containers fail, and the job names the environment once.

## Examples

```sh
# A flaky test, 20 times at once, in the commit's own environment
armada map --commit=HEAD --times=20 -- bun test tests/flaky.test.ts

# One task per line of urls.txt, each keeping the file it writes
armada map --items=urls.txt --output -- sh -c 'curl -sL {item} > {out}'
```

| Placeholder | Becomes |
|---|---|
| `{item}` | The item's text, or its JSON. An object item's scalar keys fill placeholders of the same name. |
| `{index}` | The item's position. |
| `{out}` | The file a task writes when `output` is set. |
| `{files}` | The directory with the job's small `files`. |

The CLI and `.armada.json` fill these in a command's words; an unknown one is an error. An object item's numeric
`weight` moves it up the queue.

## From TypeScript

After `bun add github:AshishKumar4/armada`, a project names itself and the folder its tasks live in:

```ts
// armada.config.ts
import { defineConfig } from 'armada';

export default defineConfig({ project: 'media', tasks: ['armada'] });
```

```ts
// armada/thumbnails.ts
import { recipe, sh, task } from 'armada';
import * as v from 'valibot';

export const imaging = recipe.debian().apt('curl', 'imagemagick').size('small');

// A command: the body returns sh, which escapes every ${} as one word. `out` is the file the task answers with.
export const thumbnail = task({
  id: 'thumbnail',
  recipe: imaging,
  output: 'bytes',
  run: (url: string, { out }) => sh`curl -sL ${url} | convert - -resize 50% ${out}`,
});

// A function: the body's value is the answer, checked by its schema in the container.
export const measure = task({
  id: 'measure',
  recipe: imaging,
  input: v.object({ url: v.pipe(v.string(), v.url()) }),
  output: v.object({ bytes: v.number(), type: v.string() }),
  run: async ({ url }) => {
    const response = await fetch(url);

    return { bytes: (await response.arrayBuffer()).byteLength, type: response.headers.get('content-type') ?? '' };
  },
});
```

```ts
import { measure, thumbnail } from './armada/thumbnails';

const sizes = await measure.map(rows);                  // { bytes: number; type: string }[], in input order

for await (const result of thumbnail.stream(urls)) {    // in the order they land
  if (result.ok) await Bun.write(`thumbs/${String(result.index)}.png`, result.value);
  else console.error(result.item, result.kind);
}

const one = await thumbnail.run(urls[0]);               // one item, on one container
const here = await thumbnail.local(urls[0]);            // one item, on this machine, no container
```

- `armada push` bundles every task the project's folders export and sends it. A task runs by its `id`, which one
  project owns in a deployment; a push drops the ids its project no longer exports. A script run inside the project
  pushes it once by itself, so `bun run sweep.ts` needs no separate step. An app deployed elsewhere runs `armada push`
  in its own release. `armada dev` pushes again on each save.
- `.map` returns the values in input order, or throws a `MapError` holding every result. `.stream` returns the job,
  whose results arrive as they land, with `ordered()`, `settled()`, `cancel()` and `outputStream(i)`.
- A result has `ok`. When it is false, `kind` says why: `error` (the body threw, its value failed its schema, or its
  command exited nonzero), `timeout`, `cancelled` or `lost`. Each result carries its `meta`: seconds, container, exit
  code, the tail of its log, and its peak memory and CPU.
- A recipe is built a step at a time: `recipe.debian()` or `recipe.from(image)`, then `.apt(...packages)` and
  `.setup(script)` as root, `.install(script)` as the user, and `.size(size)`. Each step returns a new recipe, and the
  environment's key hashes the scripts the steps make. `recipe({ setup, install, size })` takes them whole.
- A body can also run commands and answer with a value: `` (await sh`git rev-parse HEAD`.text()).trim() ``.
  `` sh.raw`...` `` interpolates without escaping, for a script that is itself shell.
- Schemas are any [Standard Schema](https://standardschema.dev): valibot, zod or arktype. An item is checked before
  it is sent, and a value in the container before it counts as ok.
- Items and values are plain JSON, or bytes for a value. The types refuse a `Date`, a `Map`, `any` or `unknown` at
  the task's definition.
- An output may be any size up to 4.995 GiB, R2's limit for one upload. `job.outputStream(i)` downloads one too large
  to hold in memory.
- `map(items, { pool, label, env, files, tmpfs })` sets a job's options. A task takes `timeout`, and `speculative`,
  which lets an idle container run a straggler again.

## CI with `armada run`

<p align="center"><img src=".github/ci.svg" alt="armada run reads .armada.json from the commit, runs the plan, runs one task per matrix entry, and grades every row." width="100%"></p>

```sh
armada run HEAD
```

armada tests itself this way. Its `.armada.json`:

```json
{
  "name": "armada",
  "environment": {
    "setup": "ci/setup.sh",
    "install": "ci/install.sh",
    "key": ["bun.lock", "package.json"]
  },
  "pool": 2,
  "size": "auto",
  "plan": { "command": ["echo", "{\"include\": [{\"name\": \"test\"}, {\"name\": \"typecheck\"}]}"] },
  "task": { "command": ["bun", "run", "{name}"], "verdict": false, "timeout": 600 }
}
```

The commit is uploaded from your machine, so private repos and unpushed commits work. Words after
`armada run HEAD --` go to the plan command, to run part of the matrix. Ctrl-C cancels the job.

A run of the whole matrix stores its verdict under the commit. `armada verdict <commit>` prints it and exits 0 when
every row is green, 1 when a row is red and 2 when the commit has none, so a hook or a deploy can take a commit's
proof without running it again.

| Field | Default | Meaning |
|---|---|---|
| `name` | | The project's slug. |
| `environment.base` | `cloudflare/debian-trixie` | The base image. Only Cloudflare-managed images start. |
| `environment.setup` | | A script in the commit, run as root once per environment. |
| `environment.install` | | A script in the commit, run as `ci` in the checkout once per environment. |
| `environment.key` | `[]` | Globs over the files whose content keys the environment, such as the lockfile. |
| `checkout` | `/home/ci/work/<name>/<name>` | Where the commit is checked out. |
| `history` | `full` | `commit` checks out the tree without its history. |
| `env` | `{}` | Environment variables for the plan and tasks. `{workdir}` is the checkout. |
| `tmpfs` | `["/tmp", "/dev/shm"]` | Paths that get a fresh tmpfs in each container. |
| `size` | `medium` | The container size, from the table below, or `auto`. |
| `pool` | `40` | The most containers the tasks run on. The plan's `weight`s or past timings can make it fewer. |
| `target` | `300` | Seconds per task the plan aims for, passed as `{target}`. |
| `plan.command` | | Prints `{"include": [...]}`. Gets `{target}`, and `{timings}`, a file of past timings. |
| `task.command` | | Runs one matrix entry. The entry's keys fill its placeholders. |
| `task.name` | `name` | The entry key that names a task. |
| `task.verdict` | `true` | The task writes `{"rows": [{"name", "exitCode", "seconds", "output"}]}` to `{out}`. With `false`, its exit code is its one row. |
| `task.speculative` | `false` | Lets an idle container run a straggler again. |
| `task.timeout` | `3600` | A task's limit, in seconds. |

A matrix entry may list the `rows` its task must report.

| Size | vCPU | Memory | Cloudflare instance type |
|---|---|---|---|
| `micro` | 1/2 | 4 GiB | `standard-1` |
| `mini` | 1 | 6 GiB | `standard-2` |
| `small` | 2 | 8 GiB | `standard-3` |
| `medium` | 4 | 12 GiB | `standard-4` |

Cloudflare has no larger container. With `"size": "auto"`, each run takes the smallest size that the last five runs'
tasks fill to three quarters at most, in peak memory and in average busy cores. A new size prepares its own environment
once.

## Commands

```
armada deploy [--account=<id>] [--name=<name>] [--vcpus=N]
armada map [--env=<recipe.json> | --commit=<rev>] (--times=N | --items=<file|->) [--size=<size>] [--pool=N] [--timeout=S] [--output] [--speculative] [--json] -- <command>
armada run <commit|worktree> [--label=<text>] [-- <plan args>]
armada verdict <commit|worktree> [--json]
armada push
armada dev
armada status <job-id>
armada prune [--keep=3]
```

`armada --help` describes every option. `map` exits 1 if a task exits nonzero and 2 if a task could not run.

`armada deploy` over a running armada first stops it taking new jobs and waits for its open ones to finish, so a
deploy never cuts a job short. Until it is done, a new job is refused with a message to run again. A client and a
Worker of different versions refuse each other's requests and say which one to update.

`armada deploy --name=<name>` deploys a second armada on the same account and prints the file that
`--connection=<file>` takes to point any command at it. `--vcpus=N` caps only that deployment's fleet.
