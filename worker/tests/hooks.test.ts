/** The GitHub webhook's checks: its signature gate, the event filter, the two dedupes, and the driver job's spec —
 *  exercised through `webhooked` with the DO's own methods on in-memory storage. */
import { describe, expect, setSystemTime, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/worker';
import { JobSpecSchema, WebhooksSchema, type HookConfig, type Json } from '../../src/protocol';
import { ArmadaWebhooks, driverSpec, eventOf } from '../src/hooks';
import { webhooked, signed } from '../src/worker';
import * as v from 'valibot';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

const SECRET = 's'.repeat(48);

const SHA = 'a'.repeat(40);

/** What the webhook endpoint answers a delivery. */
const Said = v.object({ started: v.optional(v.string()), note: v.optional(v.string()) });

const CONFIG: HookConfig = { repo: 'owner/armada', pullRequests: true, tokenSecret: 'GITHUB_TOKEN', secret: SECRET };

/** A push GitHub sends: the ref, the new head, and the repo's default branch. */
const pushed = (ref: string, after = SHA) => ({ ref, after, repository: { default_branch: 'main' } });

function hooks(state_ = state()): ArmadaWebhooks {
  return new ArmadaWebhooks(state_.ctx, world({}));
}

async function configured(): Promise<ArmadaWebhooks> {
  const object = hooks();

  await object.configure('armada', CONFIG);

  return object;
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Beyond the webhooks object and the payload, what a delivery meets: its own headers, what R2 holds, each job's phase,
 *  the commit the Worker was deployed from, the secrets set, and the fleet. */
interface Delivery {
  readonly headers?: Readonly<Record<string, string>>;
  readonly objects?: Map<string, string>;
  readonly jobs?: Readonly<Record<string, { readonly phase: string }>>;
  readonly deployed?: string;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly fleet?: DurableObjectNamespace;
}

async function deliver(hooksStub: ArmadaWebhooks, payload: Json, {
  headers = {}, objects = new Map(), jobs = {}, deployed = 'b'.repeat(40), secrets = { GITHUB_TOKEN: 'gh' }, fleet = namespace(() => ({ reserve: async () => true, closed: async () => undefined })),
}: Delivery = {}): Promise<Response> {
  const body = JSON.stringify(payload);

  const env = world({
    ARMADA_TOKEN: TOKEN,
    ARMADA_SHA: deployed,
    VERSION: { id: 'v', tag: '', timestamp: '' },
    ARTIFACTS: bucket(objects),
    FLEET: fleet,
    WEBHOOKS: namespace(() => hooksStub),
    JOB: namespace((name) => ({ status: async () => jobs[name] ?? null, create: async () => undefined })),
    SECRETS: namespace(() => ({ values: async () => secrets })),
  });

  return await webhooked(new Request('https://armada.test/webhooks/github/armada', {
    method: 'POST',
    headers: { 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'del-1', 'X-Hub-Signature-256': await sign(SECRET, body), ...headers },
    body,
  }), env, 'armada');
}

describe('the github webhook', () => {
  test('configures, lists without the secret, and removes', async () => {
    const object = hooks();

    await object.configure('armada', CONFIG);
    const listed = await object.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    expect(listed[0]?.repo).toBe('owner/armada');
    expect(await object.configOf('armada')).toEqual({ ...CONFIG, earlier: [] });
    expect(await object.remove('armada')).toEqual({ repo: 'owner/armada' });
    expect(await object.configOf('armada')).toBeUndefined();
  });

  test('takes a delivery signed with a secret before a new one until the config is stored again with it', async () => {
    const object = await configured();
    const next = 'n'.repeat(48);
    const later = 'l'.repeat(48);

    const signedWith = async (secret: string, id: string) => {
      const body = JSON.stringify(pushed('refs/heads/feature'));

      return (await deliver(object, pushed('refs/heads/feature'), { headers: { 'X-Hub-Signature-256': await sign(secret, body), 'X-GitHub-Delivery': id } })).status;
    };

    // A change GitHub never took, then another: GitHub may sign with any of the three.
    await object.configure('armada', { ...CONFIG, secret: next });
    await object.configure('armada', { ...CONFIG, secret: later });
    const changing = [await signedWith(SECRET, 'a'), await signedWith(next, 'b'), await signedWith(later, 'c')];

    // GitHub signs with the last one now, and the config is stored again with it.
    await object.configure('armada', { ...CONFIG, secret: later, hook: 77 });

    expect({ changing, settled: [await signedWith(SECRET, 'd'), await signedWith(next, 'e'), await signedWith(later, 'f')] }).toEqual({ changing: [200, 200, 200], settled: [401, 401, 200] });
  });

  test('accepts a good signature, and refuses a bad, a missing, or a wrong-secret one', async () => {
    const body = '{"ref":"refs/heads/main","after":"' + SHA + '"}';

    expect(await signed(SECRET, await sign(SECRET, body), body)).toBe(true);
    expect(await signed(SECRET, 'sha256=' + '0'.repeat(64), body)).toBe(false);
    expect(await signed(SECRET, '', body)).toBe(false);
    expect(await signed('other' + 'o'.repeat(43), await sign(SECRET, body), body)).toBe(false);

    const object = await configured();
    const answer = await deliver(object, pushed('refs/heads/main'));
    const denied = await deliver(object, pushed('refs/heads/main'), { headers: { 'X-Hub-Signature-256': 'sha256=bad', 'X-GitHub-Delivery': 'del-2' } });

    expect(denied.status).toBe(401);
    expect(v.parse(Said, await answer.json())).toEqual({ started: expect.any(String) });
  });

  test('reads the push events: built branch, filtered branch, deletion, tag, ping, and other events', async () => {
    const branches = { repo: 'owner/armada', branches: ['release'], pullRequests: false, secret: SECRET };

    expect(eventOf('push', pushed('refs/heads/release'), branches)).toEqual({ kind: 'push', sha: SHA, branch: 'release' });
    expect(eventOf('push', pushed('refs/heads/main'), branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', pushed('refs/heads/release', '0'.repeat(40)), branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', { ...pushed('refs/heads/release'), deleted: true }, branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', pushed('refs/tags/v1'), branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('ping', {}, branches)).toEqual({ kind: 'ping' });
    expect(eventOf('release', {}, branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', 'not-an-object', branches)).toEqual({ kind: 'ignore' });
  });

  test('builds only the default branch when the config names no branches', () => {
    expect(eventOf('push', pushed('refs/heads/main'), CONFIG)).toEqual({ kind: 'push', sha: SHA, branch: 'main' });
    expect(eventOf('push', pushed('refs/heads/webhook-test'), CONFIG)).toEqual({ kind: 'ignore' });
  });

  test('reads pull requests: opened, synchronize, reopened from the same repo only, and a fork refused', async () => {
    const config = { repo: 'owner/armada', pullRequests: true, secret: SECRET };
    const pr = (action: string, repo = 'owner/armada') => ({ action, pull_request: { head: { sha: SHA, repo: { full_name: repo } } } });

    expect(eventOf('pull_request', pr('opened'), config)).toEqual({ kind: 'pr', sha: SHA });
    expect(eventOf('pull_request', pr('synchronize'), config)).toEqual({ kind: 'pr', sha: SHA });
    expect(eventOf('pull_request', pr('reopened'), config)).toEqual({ kind: 'pr', sha: SHA });
    expect(eventOf('pull_request', pr('closed'), config)).toEqual({ kind: 'ignore' });
    expect(eventOf('pull_request', pr('opened', 'forker/armada'), config)).toEqual({ kind: 'fork' });
    // A fork deleted since: its head names no repo, and it is still a fork.
    expect(eventOf('pull_request', { action: 'opened', pull_request: { head: { sha: SHA, repo: null } } }, config)).toEqual({ kind: 'fork' });
    expect(eventOf('pull_request', pr('opened'), { ...config, pullRequests: false })).toEqual({ kind: 'ignore' });
  });

  test('answers a redelivery as its commit\'s driver says: a commit with a verdict, or an open driver, a push and a PR at once included, starts none', async () => {
    const object = await configured();
    const objects = new Map<string, string>();
    const push = pushed('refs/heads/main');

    const first = await deliver(object, push, { headers: { 'X-GitHub-Delivery': 'del-1' }, objects });
    const started = v.parse(v.object({ started: v.string() }), await first.json()).started;
    const again = await deliver(object, push, { headers: { 'X-GitHub-Delivery': 'del-1' }, objects });
    const judged = await deliver(object, push, { headers: { 'X-GitHub-Delivery': 'del-2' }, objects: new Map([['verdicts/armada/' + SHA + '.json', '{}']]) });
    const running = await deliver(object, push, { headers: { 'X-GitHub-Delivery': 'del-3' }, objects, jobs: { [started]: { phase: 'running' } } });
    const done = await deliver(object, push, { headers: { 'X-GitHub-Delivery': 'del-4' }, objects, jobs: { [started]: { phase: 'done' } } });
    // A push and a pull request of one new commit, delivered at once.
    const other = 'c'.repeat(40);
    const both = await Promise.all(['del-5', 'del-6'].map(async (id) => await deliver(object, pushed('refs/heads/main', other), { headers: { 'X-GitHub-Delivery': id }, objects })));

    expect({
      again: v.parse(Said, await again.json()), judged: v.parse(Said, await judged.json()), running: v.parse(Said, await running.json()), done: Object.keys(v.parse(Said, await done.json())),
      both: (await Promise.all(both.map(async (answer) => Object.keys(v.parse(Said, await answer.json())).join()))).toSorted(),
    }).toEqual({ again: { note: 'already' }, judged: { note: 'already' }, running: { note: 'already' }, done: ['started'], both: ['note', 'started'] });
  });

  test('takes a commit whose claim has no job behind it once a making would have finished, and not before, the same delivery sent again included', async () => {
    const object = await configured();

    // A delivery that died between its claim and its job's making, sent again by GitHub.
    await object.claim('armada', SHA, 'never-made');
    const soon = await deliver(object, pushed('refs/heads/main'), { headers: { 'X-GitHub-Delivery': 'del-a' } });

    setSystemTime(new Date(Date.now() + 6 * 60_000));

    try {
      const later = await deliver(object, pushed('refs/heads/main'), { headers: { 'X-GitHub-Delivery': 'del-a' } });

      expect({ soon: v.parse(Said, await soon.json()), later: Object.keys(v.parse(Said, await later.json())) }).toEqual({ soon: { note: 'already' }, later: ['started'] });
    } finally {
      setSystemTime();
    }
  });

  test('holds no place in the fleet for a push it cannot start: a Worker that does not know its commit, or a secret unset', async () => {
    const object = await configured();
    const open = new Set<string>();

    const fleet = namespace(() => ({
      reserve: async (_version: string, id: string) => {
        open.add(id);

        return true;
      },
      closed: async (id: string) => { open.delete(id); },
    }));

    const unknown = await deliver(object, pushed('refs/heads/main'), { headers: { 'X-GitHub-Delivery': 'del-a' }, deployed: '', fleet });
    const unset = await deliver(object, pushed('refs/heads/main'), { headers: { 'X-GitHub-Delivery': 'del-b' }, secrets: {}, fleet });

    // Once the secret is set, GitHub's redelivery of the same id starts the job.
    const redelivered = await deliver(object, pushed('refs/heads/main'), { headers: { 'X-GitHub-Delivery': 'del-b' }, fleet });

    expect({ refused: [unknown.status, unset.status], redelivered: Object.keys(v.parse(Said, await redelivered.json())) }).toEqual({ refused: [503, 409], redelivered: ['started'] });
  });

  test('forgets a commit\'s driver after a week', async () => {
    const object = hooks();

    try {
      setSystemTime(new Date('2026-10-01T00:00:00Z'));
      await object.claim('armada', SHA, 'job-1');
      setSystemTime(new Date('2026-10-02T01:00:00Z'));
      await object.alarm();
      expect((await object.claim('armada', SHA, 'job-2'))?.job).toBe('job-1');
      setSystemTime(new Date('2026-10-08T02:00:00Z'));
      await object.alarm();
      expect(await object.claim('armada', SHA, 'job-3')).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('builds the driver spec: small command, ci label, secrets by name only, the bearer at claim', () => {
    const spec = v.parse(JobSpecSchema, driverSpec('armada', SHA, { origin: 'https://armada.test', sha: 'b'.repeat(40) }, CONFIG));

    expect(spec.label).toBe(`ci armada ${SHA.slice(0, 12)}`);
    expect(spec.run).toEqual({ kind: 'command' });
    expect(spec.secrets).toEqual(['GITHUB_TOKEN']);
    expect(spec.deployToken).toBe(true);
    expect(spec.recipe.size).toBe('small');
    expect(spec.env['ARMADA_REPO']).toBe('owner/armada');
    expect(spec.env['ARMADA_COMMIT']).toBe(SHA);
    expect(spec.env['TARGET_URL']).toBe(`https://armada.test/ui/#/ci/armada/${SHA}`);
    expect(JSON.stringify(spec.env)).not.toContain(TOKEN);
    expect(JSON.stringify(spec)).not.toContain('gh-token-value');
    expect(spec.env['ARMADA_GITHUB_SECRET']).toBe('GITHUB_TOKEN');
    // The environment is the same for every deployed commit: a redeploy takes no new snapshot. The driver fetches
    // armada at the deployed commit when it runs (`the driver script`).
    expect(v.parse(JobSpecSchema, driverSpec('armada', SHA, { origin: 'https://armada.test', sha: 'c'.repeat(40) }, CONFIG)).recipe).toEqual(spec.recipe);
    expect(spec.env['ARMADA_DEPLOYED']).toBe('b'.repeat(40));
  });
});

describe('the driver script', () => {
  /** The driver against a GitHub of local repositories: armada at its deployed commit, and the commit under test, which
   *  holds a `bunfig.toml` with a preload. curl answers each status post `posted`, and `armada run` (bun on the CLI)
   *  exits `ran`. The driver's exit, each status it posted, each commit it fetched and from where, and, for each bun it
   *  ran but the install, which it was, the GitHub token it held, and how many of the commit's files were on disk. */
  function drive(ran: number, posted: number) {
    const scratch = mkdtempSync(join(tmpdir(), 'armada-driver-'));
    const bin = join(scratch, 'bin');
    const github = join(scratch, 'github');
    const home = join(scratch, 'home');
    const script = v.parse(JobSpecSchema, driverSpec('armada', SHA, { origin: 'https://armada.test', sha: 'b'.repeat(40) }, CONFIG)).items[0]?.argv?.[2] ?? '';
    // Git where this machine has it, which a container's runner layer builds into /usr/local.
    const realGit = Bun.which('git') ?? 'git';
    const gitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${github}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };

    /** A repository of GitHub's, `owner/name.git`, of one commit of `files`: that commit. */
    const repository = (name: string, files: Readonly<Record<string, string>>): string => {
      const dir = join(github, name);
      const git = (...args: string[]) => Bun.spawnSync([realGit, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env: gitEnv }).stdout.toString().trim();

      mkdirSync(dir, { recursive: true });
      git('init', '-q');

      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
      git('add', '.');
      git('commit', '-qm', 'one');

      return git('rev-parse', 'HEAD');
    };

    const deployed = repository('AshishKumar4/armada.git', { 'package.json': '{}' });
    const commit = repository('owner/armada.git', { 'bunfig.toml': 'preload = ["./x.ts"]\n', 'x.ts': 'console.log(process.env.ARMADA_TOKEN)\n' });

    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${scratch}/posted\nprintf '${String(posted)}'\n`);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${scratch}/git\nexec ${realGit} "$@"\n`);
    writeFileSync(join(bin, 'bun'), `#!/bin/sh
case "$1" in install) exit 0 ;; -e) kind=count ;; *) kind=cli ;; esac
printf '%s %s %s\\n' "$kind" "\${GITHUB_TOKEN:-none}" "$(find "$HOME" -name bunfig.toml -o -name x.ts | wc -l | tr -d ' ')" >> ${scratch}/bun
case "$1" in -e) echo '6 of 6 rows green'; exit 0 ;; esac
exit ${String(ran)}
`);

    for (const tool of ['curl', 'git', 'bun']) chmodSync(join(bin, tool), 0o755);

    try {
      const env = {
        ...gitEnv, PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARMADA_GITHUB_SECRET: 'GITHUB_TOKEN', GITHUB_TOKEN: 'gh', ARMADA_URL: 'https://armada.test', ARMADA_TOKEN: TOKEN,
        ARMADA_REPO: 'owner/armada', ARMADA_COMMIT: commit, ARMADA_DEPLOYED: deployed, TARGET_URL: 'https://armada.test/ui',
      };

      const exit = Bun.spawnSync(['/bin/sh', '-c', script], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode;
      const states = readFileSync(join(scratch, 'posted'), 'utf8').match(/"state":"\w+"/gu) ?? [];
      const buns = readFileSync(join(scratch, 'bun'), 'utf8').trim().split('\n').map((line) => line.split(' '));
      // Each commit it fetched, and from where.
      const fetched = readFileSync(join(scratch, 'git'), 'utf8').split('\n').flatMap((line) => /fetch -q (?:--depth 1 )?(\S+) (\S+)/u.exec(line)?.slice(1) ?? []);

      return { exit, states, buns, fetched, deployed, commit };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  test('exits as armada run did, whatever GitHub answered its status posts', () => {
    expect([drive(0, 201), drive(1, 201), drive(0, 500)].map(({ exit, states }) => ({ exit, states }))).toEqual([
      { exit: 0, states: ['"state":"pending"', '"state":"success"'] },
      { exit: 1, states: ['"state":"pending"', '"state":"failure"'] },
      { exit: 0, states: ['"state":"pending"', '"state":"success"'] },
    ]);
  });

  test('fetches armada at the deployed commit and the commit under test, and puts none of its files where its credentials are (#33)', () => {
    const { fetched, buns, deployed, commit } = drive(0, 201);

    expect({ fetched, buns }).toEqual({
      fetched: ['https://github.com/AshishKumar4/armada.git', deployed, 'https://github.com/owner/armada.git', commit],
      buns: [['cli', 'none', '0'], ['count', 'gh', '0']],
    });
  });
});

describe('the webhooks route', () => {
  test('configures with the hook id, lists and removes through the bearer', async () => {
    const object = hooks();
    const env = world({ ARMADA_TOKEN: TOKEN, VERSION: { id: 'v', tag: '', timestamp: '' }, WEBHOOKS: namespace(() => object), ARTIFACTS: bucket() });

    const ask = async (method: string, path: string, body?: Json) => await worker.fetch(new Request(`https://armada.test${path}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': '7', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);

    expect((await ask('POST', '/webhooks/armada', { ...CONFIG, hook: 77 })).status).toBe(200);
    const listed = v.parse(WebhooksSchema, await (await ask('GET', '/webhooks')).json());

    expect(listed.webhooks[0]?.repo).toBe('owner/armada');
    expect(listed.webhooks[0]?.hook).toBe(77);
    expect((await ask('DELETE', '/webhooks/armada')).status).toBe(200);
    expect((await ask('GET', '/webhooks')).status).toBe(200);
    expect(v.parse(WebhooksSchema, await (await ask('GET', '/webhooks')).json()).webhooks).toHaveLength(0);
  });
});

describe('a driver job at claim', () => {
  test('gets the deployment bearer in its env, masked by its secrets list, kept nowhere', async () => {
    const { ArmadaJob } = await import('../src/job');
    const spec = v.parse(JobSpecSchema, driverSpec('armada', SHA, { origin: 'https://armada.test', sha: 'b'.repeat(40) }, CONFIG));

    const open = new ArmadaJob(state().ctx, world({
      ARMADA_TOKEN: TOKEN,
      VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
      ENVIRONMENTS: namespace(() => ({ used: async () => undefined, ensure: async () => ({ kind: 'ready', generation: { key: 'k', snapshot: { id: 's', size: 1 }, sha: null, created: 0, seconds: {} } }) })),
      SECRETS: namespace(() => ({ values: async () => ({ GITHUB_TOKEN: 'gh-token-value' }) })),
    }));

    await open.create('j1', spec);
    await open.alarm();
    const claim = await open.claim('v1');

    if (claim === null || 'waitMs' in claim) throw new Error('the driver item was not claimed');
    expect(claim.env['ARMADA_TOKEN']).toBe(TOKEN);
    expect(claim.env['GITHUB_TOKEN']).toBe('gh-token-value');
    expect(claim.secrets).toContain('ARMADA_TOKEN');
    expect(claim.secrets).toContain('GITHUB_TOKEN');
  });
});
