<p align="center"><img src=".github/banner.svg" alt="armada" width="100%"></p>

Run a command over many inputs at once, on Cloudflare Containers.

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

## Examples

```sh
# A flaky test, 20 times at once, in the commit's own environment
armada map --commit=HEAD --times=20 -- bun test tests/flaky.test.ts

# One task per line of urls.txt, each keeping the file it writes
armada map --items=urls.txt --output -- sh -c 'curl -sL {item} > {out}'
```

From code, after `bun add github:AshishKumar4/armada`:

```ts
import { connect } from 'armada';

const armada = connect();
const job = await armada.map({
  recipe: { setup: 'apt-get install -y curl imagemagick' },
  items: imageUrls,
  run: { command: ['sh', '-c', 'curl -sL {item} | convert - -resize 50% {out}'] },
  output: true,
});

for await (const outcome of job.outcomes()) {
  const png = await job.outputBytes(outcome.index);
}

await armada.map({ items: [1, 2, 3], handler: (n: number) => n * n });
```

| Placeholder | Becomes |
|---|---|
| `{item}` | The item's text, or its JSON. An object item's scalar keys fill placeholders of the same name. |
| `{index}` | The item's position. |
| `{out}` | The file a task writes when `output` is set. |
| `{files}` | The directory with the job's small `files`. |

An unknown placeholder is an error. An object item's numeric `weight` moves it up the queue.

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
    "key": ["bun.lock", "package.json"],
    "smoke": "bun --version"
  },
  "pool": 2,
  "size": "auto",
  "plan": { "command": ["echo", "{\"include\": [{\"name\": \"test\"}, {\"name\": \"typecheck\"}]}"] },
  "task": { "command": ["bun", "run", "{name}"], "verdict": false, "timeout": 600 }
}
```

The commit is uploaded from your machine, so private repos and unpushed commits work. Words after
`armada run HEAD --` go to the plan command, to run part of the matrix. Ctrl-C cancels the job.

| Field | Default | Meaning |
|---|---|---|
| `name` | | The project's slug. |
| `environment.base` | `cloudflare/debian-trixie` | The base image. Only Cloudflare-managed images start. |
| `environment.setup` | | A script in the commit, run as root once per environment. |
| `environment.install` | | A script in the commit, run as `ci` in the checkout once per environment. |
| `environment.key` | `[]` | Globs over the files whose content keys the environment, such as the lockfile. |
| `environment.smoke` | | A command that must exit 0 in the restored snapshot. |
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
armada status <job-id>
armada prune [--keep=3]
```

`armada --help` describes every option. `map` exits 1 if a task exits nonzero and 2 if a task could not run.

`armada deploy --name=<name>` deploys a second armada on the same account and prints the file that
`--connection=<file>` takes to point any command at it. `--vcpus=N` caps a deployment's fleet. All deployments on an
account share Cloudflare's 1,500 vCPUs.
