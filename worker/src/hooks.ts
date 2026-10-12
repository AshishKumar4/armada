/**
 * ArmadaWebhooks: the projects whose pushes and same-repository pull requests start a CI driver. One object,
 * `SINGLE`, holds each project's config (its repo, branches and webhook secret) and the driver job each commit
 * started in the last week, which answers a delivery GitHub sends again as it answers a second event of the commit.
 * The endpoint itself is `webhooked` in worker.ts;
 * `eventOf` and `driverSpec` are pure, so the tests exercise them without a request.
 */
import * as v from 'valibot';
import { Sha, type HookConfig, type JobSpecSchema, type Json, type Webhook } from '../../src/protocol';
import { ArmadaSingle } from './env';

/** What a delivery asks for, once the event and the config decide it. */
export type Ask =
  | { readonly kind: 'ping' }
  | { readonly kind: 'push'; readonly sha: string; readonly branch: string }
  | { readonly kind: 'pr'; readonly sha: string }
  | { readonly kind: 'fork' }
  | { readonly kind: 'ignore' };


/** The parts of GitHub's `push` payload a driver needs. */
const PushEvent = v.object({ ref: v.string(), after: Sha, deleted: v.optional(v.boolean(), false), repository: v.object({ default_branch: v.string() }) });

/** The parts of GitHub's `pull_request` payload a driver needs: a deleted fork's head has no repo at all. */
const PullRequestEvent = v.object({
  action: v.string(),
  pull_request: v.object({ head: v.object({ sha: Sha, repo: v.nullable(v.object({ full_name: v.string() })) }) }),
});

/** The pull request actions that bring new code. */
const BUILT_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

const IGNORE: Ask = { kind: 'ignore' };

/** The event a GitHub delivery is, against the project's config: only a push to a built branch and a same-repo pull
 *  request that opened, synchronized or reopened start a driver. A fork's code must never get the deployment's
 *  secrets, so it is refused even when pull requests build. */
export function eventOf(event: string, payload: Json, config: Pick<HookConfig, 'repo' | 'branches' | 'pullRequests'>): Ask {
  if (event === 'ping') return { kind: 'ping' };

  if (event === 'push') {
    const push = v.safeParse(PushEvent, payload);

    if (!push.success) return IGNORE;
    const { ref, after, deleted, repository } = push.output;

    // A tag's ref is not under refs/heads/, and a deleted branch has nothing to build.
    if (!ref.startsWith('refs/heads/') || deleted || /^0{40}$/u.test(after)) return IGNORE;
    const branch = ref.slice('refs/heads/'.length);

    return (config.branches ?? [repository.default_branch]).includes(branch) ? { kind: 'push', sha: after, branch } : IGNORE;
  }

  if (event !== 'pull_request' || !config.pullRequests) return IGNORE;
  const pr = v.safeParse(PullRequestEvent, payload);

  if (!pr.success || !BUILT_ACTIONS.has(pr.output.action)) return IGNORE;
  const { head } = pr.output.pull_request;

  return head.repo?.full_name === config.repo ? { kind: 'pr', sha: head.sha } : { kind: 'fork' };
}

/** How long a commit's driver is kept against a second run, and how often the ones past it are forgotten. */
const DRIVER_MS = 7 * 24 * 60 * 60_000;

const PRUNE_MS = 24 * 60 * 60_000;

/** A project's config as kept: the one last stored, and the secrets of those before it that GitHub may still sign
 *  with, until the config is stored again with its own secret (`configure`). */
export interface KeptHook extends HookConfig {
  readonly earlier?: readonly string[];
}

export class ArmadaWebhooks extends ArmadaSingle {
  /** Stores or replaces a project's config. A new signing secret is taken beside the ones before it, since GitHub signs
   *  with one of them until its hook is updated; storing the config again with the same secret says it is, and drops
   *  them. A secret's change that stopped between its steps (`webhook add`) refuses no delivery. */
  async configure(project: string, config: HookConfig): Promise<void> {
    const prior = await this.configOf(project);
    const earlier = prior === undefined || prior.secret === config.secret ? [] : [...prior.earlier ?? [], prior.secret];

    await this.ctx.storage.put(`config:${project}`, { ...config, earlier } satisfies KeptHook);
  }

