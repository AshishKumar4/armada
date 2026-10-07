<p align="center"><img src=".github/banner.svg" alt="armada" width="100%"></p>

Run a command or a TypeScript function over many inputs at once, on Cloudflare Containers.

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

| Placeholder | Becomes |
|---|---|
| `{item}` | The item's text, or its JSON. An object item's scalar keys fill placeholders of the same name. |
| `{index}` | The item's position. |
| `{out}` | The file a task writes when `output` is set. |
| `{files}` | The directory with the job's small `files`. |

The CLI and `.armada.json` fill these in a command's words; an unknown one is an error. An object item's numeric
`weight` moves it up the queue.

## From TypeScript

After `bun add github:AshishKumar4/armada`:

```ts
// tasks.ts
import { cmd, fn, recipe } from 'armada';
import * as v from 'valibot';

export const imaging = recipe({ setup: 'apt-get install -y curl imagemagick', size: 'small' });

// A function. Its module is bundled with what it imports and run in each container, so it is exported.
export const measure = fn(import.meta, {
  recipe: imaging,
  input: v.object({ url: v.pipe(v.string(), v.url()) }),
  output: v.object({ bytes: v.number(), type: v.string() }),
}, async ({ url }) => {
  const response = await fetch(url);

  return { bytes: (await response.arrayBuffer()).byteLength, type: response.headers.get('content-type') ?? '' };
});

// A command. Its argv is built per item here, so an item is never pasted into a shell string.
export const thumbnail = cmd(imaging, (url: string) => ['sh', '-c', 'curl -sL "$1" | convert - -resize 50% "$ARMADA_OUT"', 'thumbnail', url], {
  output: 'bytes',
});
```

```ts
import { measure, thumbnail } from './tasks';

const sizes = await measure.map(rows).values();     // { bytes: number; type: string }[], in input order

for await (const result of thumbnail.map(urls)) {    // in the order they land
  if (result.kind === 'ok') await Bun.write(`thumbs/${result.index}.png`, result.value);
  else console.error(result.item, result.kind);
}
```

- A result's `kind` is `ok`, `error` (the function threw, its value failed its schema, or the command exited
  nonzero), `timeout`, `cancelled` or `lost`. Each carries its `meta`: seconds, container, exit code, the tail of its
  log, and its peak memory and CPU.
- `job.ordered()` yields results in input order, `job.settled()` returns them all, and `job.values()` returns the
  values or throws a `MapError` holding every result. `task.run(item)` runs one item.
- An output may be any size up to 4.995 GiB, R2's limit for one upload. `job.outputStream(i)` downloads one too large
  to hold in memory.
- Items may be an array, or an iterable or async iterable that streams into the job as it yields.
- Schemas are any [Standard Schema](https://standardschema.dev): valibot, zod or arktype. An item is checked before
  it is sent, and a value in the container before it counts as `ok`.
- Items and values are plain JSON, or bytes for a value; the types refuse a `Date` or a `Map`.
- `map(items, { pool, label, env, files, tmpfs })` sets a job's options; `fn` and `cmd` take `timeout` and
  `speculative`, which lets an idle container run a straggler again.

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
armada status <job-id>
armada prune [--keep=3]
```

`armada --help` describes every option. `map` exits 1 if a task exits nonzero and 2 if a task could not run.

`armada deploy` over a running armada first stops it taking new jobs and waits for its open ones to finish, so a
deploy never cuts a job short. Until it is done, a new job is refused with a message to run again. A client and a
Worker of different versions refuse each other's requests and say which one to update.

`armada deploy --name=<name>` deploys a second armada on the same account and prints the file that
`--connection=<file>` takes to point any command at it. `--vcpus=N` caps a deployment's fleet. All deployments on an
account share Cloudflare's 1,500 vCPUs.
