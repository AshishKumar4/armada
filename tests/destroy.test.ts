import { describe, expect, test } from 'bun:test';
import { destroyDeployment, destroyName, type DestroyIO, type DestroyState, type WranglerResult } from '../src/destroy';
import { PROTOCOL, PROTOCOL_HEADER, type Json } from '../src/protocol';
import type { Connection } from '../src/sdk';
import { fakeFetch, settled } from './fakes';

const NAME = 'armada-dew2';

const ACCOUNT = 'account';

const NOW = Date.parse('2026-10-11T12:00:00Z');

const RULE = { id: 'armada-destroy-all', enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } }, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } } };

/** Every request and process is answered in memory, including the named dew2 connection. Never reads user config. */
class Fleet implements DestroyIO {
  readonly events: string[] = [];
  readonly messages: string[] = [];
  scripts = [{ id: NAME }, { id: 'armada-dew3' }];
  namespaces = [
    { id: 'vessel', script: NAME, class: 'ArmadaVessel' },
    { id: 'preparer', script: NAME, class: 'ArmadaPreparer' },
    { id: 'job', script: NAME, class: 'ArmadaJob' },
    { id: 'other-vessel', script: 'armada-dew3', class: 'ArmadaVessel' },
  ];
  applications = [
    { id: 'app-vessel', name: `${NAME}-armadavessel`, durable_objects: { namespace_id: 'vessel' } },
    { id: 'app-preparer', name: `${NAME}-armadapreparer`, durable_objects: { namespace_id: 'preparer' } },
    { id: 'app-other', name: 'armada-dew3-armadavessel', durable_objects: { namespace_id: 'other-vessel' } },
  ];
  jobs: { id: string; label: string; phase: 'done' | 'running' | 'preparing' }[] = [];
  admitDuringRead = false;
  inventoryAvailable = true;
  protocol = PROTOCOL;
  jobStatus = 200;
  bucketExists = true;
  objects = 0;
  uploads = 0;
  rules: Json[] = [];
  refs = new Set(['snapshot-1', 'snapshot-2']);
  state: DestroyState | null = null;
  connected = true;
  fault = '';
  snapshotLeft = false;
  leaveNamespaces = false;
  otherReference = false;
  twoScriptPages = false;
  directContainers = false;

  readonly fetch = fakeFetch((request) => this.answer(request));
  readonly now = () => NOW;
  readonly say = (message: string) => { this.messages.push(message); };
  readonly connection = (): Connection | null => {
    this.events.push('connection');

    return this.connected ? { url: `https://${NAME}.test.workers.dev`, account: ACCOUNT, token: 'fake-dew2-token' } : null;
  };
  readonly load = () => this.state === null ? null : structuredClone(this.state);
  readonly save = (state: DestroyState) => { this.state = structuredClone(state); this.events.push('checkpoint'); };
  readonly removeState = () => { this.state = null; this.events.push('remove checkpoint'); };
  readonly removeConnection = () => {
    if (!this.connected) return;
    this.connected = false;
    this.events.push('remove connection');
  };
  readonly credentials = async (account: string, token: string) => {
    expect([account, token]).toEqual([ACCOUNT, 'fake-oauth']);
    this.events.push('credentials');

    return 'fake-registry';
  };
  readonly snapshot: DestroyIO['snapshot'] = async (credentials, ref, remember) => {
    expect(credentials).toBe('fake-registry');
    this.events.push(`snapshot ${ref}`);

    if (!this.refs.has(ref)) return { kind: 'absent' };
    const digest = ref.startsWith('sha256:') ? ref : `sha256:${ref}`;

    remember(digest);
    this.refs.add(digest);
    this.refs.delete(ref);

    if (this.fault === 'snapshot') throw new Error('snapshot network loss');

    if (this.snapshotLeft) return { kind: 'left', digest, reason: '503' };
    this.refs.delete(digest);

    return { kind: 'deleted' };
  };
  readonly image: DestroyIO['image'] = async () => { throw new Error('current deploy creates no registry images'); };

