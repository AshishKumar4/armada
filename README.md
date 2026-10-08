<p align="center"><img src=".github/banner.svg" alt="armada" width="100%"></p>

armada runs a command or a TypeScript function over many inputs at once, on Cloudflare Containers in your own account.

- 100 videos re-encoded to 720p in 22 s on 100 containers. One container took 12 to 14 minutes for the same 100.
- A 90-row CI suite ran in 7 min 19 s on 13 containers. Its GitHub Actions matrix of 15 jobs took 13 min 2 s.
- One `true` task came back 2.5 s after it was sent.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh
armada deploy
armada map --times=3 --json -- echo hello {item}
```

The script installs [Bun](https://bun.sh) if it's missing and puts armada in `~/.armada`. `armada deploy` logs in to
Cloudflare in your browser, or uses `CLOUDFLARE_API_TOKEN`. Containers need the Workers Paid plan.

## How it works

<p align="center"><img src=".github/arch.svg" alt="You send a job from the CLI, the TypeScript SDK or armada run. A Worker in your Cloudflare account queues its items. An environment built once from your recipe is snapshotted. Containers start from the snapshot and pull tasks until the queue is empty. Results stream back, with outputs and logs in R2." width="100%"></p>

armada is a Worker, a few Durable Objects and an R2 bucket in your account, so your code and data stay there.

1. armada prepares each environment once. It starts a container from the recipe's base image, runs `setup` as root
   and `install` as the user, and snapshots the result; the ffmpeg recipe's took 5.6 minutes. A changed recipe, or a
   changed file in `environment.key`, prepares a new one.
2. Containers start from the snapshot, in as little as 0.2 s, with a fresh tmpfs on `/tmp` and `/dev/shm`.
3. Each container pulls task after task from the job's one queue until it is empty, so no container waits behind
   another's slow task. Items with a higher `weight` start first.
4. Results stream back as they land. A small output rides in the result; a large one, and every log, goes to R2.

Each task runs as the user `ci`, in its own cgroup, and anything it leaves running is stopped before the next task.
Tasks that run one after another in a container share its `/tmp`. A task the platform loses runs again, up to three attempts. Each task gets exactly one recorded outcome, but a cut-off
attempt may already have done its work, so a task should be safe to run twice.

A deploy over a running armada keeps its jobs running. Six deploys in two minutes, over 200 one-minute tasks, cut no
task and refused no job. Only a deploy that changes the wire protocol, or one run with `--drain`, waits for open jobs
first, and that pause lapses after 10 minutes if the deploy dies.

## Measured

Each figure is from one run on 2026-10-07. The command is in the table, so you can run it on your own deployment.

| Workload | armada | Comparison |
|---|---|---|
| 100 videos to 720p ([`examples/video-720p`](examples/video-720p)) | 21.5 s and 22.2 s on 100 `small` containers (`bun bench.ts 100`) | 705 s and 814 s in sequence on one `small` container (`bun bench.ts 100 serial`) |
| A 90-row CI suite ([Kinu](https://github.com/AshishKumar4/kinu) at `0b74ff100`) | 7 min 19 s on 13 `medium` containers (`armada run 0b74ff100`) | 13 min 2 s on its GitHub Actions matrix of 15 jobs ([run 37672204809](https://github.com/AshishKumar4/kinu/actions/runs/37672204809)) |
| One task from a prepared snapshot | 2.5 s from sending it to its answer (`armada map --times=1 --size=micro -- true`) | |
| 100 three-second tasks | 9.1 s and 11.4 s on 100 `micro` containers (`armada map --times=100 --pool=100 --size=micro -- sleep 3`) | 300 s of work |
| 100 cached video answers | 5.6 s and 5.7 s, with no container started (`bun bench.ts 100 cached`) | 24.0 s and 28.3 s computing them |

Each video task makes a 10-second 1080p clip from ffmpeg's test sources, then re-encodes it to 720p H.264. Wall times
include downloading every result. Asked for 100 containers at once, armada had all 100 started within 3.7 s and 8.7 s
in two runs of three-second tasks, and within 16 s in the video run. The CI suite ended 2 s after its longest row
(442 s against 440 s), because its plan weighs each row by its measured seconds.

## Compared with others

Each cell comes from the tool's own documentation, read on 2026-10-07, except armada's start time, measured above.

| | armada | Modal | Ray | Lithops | Coiled | Trigger.dev | GitHub Actions matrix |
|---|---|---|---|---|---|---|---|
| Runs on | Cloudflare Containers in your account | Modal's cloud | your cluster | your cloud's functions or VMs | VMs in your AWS or GCP account | Trigger.dev's cloud, or self-hosted | GitHub's runners, or your own |
| Tasks in | any language (CLI); TypeScript (SDK) | Python | Python | Python | Python; any command (batch CLI) | TypeScript | any language (YAML) |
| Typed results | yes; optional schemas check items and values | Python hints | Python hints | no | Python hints | yes; optional input schemas | strings |
| Start | one `true` task, end to end: 2.5 s (measured) | container boot about 1 s, plus imports | depends on the cluster | depends on the backend | 1 to 2 min for the first VM | not published | not published |
| Parallel limit | 375 containers a job; 1,500 vCPUs a deployment by default, within your account's container limits | 100 (Starter) or 5,000 (Team) containers a workspace; 1,000 inputs at once per map | your cluster | provider quotas | 500 VMs (functions) and 1,000 (batch) by default | 20, 50 or 200+ runs by plan | 256 jobs per matrix; 20 to 500 standard-runner jobs at once by plan |
| GPUs | no | yes | yes | depends on the backend | yes | no | larger runners, on Team and Enterprise plans |
| You pay | the Workers Paid plan, plus container, Worker, Durable Object and R2 usage | per second, plus a plan | your machines | your cloud | your cloud, plus $0.05 per CPU-hour | per run and per machine-second | per minute on private repositories |

armada has no GPUs, because Cloudflare Containers have none, and its largest container is 4 vCPU and 12 GiB. It has
no Python SDK yet; Python runs through the CLI and `armada run`, like any command. It runs only on Cloudflare.

## From the command line

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

An unknown placeholder is an error. An object item's numeric `weight` moves it up the queue. `map` exits 1 if a task
exits nonzero and 2 if a task could not run.

### Gangs

An object item's `gang` runs it on that many containers at once, for a program that spans hosts, such as a multi-host
JAX run. Each rank gets `ARMADA_RANK` and `ARMADA_WORLD`, and reaches rank `r` as host `rank<r>` (127.0.1.`r+1`) on any
port it listens on. jax.distributed's coordinator at `rank0:<port>` and gloo's collectives work over it unchanged.

```sh
echo '[{"gang": 2}]' | armada map --items=- -- sh -c 'python3 train.py --rank $ARMADA_RANK --coordinator rank0:8476'
```

The gang starts once every rank has a container. A rank lost to the platform loses the whole gang, which runs again
as one task. The task's outcome is its first failing rank's, else rank 0's. Containers have no inbound address, so
ranks connect through the Worker: about 5 ms a round trip and 40 to 90 MB/s a connection, at 2 to 64 ranks. That suits
tests and coordination, not bandwidth-bound training. A connection to a port nothing listens on yet opens and then
closes at once, so a client retries it as it would a refused one. One whose WebSocket the network drops goes on over
another, the program seeing nothing of it, if the far end's vessel still holds it, for up to a minute.

## From TypeScript

This example reads each video's length and resolution, then re-encodes every video to 720p, each on its own container.

Add armada with `bun add github:AshishKumar4/armada`. `armada.config.ts` names the project and its tasks' folder:

```ts
// armada.config.ts
import { defineConfig } from 'armada';

