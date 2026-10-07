# armada

Run a command over many inputs at once, on Cloudflare Containers.

I wanted one tool for fast, parallel compute that all my projects could share. You give armada a list of items and a
command. It starts a fleet of containers from a prepared snapshot, each container pulls items until the list is done,
and every result streams back as it lands. CI is the first thing I use it for, but it isn't the only thing it's for.

Some numbers from Kinu, its first user:

- Kinu's full CI tier, 90 rows, finishes in about 17 minutes on 60 containers.
- A container started from a snapshot answers in 0.2 to 2.3 seconds.
- Running Kinu's heap gate 6 times in parallel took 137 seconds.

## Examples

Run a flaky test 20 times at once, each run in its own clean container, in the commit's own environment:

```sh
armada map --commit=HEAD --times=20 -- bun test tests/local-session-turns.test.ts
```

Each run prints one JSON line with its exit code and the tail of its output. This is how Kinu found a test that
deadlocked on itself in 2 runs out of 8.

Resize a pile of images straight from their URLs, and keep each result:

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
  // write it, upload it, whatever you need
}
```

Run a JavaScript function over your items instead of a command:

```ts
await armada.map({ items: [1, 2, 3], handler: (n: number) => n * n });
```

Prove a commit with your project's CI, from the `.armada.json` in that commit:

```sh
armada run HEAD
```

It exits 0 when every row is green, 1 when a row is red, and 2 when the run can't be graded. Interrupting `run` or `map`
(Ctrl-C, or a cancelled CI job) cancels the job, so its containers stop.

## Commands

```
armada map [--env=<recipe.json> | --commit=<rev>] (--items=<file|-> | --times=N) [--pool=N] [--output] [--idempotent] [--timeout=s] -- <command>
armada run <commit|worktree> [--label=<text>] [-- <plan words>]
armada status <job-id>
armada deploy --account=<id>      uses this machine's wrangler login
armada prune [--keep=3]           needs ARMADA_REGISTRY_TOKEN (Containers: Edit)
```

`--items` takes a JSON array or one item per line. `--times=N` maps over 1 to N.

Placeholders in a command are filled per item:

| Placeholder | Becomes |
|---|---|
| `{item}` | The item's text, or its JSON. An object item's scalar keys also fill placeholders of the same name. |
| `{out}` | The file the task writes when `output` is set. |
| `{files}` | The directory holding the job's small `files`. |
| `{index}` | The item's position. |

An unknown placeholder is an error, never an empty string. A handler is a function's source, called with the item
under `node`; its return value is the task's output.

## How a job runs

1. **Environment.** A recipe is a base image, armada's runner layer, a root `setup` script and a user `install`
   script. The runner layer adds tini, setpriv, a `ci` user, git 2.53, iproute2, strace and a compiler. The
   environment's key hashes the runner version, the recipe text, the instance type and, for a repository, the content
   of the files you list. Change a script or a lockfile and you get a new environment.
2. **Snapshot.** A new environment is prepared once, on the `durable_object` scheduling policy: base, setup, the commit,
   install, snapshot, then a test start from the snapshot. Every container after that starts from the snapshot.
3. **Queue.** Tasks are queued longest first, by an object item's numeric `weight`.
4. **Fleet.** Up to `pool` containers each pull task after task until the queue is empty. Every command runs as the
   unprivileged user under tini, on fresh tmpfs mounts (`/tmp` and `/dev/shm` by default). The whole account's fleet
   stays under `FLEET_VCPUS`, which is Cloudflare's ceiling of 1,500 vCPUs.
5. **Retries.** A task the infrastructure dropped runs once more: a container that never answered, a lost exec, or a
   container that went quiet mid-task. A task that exited never runs again. A task past its `timeout` is killed and
   exits 124. With `idempotent`, an idle container may run a straggler a second time, and the first answer wins.
6. **Results.** Each outcome (exit code, seconds, container, attempt, the tail of its output) is an event on
   `/jobs/<id>/events`. A task's `{out}` file and its gzipped log stay in R2 for 7 days.

## CI with `armada run`

A project's CI is two maps over its repository environment. The CLI reads `.armada.json` from the commit itself, so the
recipe always matches the code it tests. It packs the commit into R2: the first pack for an environment starts from
the root, later ones carry only what changed (or start from the root again in a clone that lacks the environment's
commit, such as a shallow CI checkout). Private repositories and unpushed commits work, and the containers hold
no credentials.

1. **Plan.** One task runs `plan.command`, which prints the tasks as a GitHub Actions style matrix,
   `{"include": [{...}, ...]}`. Words after `armada run <commit> --` are added to it, to narrow a run to a tier or a
   few rows.
2. **Tasks.** A second job runs `task.command` for each entry, filled from the entry's keys. Each task's line names its
   red rows as it lands.
3. **Grading.** Every row an entry names must be reported exactly once, by that task, with a timing for each file it
   declares. Anything less exits 2. A task that exits nonzero fails every row it reported green.
4. **Records.** The verdict `{sha, part: "all", rows}` is stored at `/verdicts/<project>/<sha>`, unless the run was
   narrowed. Green rows' timings
   feed the next plan as the median of each row's last five green runs. A report goes to
   `~/.local/state/armada/runs/`.

| Field | Meaning |
|---|---|
| `name` | The project's slug. It scopes environments, packs, timings and verdicts. |
| `environment.base` | A Cloudflare-managed image the runtime starts by name. Default `cloudflare/debian-trixie`, which is the only one today: the runtime refuses Docker Hub images and pushed ones the Worker's configuration does not name. |
| `environment.setup` | A script in the commit, run as root in the checkout, once per environment. |
| `environment.install` | A script in the commit, run as the user in the checkout, once per environment. |
| `environment.key` | Globs (`*`, `?`, `**`) over the commit's paths whose content keys the environment. |
| `environment.smoke` | A command run after the snapshot is restored. It must exit 0. |
| `checkout` | Where the commit is checked out. Default `/home/ci/work/<name>/<name>`, as on a GitHub runner. |
| `history` | `full` (default) carries the whole history; `commit` carries only the tree. |
| `env` | The environment the plan and tasks run under; `{workdir}` is the checkout. The job keeps it only until it ends, and no container's object stores it. |
| `tmpfs` | Fresh tmpfs mounts before each command. Default `/tmp`, `/dev/shm`. |
| `instance` | Default `standard-4` (4 vCPU, 12 GiB, 20 GB). |
| `pool` | The most containers the task job runs at once. Default 40. |
| `target` | Seconds per task the plan aims for, passed as `{target}`. Default 300. |
| `plan.command` | Prints the matrix. Placeholders: `{target}`, `{timings}` (a file of `{"rows": {...}, "files": {...}}`). |
| `task.command` | Each entry's command; `{out}` is its verdict file. |
| `task.name` | The entry key that names a task. Default `name`, else the first string-valued key. |
| `task.verdict` | `true` (default): the command writes `{"rows": [{"name" or "run", "exitCode", "seconds", "output", "timings"}]}` to `{out}`. `false`: its exit code is the task's one row. |
| `task.idempotent` | Whether a straggling task may run again. Default `false`. |
| `task.timeout` | A task's limit, in seconds. Default 3600. |

armada proves itself the same way: its own `.armada.json` runs `bun test` and the typecheck, each as one row.

## Deploying

`armada deploy --account=<id>` creates the `armada-artifacts` bucket (packs and artifacts expire after 7 days; verdicts
stay), deploys the Worker, sets its bearer token and writes `~/.config/armada/connection.json`. There is no image to
build. `ARMADA_URL` and `ARMADA_TOKEN` override the connection file.

## Things I learned about the containers

These decided how the runner layer works:

- The exec `user` option fails with "internal error", so commands drop privileges with `setpriv`.
- An exec given a large stdin stream fails, so bodies are piped in instead.
- A container restored from a snapshot needs its hostname set.
- `/tmp` reports no free inodes and `/dev/shm` is root-only, so armada mounts fresh tmpfs on both.
- Daemons a task leaves behind are reaped by running under tini.
- Trixie's git 2.47 lacks `path=` in `rev-list --objects -z`, so the layer builds git 2.53.