  readonly run = (words: readonly string[], account: string): WranglerResult => {
    expect(account).toBe(ACCOUNT);
    const command = words.join(' ');

    this.events.push(`wrangler ${command}`);

    if (command === this.fault) return { exitCode: 1, output: 'permission denied' };

    if (command === 'auth token') return { exitCode: 0, output: 'fake-oauth' };

    if (command === `delete --name=${NAME} --force`) {
      this.scripts = this.scripts.filter((script) => script.id !== NAME);

      if (!this.leaveNamespaces) this.namespaces = this.namespaces.filter((namespace) => namespace.script !== NAME);

      return { exitCode: 0, output: 'deleted' };
    }

    if (words.slice(0, 4).join(' ') === 'r2 bucket lifecycle add') {
      expect(words).toEqual(['r2', 'bucket', 'lifecycle', 'add', `${NAME}-artifacts`, 'armada-destroy-all', '', '--expire-days', '1', '--abort-multipart-days', '1', '--force']);
      this.rules.push(RULE);

      return { exitCode: 0, output: 'rule added' };
    }

    if (command === `r2 bucket delete ${NAME}-artifacts`) {
      if (this.objects > 0 || this.uploads > 0) return { exitCode: 1, output: 'The bucket you tried to delete is not empty [code: 10008]' };
      this.bucketExists = false;

      return { exitCode: 0, output: 'deleted' };
    }

    throw new Error(`unexpected wrangler command ${command}`);
  };

  private answer(request: Request): Response {
    const url = new URL(request.url);
    const path = url.pathname;

    this.events.push(`${request.method} ${path}${url.search}`);

    if (url.hostname.endsWith('.workers.dev')) return this.worker(request, url);
    expect(request.headers.get('authorization')).toBe('Bearer fake-oauth');
    const base = `/client/v4/accounts/${ACCOUNT}`;

    if (path === `${base}/workers/scripts`) {
      if (this.twoScriptPages) return Response.json({ success: true, result: url.searchParams.get('page') === '1' ? this.scripts.slice(0, 1) : this.scripts.slice(1), result_info: { total_pages: 2 } });

      return this.envelope(this.scripts);
    }

    if (path === `${base}/workers/durable_objects/namespaces`) return this.envelope(this.namespaces);

    if (path === `${base}/containers/applications`) return this.directContainers ? Response.json(this.applications) : Response.json({ success: true, result: this.applications, errors: [], messages: [], result_info: {} });

    if (path.startsWith(`${base}/containers/applications/`) && request.method === 'DELETE') {
      const id = path.split('/').at(-1);

      if (this.fault === 'application') return new Response('permission denied', { status: 403 });
      this.applications = this.applications.filter((application) => application.id !== id);

      return new Response(null, { status: 204 });
    }

    if (path === `${base}/workers/scripts/${NAME}/references`) return this.envelope({ services: { incoming: this.otherReference ? [{ script: 'another-worker' }] : [] } });

    if (path === `${base}/workers/tails/by-consumer/${NAME}`) return this.envelope([]);

    if (path === `${base}/r2/buckets/${NAME}-artifacts`) return this.bucketExists ? this.envelope({ name: `${NAME}-artifacts` }) : new Response(null, { status: 404 });

    if (path === `${base}/r2/buckets/${NAME}-artifacts/lifecycle`) return this.envelope({ rules: this.rules });

    throw new Error(`unexpected API request ${request.method} ${path}`);
  }

