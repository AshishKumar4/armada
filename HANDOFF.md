# armada handoff, 2026-10-10

## Repository
- https://github.com/AshishKumar4/armada, public, MIT.
- `main` is wire 7. It holds the work below, and the fixes for every issue filed so far (#1 to #21).
- Worktrees are under `/mnt/local/armada-wt/`; `core` is the integration branch. `/mnt/local/armada` is a shared
  checkout other agents use; don't edit it. Other agents' clones may add worktrees here too (`fix-long-commands` is
  Dew's).
- The README video's sources (scenes, renderer, the captured runs) are in `/mnt/local/armada-wt/media/`, outside the
  repo. The rendered videos are in `~/armada-videos/`.

## Layout
- `src/`: the client.
  - `cli.ts`, `sdk.ts`, `task.ts`. A task's `output` checks each answer when it lands and types it.
  - `ci.ts` (`armada run`), `dispatch.ts` (`listSchedule`), `dashboard.ts` (`armada dashboard`).
  - `protocol.ts`: `PROTOCOL` 7, `OLDEST_CLIENT` 3, `DRIVER` 2.
- `worker/src/`:
  - `job.ts`: one Durable Object per job. It owns the queue, vessels, slots, gangs, stragglers and retries.
  - `vessel.ts`: drives one container and its slots. `container.ts`: starting one, and the launch scripts.
  - `environments.ts`: the registry of environments, their preparation, retention and pruning.
  - `runs.ts`: each task run that may still be going, which `/status/<job>/<index>` lists (#21).
  - `hooks.ts`: webhook CI. `worker.ts`: the routes.
  - `fleet.ts`, `relay.ts`, `secrets.ts`, `timings.ts`, `tasks.ts`.
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

## Deployments (account f44999d1ddda7012e9a87729eba250f1)
- `armada-v2` is Kinu's production CI. `armada-dew2` is Dew's, and `nimbus-armada-v2` is Nimbus's.
  - Don't deploy to them, roll them back, prune them or change their secrets. Each owner redeploys from `main`.
  - A same-wire deploy takes over running jobs, so a redeploy needs the owner's go-ahead.
- `connection.json`, `armada-kinu.json`, `armada-kinu-v1.json` and `armada-dew.json` belong to deployments that are
  gone. Leave them alone; an agent may still read one.
- The account's snapshots are limited, and a full account refuses every new environment: "snapshot resource limits
  were exceeded". On 2026-10-10 it held 66 GiB: the three deployments' 45 GiB, and 21.5 GiB that no armada
  deployment records. The account's other container apps (Kinu's devboxes, Dew's live preview) make snapshots too.
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
- Not proved: the LPT 4/3 bound. Only the differential test ties the Lean model to the TypeScript `listSchedule`.
- Kinu's starts take longer than a small snapshot's: a median of 1.8 s against 0.3 s. The 100 ms start poll cuts the
  part that waited for the next whole second. The rest is its 4.8 GiB snapshots; smaller environments would help.

## Measured numbers
All are in the README's "Measured" section, dated, each with the command that reproduces it.
