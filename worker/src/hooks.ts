/**
 * ArmadaWebhooks: the projects whose pushes and same-repository pull requests start a CI driver. One object,
 * `SINGLE`, holds each project's config (its repo, branches and webhook secret), the delivery ids seen in the last
 * day, and the driver job each commit started in the last week. The endpoint itself is `webhooked` in worker.ts;
 * `eventOf` and `driverSpec` are pure, so the tests exercise them without a request.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import type { JobSpecSchema, Json, Webhook } from '../../src/protocol';
import type { Env } from './env';

/** A project's webhook: its GitHub repo, the branches that build (absent: the repo's default branch), whether
 *  same-repo pull requests do, the deployment secret holding a GitHub token, the secret GitHub signs deliveries with
 *  (kept only here, never answered back), and the GitHub hook's id when the CLI made it, so `remove` deletes it too. */
export const HookConfigSchema = v.object({
  repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'a repo is owner/name')),
  branches: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  pullRequests: v.optional(v.boolean(), false),
  tokenSecret: v.optional(v.pipe(v.string(), v.regex(/^[A-Z_][A-Z0-9_]{0,63}$/u)), 'GITHUB_TOKEN'),
  secret: v.pipe(v.string(), v.minLength(16)),
  hook: v.optional(v.number()),
});

export type HookConfig = v.InferOutput<typeof HookConfigSchema>;

/** What a delivery asks for, once the event and the config decide it. */
export type Ask =
  | { readonly kind: 'ping' }
  | { readonly kind: 'push'; readonly sha: string; readonly branch: string }
  | { readonly kind: 'pr'; readonly sha: string }
  | { readonly kind: 'fork' }
  | { readonly kind: 'ignore' };

const Commit = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

/** The parts of GitHub's `push` payload a driver needs. */
const PushEvent = v.object({ ref: v.string(), after: Commit, deleted: v.optional(v.boolean(), false), repository: v.object({ default_branch: v.string() }) });

/** The parts of GitHub's `pull_request` payload a driver needs: a deleted fork's head has no repo at all. */
const PullRequestEvent = v.object({
  action: v.string(),
  pull_request: v.object({ head: v.object({ sha: Commit, repo: v.nullable(v.object({ full_name: v.string() })) }) }),
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

/** How long a delivery id is kept against GitHub's redeliveries, and a commit's driver against a second run. */
const DELIVERY_MS = 24 * 60 * 60_000;

const DRIVER_MS = 7 * 24 * 60 * 60_000;

export class ArmadaWebhooks extends DurableObject<Env> {
  /** Stores or replaces a project's config. */
  async configure(project: string, config: HookConfig): Promise<void> {
    await this.ctx.storage.put(`config:${project}`, config);
  }

  async configOf(project: string): Promise<HookConfig | undefined> {
    return await this.ctx.storage.get<HookConfig>(`config:${project}`);
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

  /** Whether this delivery was answered in the last day, recording it when it was not. */
  async seen(delivery: string): Promise<boolean> {
    if ((await this.ctx.storage.get<number>(`del:${delivery}`)) !== undefined) return true;
    await this.ctx.storage.put(`del:${delivery}`, Date.now());
    await this.prunes();

    return false;
  }

  /** The driver job a commit got in the last week, if any. */
  async driving(project: string, sha: string): Promise<string | undefined> {
    return (await this.ctx.storage.get<{ readonly job: string }>(`driver:${project}/${sha}`))?.job;
  }

  async drove(project: string, sha: string, job: string): Promise<void> {
    await this.ctx.storage.put(`driver:${project}/${sha}`, { job, at: Date.now() });
    await this.prunes();
  }

  /** Forgets deliveries and drivers past their windows, then sleeps until the next one is due. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const deliveries = await this.ctx.storage.list<number>({ prefix: 'del:' });
    const drivers = await this.ctx.storage.list<{ readonly at: number }>({ prefix: 'driver:' });

    await this.ctx.storage.delete([
      ...[...deliveries].flatMap(([key, at]) => now - at > DELIVERY_MS ? [key] : []),
      ...[...drivers].flatMap(([key, { at }]) => now - at > DRIVER_MS ? [key] : []),
    ]);

    if (deliveries.size + drivers.size > 0) await this.ctx.storage.setAlarm(now + DELIVERY_MS);
  }

  /** The pruning alarm, set once something is kept. */
  private async prunes(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DELIVERY_MS);
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
 *  alone, clones the commit, runs `armada run <sha> --json` against the deployment, and posts the verdict's count as
 *  the status. The two credentials (the GitHub token, in the secret `ARMADA_GITHUB_SECRET` names, and ARMADA_TOKEN,
 *  added at claim) are read only from the environment, so the job's log keeps them masked. */
const DRIVER = String.raw`set -eu
github=$(printenv "$ARMADA_GITHUB_SECRET")
mkdir -p "$HOME/.config/armada" "$HOME/repo" "$HOME/armada"
printf '{"url":"%s","token":"%s","account":""}\n' "$ARMADA_URL" "$ARMADA_TOKEN" > "$HOME/.config/armada/connection.json"
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
git -C "$HOME/repo" init -q
git -C "$HOME/repo" fetch -q --depth 1 "https://github.com/$ARMADA_REPO.git" "$ARMADA_COMMIT" \
  || git -C "$HOME/repo" fetch -q --depth 1 "https://x-access-token:$github@github.com/$ARMADA_REPO.git" "$ARMADA_COMMIT"
git -C "$HOME/repo" checkout -q FETCH_HEAD
cd "$HOME/repo"
set +e
bun "$HOME/armada/src/cli.ts" run "$ARMADA_COMMIT" --json > verdict.json
code=$?
set -e
count=$(bun -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rows; console.log(r.filter((x) => x.exitCode === 0).length + " of " + r.length + " rows green"); } catch { console.log("the run did not grade"); }' verdict.json)
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
