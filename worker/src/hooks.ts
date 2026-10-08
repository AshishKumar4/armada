/**
 * ArmadaWebhooks: the projects whose pushes and same-repository pull requests start a CI driver. One object,
 * `SINGLE`, holds each project's config — its repo, branches and webhook secret — the delivery ids seen, and the
 * driver job each commit started. The endpoint itself is `webhooked` in worker.ts; the pieces it checks are pure
 * so the tests exercise them without a request.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { JobSpecSchema } from '../../src/protocol';
import type { Env } from './env';

/** A project's webhook: its GitHub repo, the branches that build, whether same-repo pull requests do, the
 *  deployment secret holding a GitHub token, and the secret GitHub signs deliveries with — kept only here, never
 *  answered back after it is set. */
export const HookConfigSchema = v.object({
  repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'a repo is owner/name')),
  branches: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  pullRequests: v.optional(v.boolean(), false),
  tokenSecret: v.optional(v.pipe(v.string(), v.regex(/^[A-Z_][A-Z0-9_]{0,63}$/u)), 'GITHUB_TOKEN'),
  secret: v.pipe(v.string(), v.minLength(16)),
  /** The GitHub hook's id, when the CLI created it, so `remove` can delete it too. */
  hook: v.optional(v.number()),
});

export type HookConfig = v.InferOutput<typeof HookConfigSchema>;

export type PublicConfig = Omit<HookConfig, 'secret' | 'hook'>;

/** What a delivery asks for, once the event and the config decide it. */
export type Ask =
  | { readonly kind: 'ping' }
  | { readonly kind: 'push'; readonly sha: string; readonly branch: string }
  | { readonly kind: 'pr'; readonly sha: string }
  | { readonly kind: 'fork' }
  | { readonly kind: 'ignore' };

/** The event a GitHub delivery is, against the project's config: only a push to a built branch and a same-repo
 *  pull request that opened, synchronized or reopened start a driver. A fork's code must never get the
 *  deployment's secrets, so it is refused even when pull requests build. */
export function eventOf(event: string, payload: unknown, config: Pick<HookConfig, 'repo' | 'branches' | 'pullRequests'>): Ask {
  if (!v.is(v.looseObject({}), payload)) return { kind: 'ignore' };
  const body = payload as Record<string, unknown>;

  if (event === 'ping') return { kind: 'ping' };
  if (event === 'push') {
    const ref = typeof body['ref'] === 'string' ? body['ref'] : '';
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
    const after = typeof body['after'] === 'string' ? body['after'] : '';

    // A deletion has an all-zero `after`; a tag's ref is not refs/heads/.
    if (branch === undefined || !/^[0-9a-f]{40}$/u.test(after) || /^0{40}$/u.test(after)) return { kind: 'ignore' };
    if (config.branches !== undefined && !config.branches.includes(branch)) return { kind: 'ignore' };

    return { kind: 'push', sha: after, branch };
  }
  if (event === 'pull_request' && config.pullRequests === true) {
    const action = typeof body['action'] === 'string' ? body['action'] : '';
    const pr: { head: { sha: string; repo: { full_name: string } } } | undefined =
      v.is(v.looseObject({ head: v.looseObject({ sha: v.string(), repo: v.looseObject({ full_name: v.string() }) }) }), body['pull_request'])
        ? body['pull_request'] as { head: { sha: string; repo: { full_name: string } } }
        : undefined;

    if (!['opened', 'synchronize', 'reopened'].includes(action) || pr === undefined) return { kind: 'ignore' };
    if (pr.head.repo.full_name !== config.repo) return { kind: 'fork' };

    return { kind: 'pr', sha: pr.head.sha };
  }

  return { kind: 'ignore' };
}

export class ArmadaWebhooks extends DurableObject<Env> {
  /** Stores or replaces a project's config (the GitHub hook id included), or merges just its hook id. */
  async configure(project: string, config: HookConfig): Promise<PublicConfig> {
    const { secret: _secret, hook: _hook, ...publicConfig } = config;

    await this.ctx.storage.put(`config:${project}`, config);

    return publicConfig;
  }

  /** Records just the GitHub hook id the CLI created, beside the stored config. */
  async hooked(project: string, hook: number): Promise<void> {
    const config = await this.ctx.storage.get<HookConfig>(`config:${project}`);

    if (config !== undefined) await this.ctx.storage.put(`config:${project}`, { ...config, hook });
  }

  async configOf(project: string): Promise<HookConfig | undefined> {
    return await this.ctx.storage.get<HookConfig>(`config:${project}`);
  }

  /** Every project's config, secrets out. */
  async list(): Promise<{ project: string; repo: string; branches?: string[]; pullRequests: boolean; tokenSecret: string; hook?: number }[]> {
    const all = await this.ctx.storage.list<HookConfig>({ prefix: 'config:' });

    return [...all].map(([key, config]) => ({
      project: key.slice('config:'.length), repo: config.repo, ...config.branches === undefined ? {} : { branches: config.branches },
      pullRequests: config.pullRequests ?? false, tokenSecret: config.tokenSecret ?? 'GITHUB_TOKEN', ...config.hook === undefined ? {} : { hook: config.hook },
    }));
  }

