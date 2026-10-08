# armada handoff, 2026-10-08

*An AI assistant maintains this file. It is presented as-is.*

## Repository
- https://github.com/AshishKumar4/armada, public, MIT.
- `main` is wire 6. The branch `core` holds the work below at wire 7. It lands on `main` after Kinu moves to `armada-v2`.
- Worktrees are under `/mnt/local/armada-wt/`. `/mnt/local/armada` is a shared checkout other agents use; don't edit it.
- `core` replaces the remote branches `sched-v2`, `wip/concurrency-slots` and `probe/alarm-noise`. PRs #10, #11 and #12
  landed on `main`.

## Layout
- `src/`: the client.
  - `cli.ts`, `sdk.ts`, `task.ts`. A task's `output` checks each answer when it lands and types it.
  - `ci.ts` (`armada run`), `dispatch.ts` (`listSchedule`), `dashboard.ts` (`armada dashboard`).
  - `protocol.ts`: `PROTOCOL` 7, `OLDEST_CLIENT` 3, `DRIVER` 2.
- `worker/src/`:
  - `job.ts`: one Durable Object per job. It owns the queue, vessels, slots, gangs, stragglers and retries.
  - `vessel.ts`: drives one container and its slots.
  - `hooks.ts`: webhook CI.
  - `fleet.ts`, `relay.ts`, `environments.ts`, `secrets.ts`, `timings.ts`, `tasks.ts`.
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
- A red gate is a design problem. Don't add suppressions, ignores or exemptions.

## How to work
- Tests that need containers run on armada: `bun src/cli.ts run <sha>`.
- Name the deployment on every command, with `--connection=<file>` or `ARMADA_CONNECTION=<file>`.
- Name it on every deploy with `--name=<name>`. A deploy without `--name` goes to `armada`, Kinu's production. That
  happened once on 2026-10-08 and cut Kinu's running jobs.
- Commit messages are `type: text`, at most 80 characters, with no first person.
- Push `main` only as a fast-forward, after a green run on that exact commit.
- Connection files live in `~/.config/armada/<name>.json`.

## Deployments (account f44999d1ddda7012e9a87729eba250f1)
- `armada`: Kinu's production CI, at wire 6. Its files are `connection.json` and `armada-kinu.json`.
  - Don't deploy to it, roll it back, or change its secrets.
  - Don't read or write its two connection files.
- `armada-v2`: the new version, for Kinu to move to.
- `armada-dew` belongs to Dew. `nimbus-armada` belongs to Nimbus. Both are the owner's.
- `armada-lab` and `armada-probe` are test deployments from this work.

## What Kinu depends on
- Kinu pins armada by commit in its `package.json`. Its pre-push gate calls `armada verdict` and `armada run`.
- Kinu's deploy runs `armada run <sha> --secrets=... -- --deploy-phase=<phase>` against its own deployment.
- A wire 7 Worker serves clients from wire 3, so Kinu's wire 6 client works with `armada-v2`.
- A wire 7 client is refused by a wire 6 Worker. Kinu moves to `armada-v2` before it repins to the new `main`.
- Kinu asked for a second, file output per CI task. Artifacts are that output.

## Open work
- A Python body without an `output` that answers a tuple gets a list back, though its type says tuple. Its answer
  crosses the wire as JSON.
- Not proved: the LPT 4/3 bound. Only the differential test ties the Lean model to the TypeScript `listSchedule`.

## Measured numbers
All are in the README's "Measured" section, dated, each with the command that reproduces it.
