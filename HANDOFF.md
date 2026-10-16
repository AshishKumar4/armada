# armada handoff, 2026-10-12

## Repository
- https://github.com/AshishKumar4/armada, public, MIT.
- `main` is wire 9. It holds the work below, and the fixes for every issue filed so far (#1 to #37).
- Worktrees are under `/mnt/local/armada-wt/`; `core` is the integration worktree. `/mnt/local/armada` is a shared
  checkout other agents use; don't edit it. Other agents' clones may add worktrees here too (`fix-long-commands` is
  Dew's).
- The README video's sources (scenes, renderer, the captured runs) are in `/mnt/local/armada-wt/media/`, outside the
  repo. The rendered videos are in `~/armada-videos/`.

## Layout
- `src/`: the client.
  - `cli.ts`, `sdk.ts`, `task.ts`. A task's `output` checks each answer when it lands and types it.
  - `ci.ts` (`armada run`), `dispatch.ts` (`listSchedule`), `dashboard.ts` (`armada dashboard`).
  - `protocol.ts`: `PROTOCOL` 9, `OLDEST_CLIENT` 3, `DRIVER` 2, `PACKER` 3. A repository recipe's environment is keyed
    by the client's packer, so a client never builds on an environment an earlier one prepared (#34).
- `worker/src/`:
  - `job.ts`: one Durable Object per job. It owns the queue, vessels, slots, gangs, stragglers and retries.
  - `placement.ts`: how an `efficient` job packs its tasks: their estimates, which task fits beside a container's,
    how many containers its open tasks fill, and what its runs used. `estimates.ts`: one Durable Object per task
    class, holding its runs' use and each item's record.
  - `vessel.ts`: drives one container and its slots. `container.ts`: starting one, and the launch scripts.
  - `environments.ts`: the registry of environments, their preparation, retention and pruning.
  - `runs.ts`: each task run that may still be going, which `/status/<job>/<index>` lists (#21), and which a
    packing job's pool counts.
  - `hooks.ts`: webhook CI. `worker.ts`: the routes.
  - `fleet.ts`: the deployment's vCPU cap. Vessels and preparers both hold their containers' vCPUs in it.
  - `tasks.ts`: pushed task ids and every hold on a bundle (the ids, and each open job's pin). Its alarm alone deletes
    a bundle nothing holds.
  - `relay.ts`, `secrets.ts`, `timings.ts`.
- `worker/dashboard/`: the dashboard. `armada deploy` builds it into the Worker's assets.
- `python/`: the Python SDK. `lean/`: the scheduler proofs.
- `tools/oxlint/anti-slop/`: Kinu's lint rules, vendored. `upstream.json` names the commit.

## Gates
- `.armada.json` has six CI rows:
  - `test` and `typecheck`;
  - `relay`, a gang of 8;
  - `proofs`: `lake build --wfail` and the differential test against `listSchedule`;
  - `python`: ruff with Dew's rules, the unit tests, and `mypy --strict`;
  - `lint`: Kinu's anti-slop rules, zero findings.
- On this machine: `bun run typecheck`, `bun run lint`, `bun test tests/ worker/tests/`.
- `bun run privileged` runs the root and cgroup tests a CI task cannot, in a privileged Docker container. It fails if
  any of them skips. Run it before a release.
- A red gate is a design problem. Don't add suppressions, ignores or exemptions.

## How to work
- Tests that need containers run on armada: `bun src/cli.ts run <sha>` against a test deployment of your own.
- Name the deployment on every command, with `--connection=<file>` or `ARMADA_CONNECTION=<file>`.
- Name it on every deploy with `--name=<name>`. A deploy without `--name` goes to `armada` and rewrites
  `connection.json`. That happened once on 2026-10-08 and cut Kinu's running jobs.
- Before deleting a test deployment, run `armada prune --keep=0` on it. A Worker deleted with its snapshots leaves
  them in the account's registry, where nothing prunes them.
- Commit messages are `type: text`, at most 80 characters, with no first person.
- Push `main` only as a fast-forward, after a green run on that exact commit.
- Connection files live in `~/.config/armada/<name>.json`.
- A Durable Object's SQL statement binds at most 100 parameters, and a string is at most 2 MB. Bun's SQLite allows
  far more, so the tests' storage holds both bounds; a statement past them fails only in production otherwise.
- A finish or a stop in a vessel keeps each step in its slot's record before the next (`Current`), so a restarted
  vessel takes it up where it was. Keep new steps in that record.

## Deployments (account f44999d1ddda7012e9a87729eba250f1)
- `armada-v2` is Kinu's production CI. `armada-dew6` is Dew's, and `nimbus-armada-v2` is Nimbus's.
  - Don't deploy to them, roll them back, prune them or change their secrets. Each owner redeploys from `main`.
  - A deploy whose Worker serves every client the deployed one does, and whose Durable Objects call each other and
    store their records as the deployed one's do (`contractOf`), takes over running jobs; otherwise it drains them
    first, and the fleet admits the first new job once the deployment-wide objects run the new code
    (`ArmadaFleet.admitJob`). Each type an object stores is exported, so its shape is in the fingerprint. Either way a
    redeploy needs the owner's go-ahead. On 2026-10-12 a takeover of armada-dew3 across an interface change, before
    this check, let objects on the old code misread the new calls for minutes: its fleet dropped every hold.
  - On 2026-10-16 all three ran wire 10: armada-v2 `651930f`, nimbus-armada-v2 `52e8e31`, armada-dew6 `d3ddca1`.
    `main` is wire 11 (#48, #50) and changes the contract (#47's samples, #49's waiting holders, #50's lease), so each
    one's next deploy drains, then refuses new jobs for about 5 min while the deployment-wide objects still run the
    old code (measured on armada-ci2: 296 s). A wire-11 client gets 426 from a wire-10 Worker: redeploy the Worker
    before a project moves its client pin to `main`. Borrowing past the cap needs `ARMADA_ACCOUNT_TOKEN` at a deploy.
  - A client older than wire 9 can't name a mode, so its jobs run one task a container (`fast`). Nimbus's
    `.armada.json` sets `NIMBUS_TEST_CGROUP=/sys/fs/cgroup/armada/task`, a path only `fast` has: a packed task runs in
    `task-<slot>`. On 2026-10-14 nimbus-armada-v2, redeployed from `d9cde3f`, packed Nimbus's wire-7 jobs, and every
    task that made a case group failed with ENOENT. When Nimbus moves its client to `main`, it reads its group from
    `ARMADA_CGROUP`, which every task gets, or sets `task.mode` to `fast`.
- `connection.json`, `armada-kinu.json`, `armada-kinu-v1.json` and `armada-dew.json` belong to deployments that are
  gone. Leave them alone; an agent may still read one. Dew's `armada-dew2` to `armada-dew5` `.destroy.json` files are
  its own destroys.

## Account limits (measured 2026-10-12)
- Every container app in the account shares 1,500 concurrent vCPUs, 6 TiB of memory and 30 TB of disk
  (`GET /accounts/<id>/containers/me`). A start past them fails: "Account resource limit exceeded".
- A deployment's fleet cap (`--vcpus`, default 1,500) counts only its own containers. On 2026-10-12, `armada-dew3`
  (cap 5,000) ran 375 `medium` containers, all 1,500 vCPUs, and `armada-v2`'s starts failed with that error.
  Caps that sum past 1,500 let one deployment starve the others. A fleet deployed with ARMADA_ACCOUNT_TOKEN borrows
  past its cap what the account leaves idle, and gives it back within a task (`ArmadaFleet`): only a cap below the
  account's lets one deployment yield to another.
- The snapshot limit is not documented. New snapshots were refused at 66 GiB on 2026-10-10 and at about 70 GiB on
  2026-10-12. After the cleanup below, the account held 60.8 GiB: `armada-v2` 19.2, `nimbus-armada-v2` 16.3,
  `armada-dew3` 16.2, Dew's live preview 8.6, Kinu's devbox staging 0.6.
- No container app uses an image from the account's registry: all 11 start from Cloudflare's `node-24-trixie`.
  Cloudflare keeps a `btrfs-chain` artifact of each image, and the registry refuses to delete one (409
  `SINGLETON_ARTIFACT_EXISTS`), even with its image gone. 32 of them (39.9 GiB) remain. Whether images count
  against the snapshot limit is not known.
- The 2026-10-12 cleanup deleted:
  - Dew's live preview's 4 untagged snapshot manifests (12.3 GiB). Its own snapshot replacement left them.
  - Every image in the 68 image repositories (344 manifests).
  - The R2 buckets of the gone test deployments `armada-ui`, `armada-pr` and `armada-ci`.
- Deleting a snapshot's registry manifest does not stop containers starting from it: on 2026-10-10, 83 containers
  started from one deleted minutes before. Whether such a delete frees the account's quota is not known.

## What Kinu depends on
- Kinu pins armada by commit in its `package.json`. Its pre-push gate calls `armada verdict` and `armada run`.
- Kinu's deploy runs `armada run <sha> --secrets=... -- --deploy-phase=<phase>` against its own deployment.
- A wire 7 Worker serves clients from wire 3, and a newer client is refused by an older Worker, so a deployment's
  Worker is upgraded before the clients that use it.
- Each task gets `ARMADA_JOB_ID`, `ARMADA_VESSEL`, `ARMADA_STATUS_URL` and `ARMADA_STATUS_TOKEN` (#21). Kinu's contract
  tier uses them to tell whether the run that made a fixture still runs before it reaps the fixture.

## Open work
- A Python body without an `output` that answers a tuple gets a list back, though its type says tuple. Its answer
  crosses the wire as JSON.
- Three waits poll where a state change could wake them: a vessel asks the fleet for capacity every 5 s, a gang's
  ranks ask every 1 s whether it formed, and a job finds its environment ready at its next 15 s watchdog. Each costs
  latency, at most its interval; waking the waiters needs a durable register-then-check handshake.
- The retry budgets are fixed counts: `INFRA_ATTEMPTS` 3, `REPLACEMENTS` 8 (or the pool for losses before a task),
  `LOST_WAITS` 3. The hedging thresholds read a task's weight as seconds.
- The Lean models are simpler than the code: the fleet's leases and the answer policy (a copy's red replaces a
  landing green) differ. Their proofs hold for the models only.
- Containers end mid-task with "Network connection lost" in both modes, and the cause is not in armada's data. On
  2026-10-12, packed jobs lost 6 of 32 containers and unpacked ones about 6 of 150. A packed container's loss takes
  more tasks with it; whether packing raises the rate needs more runs and the platform's own telemetry.
- Not proved: the LPT 4/3 bound. Only the differential test ties the Lean model to the TypeScript `listSchedule`.
- Dew's suite takes 12 to 16 min on armada-dew3, whatever its pool and target (2026-10-13, client 1879a66). Pool 96
  packs about 2 tasks a container on 48 containers (13.7 min median); pool 192 ran on 95 containers in 11.9 min.
  Target 90 added about 13% more task time and gained nothing; one task a container (`mode: fast`) on 96 took 18.6
  min. Packed, a task takes about twice its recorded time, and the run waits on its heaviest tasks: the halves of
  tests/test_imports.py and the splits of test_decoder_export.py, at 600 to 650 s. The next levers are running the
  critical path's tasks unpacked and splitting those files.
- Kinu's starts take longer than a small snapshot's: a median of 1.8 s against 0.3 s. The 100 ms start poll cuts the
  part that waited for the next whole second. The rest is its 4.8 GiB snapshots; smaller environments would help.

## Measured numbers
All are in the README's "Measured" section, dated, each with the command that reproduces it, but packing's below.

Packing, 2026-10-12 on `armada-ci`: Dew's and Kinu's recorded CI tasks replayed as `medium` tasks that use the same
CPU, memory and time (`armada map --items=<file> --pool=24 --mode=<mode>`; the inputs are not in the repo).

| Workload | `fast` | `efficient`, items recorded |
|---|---|---|
| Dew, 200 tasks | 1,260 s wall, 24 containers, 29,005 container-seconds | 1,292 s wall (+2.5%), 10 containers, 10,795 container-seconds (-63%) |
| Kinu, 92 tasks | 600 s wall, 26 containers, 2 lost | 956 s wall, 22 containers, 5 lost, one under its longest task |

A packed task ran 1 to 3% slower than alone. A job's first run of items it has no record of packs by its class's
95th percentile of memory: Kinu's first packed run took 591 s on 24 containers.