  async configOf(project: string): Promise<KeptHook | undefined> {
    return await this.ctx.storage.get<KeptHook>(`config:${project}`);
  }

  /** Every project's config, its signing secret left out. */
  async list(): Promise<Webhook[]> {
    const all = await this.ctx.storage.list<HookConfig>({ prefix: 'config:' });

    return [...all].map(([key, config]) => ({
      project: key.slice('config:'.length), repo: config.repo, branches: config.branches, pullRequests: config.pullRequests, tokenSecret: config.tokenSecret, hook: config.hook,
    }));
  }

  /** Removes a project's config, answering what the GitHub side needs to delete the hook: its repo and hook id. */
  async remove(project: string): Promise<Pick<HookConfig, 'repo' | 'hook'> | null> {
    const config = await this.configOf(project);

    if (config === undefined) return null;
    await this.ctx.storage.delete(`config:${project}`);

    return { repo: config.repo, hook: config.hook };
  }

  /** Reserves the commit's driver for job `job` and answers null, or answers the job it already has and when it was
   *  claimed. Storage alone, so two deliveries of one commit never both get it. */
  async claim(project: string, sha: string, job: string): Promise<{ readonly job: string; readonly at: number } | null> {
    const held = await this.ctx.storage.get<{ readonly job: string; readonly at: number }>(`driver:${project}/${sha}`);

    if (held !== undefined) return held;
    await this.ctx.storage.put(`driver:${project}/${sha}`, { job, at: Date.now() });
    await this.prunes();

    return null;
  }

  /** Gives up job `job`'s reservation of the commit's driver, if it still holds it. */
  async unclaim(project: string, sha: string, job: string): Promise<void> {
    if ((await this.ctx.storage.get<{ readonly job: string }>(`driver:${project}/${sha}`))?.job === job) await this.ctx.storage.delete(`driver:${project}/${sha}`);
  }

  /** Forgets drivers past their window, then sleeps until the next is due. Delivery ids an earlier Worker kept go with
   *  them. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const deliveries = await this.ctx.storage.list({ prefix: 'del:' });
    const drivers = await this.ctx.storage.list<{ readonly at: number }>({ prefix: 'driver:' });

    await this.ctx.storage.delete([...deliveries.keys(), ...[...drivers].flatMap(([key, { at }]) => now - at > DRIVER_MS ? [key] : [])]);

    if (drivers.size > 0) await this.ctx.storage.setAlarm(now + PRUNE_MS);
  }

  /** The pruning alarm, set once something is kept. */
  private async prunes(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PRUNE_MS);
  }
}

/** The bun the driver runs armada under, pinned to its release's digest, the version armada's own CI runs. */
const BUN = { version: '1.4.0', sha256: '2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452' };

const ARMADA_REPO = 'https://github.com/AshishKumar4/armada.git';

/** The driver task's environment: bun alone, the same for every deployment, so a redeploy prepares no new one and
 *  takes no new snapshot. The driver fetches armada at the deployment's commit when it runs. It is `small`, so a new
 *  deployment's first push waits about 2 min for it: the runner layer under it builds git, which took 9.5 min on
 *  `micro`'s half vCPU (armada-lab, 2026-10-08). */
const DRIVER_RECIPE = {
  base: 'cloudflare/debian-trixie',
  setup: String.raw`set -eu
curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v${BUN.version}/bun-linux-x64.zip
echo "${BUN.sha256}  /tmp/bun.zip" | sha256sum -c -
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
rm -rf /tmp/bun.zip /tmp/bun-linux-x64`,
  size: 'small',
} as const;