  /** Removes a project's config, returning what the GitHub side needs to delete the hook: repo and hook id. */
  async remove(project: string): Promise<{ repo: string; hook?: number } | null> {
    const config = await this.ctx.storage.get<HookConfig>(`config:${project}`);

    if (config === undefined) return null;
    await this.ctx.storage.delete(`config:${project}`);

    return { repo: config.repo, ...(config.hook === undefined ? {} : { hook: config.hook }) };
  }

  /** Whether this delivery was answered before — and records it when it was not. */
  async seen(delivery: string): Promise<boolean> {
    if (await this.ctx.storage.get(`del:${delivery}`) !== undefined) return true;
    await this.ctx.storage.put(`del:${delivery}`, true);

    return false;
  }

  /** The driver job a commit already has, if any. */
  async driving(project: string, sha: string): Promise<string | undefined> {
    return await this.ctx.storage.get<string>(`driver:${project}/${sha}`);
  }

  /** Records the driver job a commit got. */
  async drove(project: string, sha: string, job: string): Promise<void> {
    await this.ctx.storage.put(`driver:${project}/${sha}`, job);
  }
}

/** The driver task's recipe: micro, Debian plus git and curl — Bun and the repo's own dependencies arrive in the
 *  script below, the way a local `armada run` needs them. */
const DRIVER_RECIPE = {
  base: 'cloudflare/debian-trixie',
  setup: 'apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates',
  install: '',
  size: 'micro' as const,
};

/** The driver script: posts a pending status, clones the commit, installs armada at the deployment's own commit,
 *  runs `armada run <sha> --json` against the deployment, and posts the verdict's count as the status. The two
 *  credentials (GITHUB_TOKEN in the named secret, ARMADA_TOKEN added at claim) are only read from the environment,
 *  so the job's log keeps them masked. */
const DRIVER = `set -eu
mkdir -p "$HOME/.config/armada" "$HOME/repo" "$HOME/.bun/bin"
printf '{"url":"%s","token":"%s","account":""}\\n' "$ARMADA_URL" "$ARMADA_TOKEN" > "$HOME/.config/armada/connection.json"
status() {
  curl -fsS -o /dev/null -X POST -H "authorization: Bearer $GITHUB_TOKEN" -H 'accept: application/vnd.github+json' \\
    -d "{\\"state\\":\\"$1\\",\\"target_url\\":\\"$TARGET_URL\\",\\"description\\":\\"$2\\",\\"context\\":\\"armada\\"}" \\
    "https://api.github.com/repos/$ARMADA_REPO/statuses/$ARMADA_COMMIT" || true
}
status pending 'armada is running'
git -C "$HOME/repo" init -q 2>/dev/null || true
git -C "$HOME/repo" fetch -q --depth 1 "https://github.com/$ARMADA_REPO.git" "$ARMADA_COMMIT" \
  || git -C "$HOME/repo" fetch -q --depth 1 "https://x-access-token:$GITHUB_TOKEN@github.com/$ARMADA_REPO.git" "$ARMADA_COMMIT"
git -C "$HOME/repo" checkout -q FETCH_HEAD
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
if [ ! -d "$HOME/.armada/.git" ]; then git clone -q --depth 1 https://github.com/AshishKumar4/armada.git "$HOME/.armada"; fi
git -C "$HOME/.armada" fetch -q --depth 1 origin "$ARMADA_DEPLOY_SHA" && git -C "$HOME/.armada" checkout -q FETCH_HEAD
cd "$HOME/.armada" && bun install --frozen-lockfile && ln -sf "$HOME/.armada/src/cli.ts" "$HOME/.bun/bin/armada"
cd "$HOME/repo"
set +e
armada run "$ARMADA_COMMIT" --json > verdict.json
code=$?
set -e
count=$(bun -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rows; console.log(r.filter((x) => x.exitCode === 0).length + " of " + r.length + " rows green"); } catch { console.log("the run did not grade"); }' verdict.json)
if [ "$code" -eq 0 ]; then status success "$count"; elif [ "$code" -eq 1 ]; then status failure "$count"; else status error "armada's run failed"; fi
exit "$code"
`;

/** The job the webhook starts for a commit: one micro command task labelled `ci <project> <sha12>`, whose spec
 *  names the GitHub token's secret and asks for the deployment's bearer at claim — never in stored env. */
export function driverSpec(project: string, sha: string, origin: string, deploySha: string, config: HookConfig): v.InferInput<typeof JobSpecSchema> {
  return {
    recipe: DRIVER_RECIPE,
    run: { kind: 'command' },
    items: [{ item: sha, argv: ['/bin/sh', '-c', DRIVER] }],
    output: false,
    pool: 1,
    label: `ci ${project} ${sha.slice(0, 12)}`,
    env: {
      ARMADA_URL: origin,
      ARMADA_REPO: config.repo,
      ARMADA_COMMIT: sha,
      TARGET_URL: `${origin}/ui/#/ci/${project}/${sha}`,
      ARMADA_DEPLOY_SHA: deploySha,
    },
    secrets: [config.tokenSecret ?? 'GITHUB_TOKEN'],
    deployToken: true,
    timeout: 3600,
  };
}