  private worker(request: Request, url: URL): Response {
    expect(request.headers.get('authorization')).toBe('Bearer fake-dew2-token');

    if (request.headers.get(PROTOCOL_HEADER) !== String(this.protocol)) return new Response(null, { status: 426 });

    if (url.pathname === '/jobs') {
      if (this.jobStatus !== 200) return new Response(null, { status: this.jobStatus });
      const before = url.searchParams.get('before');
      const start = before === null ? 0 : this.jobs.findIndex((job) => job.id === before) + 1;
      const jobs = this.jobs.slice(start, start + 100);

      if (this.admitDuringRead) {
        this.admitDuringRead = false;
        this.jobs.unshift({ id: 'raced', label: 'new arrival', phase: 'preparing' });
      }

      return Response.json({ jobs });
    }

    if (url.pathname === '/drain') return this.protocol < 2 ? new Response(null, { status: 404 }) : Response.json({ jobs: this.jobs.filter((job) => job.phase !== 'done').length });

    if (url.pathname === '/environments/inventory') return this.inventoryAvailable ? Response.json({ snapshots: [...this.refs], credentialsExpire: '2027-10-01T00:00:00Z' }) : new Response(null, { status: 404 });

    if (url.pathname === '/environments') return Response.json([...this.refs].map((id) => ({ entry: { state: 'ready', generation: { snapshot: { id } } } })));

    throw new Error(`unexpected deployment request ${url.pathname}`);
  }

  private envelope(result: Json): Response { return Response.json({ success: true, result }); }
}