export default defineConfig({ project: 'media', tasks: ['armada'] });
```

```ts
// armada/video.ts
import { recipe, sh, task } from 'armada';
import * as v from 'valibot';

export const media = recipe.debian().apt('ffmpeg').size('small');

// Re-encode one video to 720p H.264. sh passes ${url} and ${out} as single words, so nothing needs quoting.
export const transcode = task({
  id: 'transcode',
  recipe: media,
  output: 'bytes',
  run: (url: string, { out }) =>
    sh`ffmpeg -loglevel error -i ${url} -vf scale=-2:720 -c:v libx264 -preset veryfast -c:a aac -f mp4 ${out}`,
});

// Read a video's length and resolution with ffprobe. The schema checks the answer inside the container.
export const probe = task({
  id: 'probe',
  recipe: media,
  output: v.object({ seconds: v.number(), width: v.number(), height: v.number() }),
  run: async (url: string) => {
    const info = JSON.parse(await sh`ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json ${url}`.text());

    return { seconds: Number(info.format.duration), width: Number(info.streams[0].width), height: Number(info.streams[0].height) };
  },
});
```

```ts
// encode.ts
import { probe, transcode } from './armada/video';

const videos = (await Bun.file('videos.txt').text()).split('\n').filter(Boolean);

const infos = await probe.map(videos); // { seconds, width, height }[], in input order
console.log(`${videos.length} videos, ${Math.round(infos.reduce((sum, info) => sum + info.seconds, 0))} seconds in all`);

