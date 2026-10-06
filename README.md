# armada

Fast, mappable compute on Cloudflare Containers. It maps a command, or a JavaScript handler, over many items. The
items run on a fleet of containers started from one environment snapshot, and each task's outcome streams back as it
lands. CI is one client of it: `armada run` proves a commit from the `.armada.json` it holds.

```
armada map [--env=<recipe.json>] --items=<file|-> [--pool=N] [--output] [--idempotent] [--timeout=s] -- <command with {item}>
armada run <commit|worktree> [--label=<text>]   exits 0 pass, 1 a red row, 2 not graded
armada status <job-id>
armada deploy --account=<id>                    with this machine's wrangler login
armada prune [--keep=3]                         needs ARMADA_REGISTRY_TOKEN (Containers: Edit)
```

## The SDK

```ts
import { connect } from 'armada';

const armada = connect();
const job = await armada.map({ recipe: { setup: 'apt-get install -y imagemagick' }, items: files, run: { command: ['convert', '{item}', '{out}'] }, output: true });

for await (const outcome of job.outcomes()) console.log(outcome.index, outcome.exitCode);
const summary = await job.summary();

await armada.map({ items: [1, 2, 3], handler: (n: number) => n * n });
```

A command's words are filled per item:

- `{item}` is the item's text, or its JSON.
- An object item's scalar keys fill placeholders of the same name.
- `{out}` is the file a task writes when `output` is set.
- `{files}` is the directory holding the job's small `files`.
- `{index}` is the item's position.

An unknown placeholder is an error, never an empty string. A handler is a function's source, called with the item
under `node`, and its return value is the task's output.

## How a job goes

1. **The environment.** A recipe is a base image started by name, the runner's own layer, a root `setup` script and
   a user `install` script. The runner's layer is tini, setpriv, the `ci` user, git 2.53, iproute2, strace and a
   compiler. Its key hashes the driver version, the recipe's text, the instance type and, for a repository recipe,
   the object ids of the commit's key files. So a changed script or lockfile means a new environment.
2. **Preparing it.** A new key is prepared once, on the `durable_object` scheduling policy, one phase per alarm:
   base, setup, receive (the commit, for a repository recipe), install, snapshot, then a verify start from the
   snapshot. Every later container starts from that snapshot.
3. **The queue.** The job's tasks are queued longest first, by an object item's numeric `weight`.
4. **The fleet.** Up to `pool` containers each pull task after task until the queue drains. Every command runs as
   the unprivileged user under tini, on fresh tmpfs mounts (`/tmp` and `/dev/shm` by default). The account-wide
   fleet holds concurrent vCPUs under `FLEET_VCPUS`, Cloudflare's ceiling of 1,500.
5. **Retries.** A task the infrastructure failed is run once more. That covers a container that never answered, a
   lost exec, and a container not heard from while it works. A task that exited is never run again; one that runs
   past `timeout` is killed and exits 124. With `idempotent`, an idle container may run a
   straggler a second time, keeping the first answer.
6. **Outcomes.** Each outcome (exit code, seconds, container, attempt, the output's tail) is an event on
   `/jobs/<id>/events`. A task's `{out}` and its gzipped log are kept in R2 for 7 days.

## `armada run` and `.armada.json`

A project's CI is two maps over one repository environment. The CLI reads `.armada.json` from the commit, so the
recipe that proves a commit is the one it holds, and packs the commit into R2:

- The first time an environment is prepared, the pack starts from the root.
- After that it carries only what the commit adds to the environment's commit.

Private trees and unpushed commits work, and the containers hold no credentials.

1. **The plan.** One task runs `plan.command` on the commit. It prints the tasks as a GitHub-Actions-shaped matrix,
   `{"include": [{...}, ...]}`.
2. **The tasks.** A second job maps `task.command` over the entries, filling it from each entry's keys.
3. **Grading.** Every task's verdict file is graded. Each row an entry names in `rows` must be reported exactly
   once, by that task, with a timing for each file it declares. Anything short of that exits 2. Otherwise each red
   row is printed with its output's tail.
4. **What is kept.** The collected verdict `{sha, part: "all", rows}` is stored at `/verdicts/<project>/<sha>`. Green
   rows' timings feed the next plan's `{timings}`: the median of each row's last five green runs. The report is
   written under `~/.local/state/armada/runs/`.

| Field | Meaning |
|---|---|
| `name` | The project's slug; it scopes environments, packs, timings and verdicts. |
| `environment.base` | A Debian or Ubuntu image the runtime starts by name. Default `cloudflare/debian-trixie`. |
| `environment.setup` | A script in the commit, run as root in the checkout, once per environment. |
| `environment.install` | A script in the commit, run as the user in the checkout, once per environment. |
| `environment.key` | Globs (`*`, `?`, `**`) over the commit's paths whose content keys the environment. |
| `environment.smoke` | A user command run after the snapshot is restored; it must exit 0. |
| `checkout` | Where the commit is checked out. Default `/home/ci/work/<name>/<name>`, as on a GitHub runner. |
| `history` | `full` (default) carries the whole history; `commit` carries only the tree. |
| `env` | The environment the plan and the tasks run under; `{workdir}` is the checkout. |
| `tmpfs` | Fresh tmpfs mounts before each command. Default `/tmp`, `/dev/shm`. |
| `instance` | Default `standard-4` (4 vCPU, 12 GiB, 20 GB). |
| `pool` | The most containers the task job runs at once. Default 40. |
| `target` | Seconds, given to the plan as `{target}`. Default 300. |
| `plan.command` | Prints the matrix. Placeholders: `{target}`, `{timings}` (a file of `{"rows": {...}, "files": {...}}`). |
| `task.command` | Each entry's command, filled from its keys; `{out}` is its verdict file. |
| `task.name` | The entry key that names a task. Default `name`, else the first string-valued key. |
| `task.verdict` | `true` (default): the command writes `{"rows": [{"name" or "run", "exitCode", "seconds", "output", "timings"}]}` to `{out}`. `false`: its exit code is the task's one row. |
| `task.idempotent` | Whether a straggling task may be run again. Default `false`. |
| `task.timeout` | A task's own bound, in seconds. Default 3600. |

## Deploying

`armada deploy --account=<id>` does four things:

1. It creates the `armada-artifacts` bucket. Packs and job artifacts expire after 7 days; verdicts are kept.
2. It deploys the Worker.
3. It sets its bearer token.
4. It writes `~/.config/armada/connection.json`.

There is no image to build or roll out. `ARMADA_URL` and `ARMADA_TOKEN` override the connection file.

## Container findings

These shape the runner's layer and how it runs a command:

- The exec `user` option fails with "internal error", so commands drop privileges with `setpriv`.
- An exec given a large stdin stream fails, so bodies are piped in.
- A container restored from a snapshot needs its hostname set.
- The container's `/tmp` reports no free inodes and `/dev/shm` is root-only, so fresh tmpfs is mounted on both.
- Daemons a task leaves behind are reaped by running under tini.
- Trixie's git 2.47 lacks `path=` in `rev-list --objects -z`, so git 2.53 is built.
