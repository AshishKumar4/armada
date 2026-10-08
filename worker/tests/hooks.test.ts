/** The GitHub webhook's checks: its signature gate, the event filter, the two dedupes, and the driver job's spec —
 *  exercised through `webhooked` with the DO's own methods on in-memory storage. */
import { describe, expect, test } from 'bun:test';
import { JobSpecSchema, PROTOCOL } from '../../src/protocol';
import { ArmadaWebhooks, driverSpec, eventOf, type HookConfig } from '../src/hooks';
import { webhooked, signed } from '../src/worker';
import * as v from 'valibot';
import { bucket, namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);
const SECRET = 's'.repeat(48);
const SHA = 'a'.repeat(40);

const CONFIG: HookConfig = { repo: 'owner/armada', pullRequests: true, tokenSecret: 'GITHUB_TOKEN', secret: SECRET };

function hooks(state_ = state()): ArmadaWebhooks {
  return new (ArmadaWebhooks as unknown as new (ctx: unknown, env: unknown) => ArmadaWebhooks)(state_.ctx, world({}));
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

async function deliver(objects: Map<string, string>, hooksStub: ArmadaWebhooks, jobs: Record<string, { phase: string }>, payload: object, headers: Record<string, string> = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const env = world({
    ARMADA_TOKEN: TOKEN,
    ARMADA_SHA: 'b'.repeat(40),
    VERSION: { id: 'v', tag: '', timestamp: '' },
    ARTIFACTS: bucket(objects),
    WEBHOOKS: namespace(() => hooksStub),
    JOB: namespace((name) => ({ status: async () => jobs[name] ?? null, create: async () => undefined })),
    SECRETS: namespace(() => ({ values: async () => ({ GITHUB_TOKEN: 'gh' }) })),
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
    expect(await object.configOf('armada')).toEqual(CONFIG);
    expect(await object.remove('armada')).toEqual({ repo: 'owner/armada' });
    expect(await object.configOf('armada')).toBeUndefined();
  });

  test('accepts a good signature, and refuses a bad, a missing, or a wrong-secret one', async () => {
    const body = '{"ref":"refs/heads/main","after":"' + SHA + '"}';

    expect(await signed(SECRET, await sign(SECRET, body), body)).toBe(true);
    expect(await signed(SECRET, 'sha256=' + '0'.repeat(64), body)).toBe(false);
    expect(await signed(SECRET, '', body)).toBe(false);
    expect(await signed('other' + 'o'.repeat(43), await sign(SECRET, body), body)).toBe(false);

    const object = await configured();
    const answer = await deliver(new Map(), object, {}, { ref: 'refs/heads/main', after: SHA });
    const denied = await deliver(new Map(), object, {}, { ref: 'refs/heads/main', after: SHA }, { 'X-Hub-Signature-256': 'sha256=bad', 'X-GitHub-Delivery': 'del-2' });

    expect(denied.status).toBe(401);
    expect((await answer.json()) as object).toEqual({ started: expect.any(String) });
  });

  test('reads the push events: built branch, filtered branch, deletion, tag, ping, and other events', async () => {
    const branches = { repo: 'owner/armada', branches: ['main'], pullRequests: false, secret: SECRET };

    expect(eventOf('push', { ref: 'refs/heads/main', after: SHA }, branches)).toEqual({ kind: 'push', sha: SHA, branch: 'main' });
    expect(eventOf('push', { ref: 'refs/heads/dev', after: SHA }, branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', { ref: 'refs/heads/main', after: '0'.repeat(40) }, branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', { ref: 'refs/tags/v1', after: SHA }, branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('ping', {}, branches)).toEqual({ kind: 'ping' });
    expect(eventOf('release', {}, branches)).toEqual({ kind: 'ignore' });
    expect(eventOf('push', 'not-an-object', branches)).toEqual({ kind: 'ignore' });
  });

  test('reads pull requests: opened, synchronize, reopened from the same repo only, and a fork refused', async () => {
    const config = { repo: 'owner/armada', pullRequests: true, secret: SECRET };
    const pr = (action: string, repo = 'owner/armada') => ({ action, pull_request: { head: { sha: SHA, repo: { full_name: repo } } } });

    expect(eventOf('pull_request', pr('opened'), config)).toEqual({ kind: 'pr', sha: SHA });
    expect(eventOf('pull_request', pr('synchronize'), config)).toEqual({ kind: 'pr', sha: SHA });
    expect(eventOf('pull_request', pr('reopened'), config)).toEqual({ kind: 'pr', sha: SHA });
    expect(eventOf('pull_request', pr('closed'), config)).toEqual({ kind: 'ignore' });
    expect(eventOf('pull_request', pr('opened', 'forker/armada'), config)).toEqual({ kind: 'fork' });
    expect(eventOf('pull_request', pr('opened'), { ...config, pullRequests: false })).toEqual({ kind: 'ignore' });
  });

  test('dedupes a redelivered id, a commit with a verdict, and a commit with an open driver', async () => {
    const object = await configured();
    const objects = new Map<string, string>();
    const push = { ref: 'refs/heads/main', after: SHA };

    const first = await deliver(objects, object, {}, push, { 'X-GitHub-Delivery': 'del-1' });
    expect((await first.json()) as object).toEqual({ started: expect.any(String) });

    const again = await deliver(objects, object, {}, push, { 'X-GitHub-Delivery': 'del-1' });
    expect((await again.json()) as object).toEqual({ note: 'duplicate' });

    const judged = await deliver(new Map([['verdicts/armada/' + SHA + '.json', '{}']]), object, {}, push, { 'X-GitHub-Delivery': 'del-2' });
    expect((await judged.json()) as object).toEqual({ note: 'already' });

    await object.drove('armada', SHA, 'job-1');
    const running = await deliver(objects, object, { 'job-1': { phase: 'running' } }, push, { 'X-GitHub-Delivery': 'del-3' });
    expect((await running.json()) as object).toEqual({ note: 'already' });

    const done = await deliver(objects, object, { 'job-1': { phase: 'done' } }, push, { 'X-GitHub-Delivery': 'del-4' });
    expect((await done.json()) as object).toEqual({ started: expect.any(String) });
  });

  test('builds the driver spec: micro command, ci label, secrets by name only, the bearer at claim', () => {
    const spec = v.parse(JobSpecSchema, driverSpec('armada', SHA, 'https://armada.test', 'b'.repeat(40), CONFIG));

    expect(spec.label).toBe(`ci armada ${SHA.slice(0, 12)}`);
    expect(spec.run).toEqual({ kind: 'command' });
    expect(spec.secrets).toEqual(['GITHUB_TOKEN']);
    expect(spec.deployToken).toBe(true);
    expect(spec.recipe.size).toBe('micro');
    expect(spec.env['ARMADA_REPO']).toBe('owner/armada');
    expect(spec.env['ARMADA_COMMIT']).toBe(SHA);
    expect(spec.env['TARGET_URL']).toBe(`https://armada.test/ui/#/ci/armada/${SHA}`);
    expect(JSON.stringify(spec.env)).not.toContain(TOKEN);
    expect(JSON.stringify(spec)).not.toContain('gh-token-value');
    const script = spec.items[0]?.argv?.[2] ?? '';
    expect(script).toContain('armada run');
    expect(script).toContain('--json');
  });
});

describe('a driver job at claim', () => {
  test('gets the deployment bearer in its env, masked by its secrets list, kept nowhere', async () => {
    const { ArmadaJob } = await import('../src/job');
    const spec = v.parse(JobSpecSchema, driverSpec('armada', SHA, 'https://armada.test', 'b'.repeat(40), CONFIG));
    const open = new ArmadaJob(state().ctx, world({
      ARMADA_TOKEN: TOKEN,
      VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
      ENVIRONMENTS: namespace(() => ({ ensure: async () => ({ kind: 'ready', generation: { key: 'k', snapshot: { id: 's', size: 1 }, sha: null, created: 0, seconds: {} } }) })),
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