describe('destroy, against a fake wrangler and fake named deployment only', () => {
  test('accepts the Containers v4 response envelope captured from the retired deployment account', async () => {
    const fleet = new Fleet();

    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.applications.map((application) => application.id)).toEqual(['app-other']);
  });

  test('also accepts the legacy direct-array Containers response', async () => {
    const fleet = new Fleet();

    fleet.directContainers = true;
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
  });

  test('records ownership before deleting the Worker, its namespaces, applications, snapshots, bucket, and local connection', async () => {
    const fleet = new Fleet();

    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    const actions = fleet.events.filter((event) => event === 'checkpoint' || event.startsWith('wrangler delete') || event.startsWith('DELETE ') || event.startsWith('snapshot ') || event.startsWith('wrangler r2') || event.startsWith('remove '));

    expect(actions).toEqual([
      'checkpoint', `wrangler delete --name=${NAME} --force`, 'checkpoint',
      `DELETE /client/v4/accounts/${ACCOUNT}/containers/applications/app-vessel`,
      `DELETE /client/v4/accounts/${ACCOUNT}/containers/applications/app-preparer`,
      'snapshot snapshot-1', 'checkpoint', 'checkpoint', 'snapshot snapshot-2', 'checkpoint', 'checkpoint',
      `wrangler r2 bucket lifecycle add ${NAME}-artifacts armada-destroy-all  --expire-days 1 --abort-multipart-days 1 --force`,
      'checkpoint', `wrangler r2 bucket delete ${NAME}-artifacts`, 'remove connection', 'remove checkpoint',
    ]);
    expect(fleet.scripts).toEqual([{ id: 'armada-dew3' }]);
    expect(fleet.applications.map((application) => application.id)).toEqual(['app-other']);
    expect(fleet.namespaces.map((namespace) => namespace.id)).toEqual(['other-vessel']);
    expect(fleet.refs.size).toBe(0);
    expect(fleet.messages.some((message) => message.includes('cannot be revoked individually'))).toBe(true);
  });

  test('a second complete run skips every absent resource and does not read a removed connection', async () => {
    const fleet = new Fleet();

    await destroyDeployment(NAME, ACCOUNT, false, fleet);
    fleet.events.length = 0;
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.events.filter((event) => event.includes('DELETE') || event.startsWith('wrangler delete') || event.startsWith('wrangler r2') || event.startsWith('snapshot ') || event === 'connection')).toEqual([]);
  });

  test('refuses open jobs, listing their IDs and labels without changing admission or resources', async () => {
    const fleet = new Fleet();

    fleet.jobs.push({ id: 'j1', label: 'running build', phase: 'running' });
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('j1 (running build) [running]');
    expect(fleet.state).toBeNull();
    expect(fleet.events.some((event) => event.startsWith('POST ') || event.startsWith('DELETE ') || event.startsWith('wrangler delete'))).toBe(false);
  });

  test('--force explicitly names open jobs and proceeds, without granting access to another deployment', async () => {
    const fleet = new Fleet();

    fleet.jobs.push({ id: 'j1', label: 'still running', phase: 'running' }, { id: 'j2', label: 'installing', phase: 'preparing' });
    expect(await destroyDeployment(NAME, ACCOUNT, true, fleet)).toBe(0);
    expect(fleet.messages.some((message) => message.includes('--force: ending open jobs: j1 (still running) [running], j2 (installing) [preparing]'))).toBe(true);
    expect(fleet.applications.map((application) => application.id)).toEqual(['app-other']);
  });

  test('pages through completed jobs to find an open job on a later page', async () => {
    const fleet = new Fleet();

    fleet.jobs = Array.from({ length: 100 }, (_, index) => ({ id: `done-${String(index)}`, label: '', phase: 'done' }));
    fleet.jobs.push({ id: 'older-open', label: '', phase: 'running' });
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('older-open');
    expect(fleet.events).toContain('GET /jobs?limit=100&before=done-99');
  });

  test('uses armada-protocol when an old Worker refuses the current wire; inventories its exact ready refs', async () => {
    const fleet = new Fleet();

    fleet.protocol = 3;
    fleet.inventoryAvailable = false;
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.messages.some((message) => message.includes('unrecorded snapshots and deletion debts'))).toBe(true);
    expect(fleet.refs.size).toBe(0);
  });

  test('detects a job admitted during discovery and restores admission on refusal', async () => {
    const fleet = new Fleet();

    fleet.admitDuringRead = true;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('raced');
    expect(fleet.events).toContain('DELETE /drain');
    expect(fleet.scripts.some((script) => script.id === NAME)).toBe(true);
  });

  test('force does not bypass an unreadable job list or a missing connection', async () => {
    const unreadable = new Fleet();

    unreadable.jobStatus = 503;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, unreadable))).toContain('GET /jobs');
    const missing = new Fleet();

    missing.connected = false;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, missing))).toContain('without its named local connection');
    expect(unreadable.state).toBeNull();
    expect(missing.state).toBeNull();
  });

  test('refuses a prefix even when the exact Worker exists, including a matching name on a later account page', async () => {
    const fleet = new Fleet();

    fleet.scripts.unshift({ id: 'armada' });
    fleet.twoScriptPages = true;
    expect(await settled(destroyDeployment('armada', ACCOUNT, true, fleet))).toContain('prefix of other deployments');
    expect(fleet.events).not.toContain('connection');
    expect(fleet.state).toBeNull();
  });

  test('refuses a literal name prefix even without a dash boundary', async () => {
    const fleet = new Fleet();

    fleet.scripts.push({ id: `${NAME}0` });
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, fleet))).toContain('prefix of other deployments');
    expect(fleet.events).not.toContain('connection');
  });

  test('refuses an exact application name attached to another deployment\'s namespace', async () => {
    const fleet = new Fleet();
    const application = fleet.applications[0];

    if (application === undefined) throw new Error('missing fake application');
    application.durable_objects.namespace_id = 'other-vessel';
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, fleet))).toContain('cannot prove');
    expect(fleet.events.some((event) => event.startsWith('wrangler delete'))).toBe(false);
    expect(fleet.state).toBeNull();
  });

  test('--force never breaks another Worker\'s bindings', async () => {
    const fleet = new Fleet();

    fleet.otherReference = true;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, fleet))).toContain('referenced by another Worker');
    expect(fleet.events).toContain('DELETE /drain');
    expect(fleet.scripts.some((script) => script.id === NAME)).toBe(true);
  });

  test('retains the inventory and connection on an application failure, then resumes without the gone Worker', async () => {
    const fleet = new Fleet();

    fleet.fault = 'application';
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('403');
    expect(fleet.state?.workerDeleted).toBe(true);
    expect(fleet.connected).toBe(true);
    fleet.fault = '';
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.events.filter((event) => event.startsWith('wrangler delete')).length).toBe(1);
  });

  test('a failed Worker deletion restores admission; retry inventories snapshots from subsequently completed jobs', async () => {
    const fleet = new Fleet();

    fleet.fault = `delete --name=${NAME} --force`;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('permission denied');
    expect(fleet.events).toContain('DELETE /drain');
    expect(fleet.state?.workerDeleted).toBe(false);
    fleet.refs.add('snapshot-later');
    fleet.fault = '';
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.refs.size).toBe(0);
    expect(fleet.events).toContain('snapshot snapshot-later');
  });

  test('a checkpoint cannot authorize a different account or a foreign namespace', async () => {
    const fleet = new Fleet();

    fleet.fault = `delete --name=${NAME} --force`;
    await settled(destroyDeployment(NAME, ACCOUNT, false, fleet));
    const saved = fleet.state;

    if (saved === null) throw new Error('missing fake checkpoint');
    saved.account = 'other-account';
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, fleet))).toContain('another deployment or account');
    saved.account = ACCOUNT;
    saved.namespaces.push({ id: 'foreign', script: 'armada-dew3', class: 'ArmadaJob' });
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, fleet))).toContain('belongs to armada-dew3');
  });

  test('a mismatched whole-bucket expiry rule is refused instead of assuming a partial-prefix rule empties it', async () => {
    const fleet = new Fleet();

    fleet.rules.push({ ...RULE, conditions: { prefix: 'jobs/' } });
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('different actions');
    expect(fleet.connected).toBe(true);
    expect(fleet.events.some((event) => event.startsWith('wrangler r2 bucket delete'))).toBe(false);
  });

  test('journals a manifest digest before a tag deletion with a lost response, then removes it on retry', async () => {
    const fleet = new Fleet();

    fleet.fault = 'snapshot';
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('snapshot network loss');
    expect(fleet.state?.snapshots).toContain('sha256:snapshot-1');
    fleet.fault = '';
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.refs.size).toBe(0);
  });

  test('partial manifest deletion saves both the exact original ref and its digest until a successful retry', async () => {
    const fleet = new Fleet();

    fleet.snapshotLeft = true;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('left manifest');
    expect(fleet.state?.snapshots).toEqual(['snapshot-1', 'snapshot-2', 'sha256:snapshot-1']);
    fleet.snapshotLeft = false;
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.refs.size).toBe(0);
  });

  test('sets one whole-bucket day-long expiry/abort rule; re-run removes the empty bucket without S3 or per-object calls', async () => {
    const fleet = new Fleet();

    fleet.objects = 100_001;
    fleet.uploads = 17;
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(1);
    expect(fleet.messages).toContain(`bucket ${NAME}-artifacts expiring; re-run after 2026-10-12T12:00:00.000Z to remove it (lifecycle processing may take longer)`);
    expect(fleet.state?.bucketAfter).toBe(NOW + 86400_000);
    expect(fleet.connected).toBe(false);
    expect(fleet.rules).toEqual([RULE]);
    fleet.objects = 0;
    fleet.uploads = 0;
    expect(await destroyDeployment(NAME, ACCOUNT, false, fleet)).toBe(0);
    expect(fleet.events.filter((event) => event.startsWith('wrangler r2 bucket lifecycle add')).length).toBe(1);
    expect(fleet.state).toBeNull();
  });

  test('bucket permissions failures are not mistaken for lifecycle processing', async () => {
    const fleet = new Fleet();

    fleet.fault = `r2 bucket delete ${NAME}-artifacts`;
    expect(await settled(destroyDeployment(NAME, ACCOUNT, false, fleet))).toContain('permission denied');
    expect(fleet.connected).toBe(true);
    expect(fleet.state).not.toBeNull();
  });

  test('refuses a name redeployed while an unfinished purge is waiting for R2', async () => {
    const fleet = new Fleet();

    fleet.objects = 1;
    await destroyDeployment(NAME, ACCOUNT, false, fleet);
    fleet.scripts.push({ id: NAME });
    expect(await settled(destroyDeployment(NAME, ACCOUNT, true, fleet))).toContain('deployed again');
    expect(fleet.events.filter((event) => event.startsWith('wrangler delete')).length).toBe(1);
  });

  test('invalid or absent names cannot reach the runner or filesystem', () => {
    for (const name of [undefined, '', '../armada-dew2', 'ARMADA', 'armada/kinu']) expect(() => destroyName(name)).toThrow('destroy needs --name');
    expect(destroyName(NAME)).toBe(NAME);
  });
});