/** The driver script: posts a pending status, fetches armada at the deployment's commit with its runtime dependencies
 *  alone, fetches the commit, runs `armada run <commit> --json` against the deployment, and posts the verdict's count
 *  as the status. The two credentials (the GitHub token, in the secret `ARMADA_GITHUB_SECRET` names, and ARMADA_TOKEN,
 *  added at claim) are read only from the environment, so the job's log keeps them masked. No code of the commit under
 *  test runs where they are (#33): it is fetched into a bare repository, so none of its files is on disk, neither a
 *  `bunfig.toml` whose preloads bun runs where it starts nor a plan to run here (`localPlan`); and the CLI gets no GitHub
 *  token, which only the statuses need. */
const DRIVER = String.raw`set -eu
github=$(printenv "$ARMADA_GITHUB_SECRET")
mkdir -p "$HOME/armada"
# The HTTP code gets a name of its own: a function's variables are the script's, and 'code' holds the run's exit.
status() {
  answered=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $github" -H 'accept: application/vnd.github+json' \
    -d "{\"state\":\"$1\",\"target_url\":\"$TARGET_URL\",\"description\":\"$2\",\"context\":\"armada\"}" \
    "https://api.github.com/repos/$ARMADA_REPO/statuses/$ARMADA_COMMIT") || answered=000
  case "$answered" in 2*) ;; *) echo "armada: posting the $1 status failed: HTTP $answered" >&2 ;; esac
}
status pending 'armada is running'
git -C "$HOME/armada" init -q
git -C "$HOME/armada" fetch -q --depth 1 ${ARMADA_REPO} "$ARMADA_DEPLOYED" \
  || { echo "armada: the deployment's commit $ARMADA_DEPLOYED is not on GitHub: deploy from a pushed commit for webhook CI" >&2; status error "armada's deployed commit is not on GitHub"; exit 2; }
git -C "$HOME/armada" checkout -q FETCH_HEAD
(cd "$HOME/armada" && bun install --frozen-lockfile --production --silent)
git init -q --bare "$HOME/repo"
git -C "$HOME/repo" fetch -q "https://github.com/$ARMADA_REPO.git" "$ARMADA_COMMIT" \
  || git -C "$HOME/repo" fetch -q "https://x-access-token:$github@github.com/$ARMADA_REPO.git" "$ARMADA_COMMIT"
cd "$HOME/repo"
set +e
env -u "$ARMADA_GITHUB_SECRET" bun "$HOME/armada/src/cli.ts" run "$ARMADA_COMMIT" --json > "$HOME/verdict.json"
code=$?
set -e
count=$(bun -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rows; console.log(r.filter((x) => x.exitCode === 0).length + " of " + r.length + " rows green"); } catch { console.log("the run did not grade"); }' "$HOME/verdict.json")
case "$code" in 0) status success "$count" ;; 1) status failure "$count" ;; *) status error "armada's run failed" ;; esac
exit "$code"
`;

/** The job the webhook starts for a commit: one micro command task labelled `ci <project> <sha12>`, whose spec names
 *  the GitHub token's secret and asks for the deployment's bearer at claim, never in its stored env. */
export function driverSpec(project: string, sha: string, { origin, sha: deploySha }: { readonly origin: string; readonly sha: string }, config: HookConfig): v.InferInput<typeof JobSpecSchema> {
  return {
    recipe: DRIVER_RECIPE,
    run: { kind: 'command' },
    items: [{ item: sha, argv: ['/bin/sh', '-c', DRIVER] }],
    output: false,
    pool: 1,
    label: `ci ${project} ${sha.slice(0, 12)}`,
    env: { ARMADA_URL: origin, ARMADA_DEPLOYED: deploySha, ARMADA_REPO: config.repo, ARMADA_COMMIT: sha, ARMADA_GITHUB_SECRET: config.tokenSecret, TARGET_URL: `${origin}/ui/#/ci/${project}/${sha}` },
    secrets: [config.tokenSecret],
    deployToken: true,
    timeout: 3600,
  };
}