for await (const result of transcode.stream(videos)) { // each file as soon as its container finishes
  if (result.ok) await Bun.write(`720p/${String(result.index)}.mp4`, result.value);
  else console.error(`${result.item}: ${result.kind}`);
}
```

With two 10-second test videos in `videos.txt`, `bun encode.ts` printed `2 videos, 20 seconds in all` and wrote two
1280x720 files.

- `.map` returns values in input order and throws a `MapError` if any item fails. `.stream` yields each result as it
  lands. `.run` runs one item on a container, and `.local` runs it on this machine.
- A failed result's `kind` is `error`, `timeout`, `cancelled` or `lost`. Every result's `meta` has its seconds, exit
  code, log tail, and peak memory and CPU.
- `armada push` uploads the project's tasks and drops the ones it no longer exports. A script in the project pushes on
  its first run, and `armada dev` pushes on every save.
- A recipe is `recipe.debian()` or `recipe.from(image)`, then `.apt()`, `.setup()`, `.install()` and `.size()`. Each
  container also loads the task's file, so a recipe that reads local files goes in a function, `recipe: () => ...`,
  which runs only on the machine that starts the job.
- `sh` passes each `${}` as one word. `` sh.raw`...` `` doesn't escape, for a script that is itself shell.
- Schemas can be valibot, zod or arktype (any [Standard Schema](https://standardschema.dev)). Items are checked before
  they're sent, and values inside the container. Items and values are plain JSON, or bytes for a value; a `Date`, a
  `Map`, `any` or `unknown` is a type error.
- An output can be up to 4.995 GiB, R2's limit for one upload, and `job.outputStream(i)` streams it. A 336 MB tarball
  built as one task came back as one output in 41 s, start to file.
- `map(items, { pool, label, env, files, tmpfs })` sets a job's options. A task takes `timeout`, `speculative` to
  let an idle container rerun a straggler, and `hedge` to run that many of the heaviest items twice from the start;
  either way the first answer is kept.
- `retries` reruns an item only for the failures you name. With `retries: { attempts: 3, backoffSeconds: 5,
  exitCodes: [75], errors: ['FetchError'] }`, an item that exits 75 or throws a `FetchError` runs up to three times,
  waiting 5 s, then 10 s. Any other failure is final.
- `secrets` gives a task values kept out of your code. `echo "$KEY" | armada secret set OPENAI_API_KEY` stores one, and
  a task with `secrets: ['OPENAI_API_KEY']` reads `context.secrets.OPENAI_API_KEY`; a command gets it in its
  environment. Reading a secret the task didn't name is a type error, no call reads a value back, and each value of 4
  bytes or more shows as `***` in logs. `.local` reads secrets from your environment.
- `cache: { days: 7 }` keeps each green answer for a week, keyed by the task, the item, the recipe and the pushed task
  files. An item answered before comes back at once with `meta.cached`, and no container starts. Use it only for a
  task whose answer its item decides.

## CI with `armada run`

<p align="center"><img src=".github/ci.svg" alt="armada run reads .armada.json from the commit, runs the plan, runs one task per matrix entry, and grades every row." width="100%"></p>

```sh
armada run HEAD
```

`armada run` uploads the commit from your machine, so private repos and unpushed commits work. It reads the commit's
`.armada.json`, runs the plan command, and runs one task per matrix entry. armada tests itself this way:

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

Words after `armada run HEAD --` go to the plan command, to run part of the matrix. `--secrets=A,B` gives one run's
tasks those secrets, for a narrowed run whose credentials the whole matrix must not see. Ctrl-C cancels the job.

A run of the whole matrix stores its verdict under the commit. `armada verdict <commit>` prints it and exits 0 when
every row is green, 1 when a row is red and 2 when the commit has none, so a hook or a deploy can reuse the proof.

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
| `plan.local` | `false` | Runs the plan here, on a clean checkout of the commit, instead of in a container whose start can take a minute. |
| `task.command` | | Runs one matrix entry. The entry's keys fill its placeholders. |
| `task.name` | `name` | The entry key that names a task. |
| `task.verdict` | `true` | The task writes `{"rows": [{"name", "exitCode", "seconds", "output"}]}` to `{out}`. With `false`, its exit code is its one row. |
| `task.speculative` | `false` | Lets an idle container run a straggler again. |
| `task.hedge` | `0` | Runs this many of the plan's heaviest tasks twice from the start, the first answer kept: a copy that drew a slow container holds the run up no longer than the other takes. |
| `task.timeout` | `3600` | A task's limit, in seconds. |
| `task.secrets` | `[]` | The secrets each task gets in its environment, by name (`armada secret set <name>`). |

A matrix entry may list the `rows` its task must report.

| Size | vCPU | Memory | Cloudflare instance type |
|---|---|---|---|
| `micro` | 1/2 | 4 GiB | `standard-1` |
| `mini` | 1 | 6 GiB | `standard-2` |
| `small` | 2 | 8 GiB | `standard-3` |
| `medium` | 4 | 12 GiB | `standard-4` |

With `"size": "auto"`, each run takes the smallest size that the last five runs' tasks fill to three quarters at most,
in peak memory and average busy cores. A new size prepares its own environment once.

## Commands

```
armada deploy [--account=<id>] [--name=<name>] [--vcpus=N] [--drain]
armada map [--env=<recipe.json> | --commit=<rev>] (--times=N | --items=<file|->) [--size=<size>] [--pool=N] [--timeout=S] [--output] [--speculative] [--hedge=N] [--secrets=<A,B>] [--json] -- <command>
armada run <commit|worktree> [--label=<text>] [--secrets=<A,B>] [--json] [-- <plan args>]
armada verdict <commit|worktree> [--json]
armada push
armada dev
armada status <job-id>
armada secret set <NAME> | list | delete <NAME>
armada prune [--keep=3]
```

`armada --help` describes every option. `armada deploy --name=<name>` deploys a second armada on the same account and
prints the file that `--connection=<file>` takes to point any command at it. `--vcpus=N` caps that deployment's fleet.
A client and a Worker of different versions refuse each other's requests and say which one to update.
`armada run --json` prints its progress to stderr and, when it ends, one JSON object to stdout: the commit, the plan and
task jobs, the report's path, `graded` (`pass`, `fail` or `not graded`, as its exit code says), the problems, and the
rows.
