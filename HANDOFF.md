# armada handoff, 2026-10-08

## Repository
- https://github.com/AshishKumar4/armada, public, MIT. `main` is `a0cff43`. Local clone: `/mnt/local/armada` (clean, on `main`).
- Other remote branches, none merged:
  - `sched-v2` (`842253d`): scheduler v2, unfinished. See "Open work".
  - `wip/concurrency-slots` (`cc3aea6`): per-slot task directories and cgroups so one container runs several tasks. Not wired in.
  - `probe/alarm-noise` (`f7c4835`): logging to diagnose the alarm exceptions. Not for `main`.
- `archive/pre-rewrite` is a local tag-like branch holding history from before the rewrite. Keep it.

## Layout
- `src/`: the client. `cli.ts`, `sdk.ts` and `task.ts` (typed TypeScript API), `ci.ts` (`armada run`, `poolFor`), `protocol.ts` (wire `PROTOCOL` 6, `DRIVER` 2).
- `worker/src/`:
  - `job.ts`: one Durable Object per job. It owns the queue, vessels, gangs, stragglers and retries.
  - `vessel.ts`: drives one container.
  - `fleet.ts`: vCPU cap and drain lease.
  - `timings.ts`: past durations.
  - `relay.ts`: gang networking.
  - `environments.ts`, `secrets.ts`.
- Tests are in `tests/` and `worker/tests/`. `examples/video-720p` is the benchmark. `ci/` holds armada's own CI environment, named in `.armada.json`.

## How to work
- Every test runs on armada, never on the PC. Use `bun src/cli.ts run <sha>` for the whole CI, or `bun src/cli.ts map --commit=<sha> ... -- <cmd>` for one command.
- The gang `relay` CI row needs a Worker that has gangs. Kinu's deployment predates gangs, so run that row against a deployment built from your tip.
- Commit messages are `type: text`, at most 80 characters, with no first person. Push `main` only as a fast-forward, after a green run on that exact commit.
- To deploy: `CLOUDFLARE_ACCOUNT_ID=f44999d1ddda7012e9a87729eba250f1 bun src/cli.ts deploy [--name=<name>]`, from a clean checkout of pushed `main`.
  - A deploy that keeps the same wire takes over running jobs with no drain. That was measured: 6 deploys over 200 one-minute tasks cut none and refused no job.
  - A deploy that changes the wire, or one run with `--drain`, drains first. The drain is a 10-minute lease.
- Connection files live in `~/.config/armada/<name>.json`.

## Deployments (account f44999d1ddda7012e9a87729eba250f1)
- `armada` (`connection.json`): Kinu's only CI.
  - It runs `fc52a47`, at driver 1 and wire 6.
  - It holds three secrets: `KINU_SCRIPTED_MODEL_KEY`, `KINU_EVAL_STAGING_WEB_IDENTITY` and `KINU_EVAL_WEB_IDENTITY`. They're copied from `~/.config/kinu/secrets.env` by `/mnt/local/kinu/bin/armada-secrets.sh`.
  - Don't deploy to it until Kinu's release ships (2026-10-08). After that, deploy `main`; the wire is the same, so nothing drains.
- `armada-dew` (driver 2, wire 6) belongs to Dew. `nimbus-armada` belongs to Nimbus and predates the wire header. Both are the owner's.
- No throwaway deployments are left. armada-noise and the scheduler baseline were both deleted.

## What Kinu depends on
- Kinu pins `"armada": "github:AshishKumar4/armada#e7a4fbc..."` in its `package.json`.
- Kinu's pre-push gate calls `node_modules/.bin/armada verdict|run`.
- Kinu's deploy runs `armada run <sha> --secrets=... -- --deploy-phase=<phase>` against `connection.json`.
- A change to the wire, the CLI flags, or the verdict file format breaks Kinu until Kinu repins.
- Kinu asks for one feature: a CI task with a second, file output, so a row can return evidence without base64 in its verdict.

## Open work
1. **Scheduler v2, branch `sched-v2`.** It has six commits on `a0cff43`.
   - Implemented:
     - plans that are the better of longest-first and MULTIFIT, plus improving moves and swaps, and exact search up to 12 tasks;
     - pool sizing that counts container start time;
     - work-conserving dispatch with stealing;
     - incremental replanning;
     - gang reservation with backfill bounded by task timeouts;
     - weighted least-allocated admission across jobs;
     - a schedule-quality certificate in job status.
   - Not verified:
     - no Lean theorem has compiled yet;
     - the last full CI run (on `47d4f2f`) was 2 of 4 green, failing on gang fixture timing and on the Lean toolchain missing from the environment;
     - the fixes since then are unrun.
   - Known bug: `ci/proofs.sh` greps for `admit` and matches the function named `admit`. Detect admission through the compiler instead.
   - Next:
     1. compile the Lean proofs;
     2. get a green whole run on the exact SHA;
     3. benchmark before and after (Kinu's CI, `examples/video-720p`, `map --times=100 -- sleep 3`, a skewed mix, and a static timing split);
     4. only then merge and deploy.
   - Unproven claims:
     - the full LPT bound;
     - MULTIFIT's 13/11, which is a literature citation;
     - that the model matches the code;
     - the cost of the exact-search threshold;
     - bounds with start times;
     - fairness over time.
   - Pool fixture results so far: 10 → 8 containers for a long-tail mix, 12 → 10 for an equal capped mix.
2. **Alarm exceptions.** About 1 in 3 vessel alarm events log `internal error`, with or without a deploy (173 of 650 with deploys, 273 of 863 without). They land about 10, 20 and 51 s into an alarm. No vessel failed, and no task was lost or rerun. Hypothesis: `AbortSignal.timeout` timers on execs that already finished, or the `monitor()` promise, reject after the handler returns. `probe/alarm-noise` logs exactly those two. It hasn't produced a run yet.
3. **Gangs across a deploy.** Unmeasured: does a same-wire deploy cut a live rank-to-rank relay? The test driver is `/mnt/local/kinu/tmp/livedeploy/gang/run.sh` (2 ranks, 90 echo round trips, a deploy at 40 s). If relays drop, the deploy must drain while gang jobs are open, or relays must reconnect.
4. **Several tasks per container,** branch `wip/concurrency-slots`. Unfinished.
5. **Python SDK.** Not started. It should mirror `src/sdk.ts` and `src/task.ts`.
6. **Later:** CI on push through a GitHub webhook (no local client), Worker pipelines, storage tiered by size.

## Measured numbers
All are in the README's "Measured" section, dated 2026-10-07, each with the command that reproduces it.
