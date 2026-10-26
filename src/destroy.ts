/** A deployment's purge. Discovery is read-only; its exact inventory is saved before the Worker (and its objects)
 * goes, so a failure never loses the snapshot IDs needed on the next run. R2 empties by lifecycle, without S3 keys. */
import * as v from 'valibot';
import { PROTOCOL, PROTOCOL_HEADER, JsonSchema, type Json } from './protocol';
import { ConnectionSchema, type Connection } from './sdk';
import type { Deletion } from './registry';

const Namespace = v.object({ id: v.string(), script: v.string(), class: v.string() });

const Application = v.object({
  id: v.string(), name: v.string(),
  durable_objects: v.optional(v.object({ namespace_id: v.optional(v.string()) })),
  configuration: v.optional(v.object({ image: v.optional(v.string()) })),
});

const Image = v.object({ repository: v.string(), tag: v.string() });

export const DestroyStateSchema = v.object({
  name: v.string(), account: v.string(), workerDeleted: v.boolean(),
  namespaces: v.array(Namespace), applications: v.array(Application), snapshots: v.array(v.string()), images: v.array(Image),
  bucketAfter: v.optional(v.number()),
});

export type DestroyState = v.InferOutput<typeof DestroyStateSchema>;

export interface WranglerResult { readonly exitCode: number; readonly output: string }

/** The CLI owns the filesystem and wrangler invocation; tests supply an entirely local fleet here. */
export interface DestroyIO {
  readonly run: (words: readonly string[], account: string) => WranglerResult;
  readonly fetch: typeof fetch;
  readonly connection: () => Connection | null;
  readonly load: () => DestroyState | null;
  readonly save: (state: DestroyState) => void;
  readonly removeConnection: () => void;
  readonly removeState: () => void;
  readonly snapshot: (credentials: string, ref: string, remember: (digest: string) => Promise<void>) => Promise<Deletion>;
  readonly image: (credentials: string, repository: string, tag: string, remember: (digest: string) => Promise<void>) => Promise<Deletion>;
  readonly credentials: (account: string, token: string) => Promise<string>;
  readonly say: (message: string) => void;
  readonly now: () => number;
}

const Envelope = v.object({
  success: v.boolean(), result: v.optional(JsonSchema),
  errors: v.nullish(v.array(v.object({ message: v.string() })), []),
  result_info: v.optional(v.object({ total_pages: v.optional(v.number()) })),
});

const Jobs = v.object({ jobs: v.array(v.object({ id: v.string(), label: v.optional(v.string(), ''), phase: v.picklist(['preparing', 'running', 'done']) })) });

const Entries = v.array(v.object({ entry: v.object({ state: v.string(), generation: v.optional(v.object({ snapshot: v.object({ id: v.string() }) })) }) }));

const Inventory = v.object({ snapshots: v.array(v.string()), credentialsExpire: v.optional(v.string()) });

const DAY = 24 * 60 * 60_000;

const EXPIRY_RULE = 'armada-destroy-all';

const Lifecycle = v.object({ rules: v.array(v.object({
  id: v.string(), enabled: v.boolean(), conditions: v.object({ prefix: v.optional(v.string()) }),
  deleteObjectsTransition: v.optional(v.object({ condition: v.object({ type: v.string(), maxAge: v.optional(v.number()) }) })),
  abortMultipartUploadsTransition: v.optional(v.object({ condition: v.object({ type: v.string(), maxAge: v.optional(v.number()) }) })),
})) });

/** Only a validated Worker name can reach discovery, file paths, or a destructive command. */
export function destroyName(name: string | undefined): string {
  if (name === undefined || !/^[a-z][a-z0-9-]{0,40}$/u.test(name)) throw new Error('destroy needs --name=<name>: lowercase letters, digits and dashes, starting with a letter');

  return name;
}

class Cloudflare {
  constructor(private readonly account: string, private readonly token: string, private readonly io: DestroyIO) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return await this.io.fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.account)}${path}`, {
      ...init, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
    });
  }

  async read(path: string): Promise<Json> {
    const answer = await this.request(path);

    if (answer.status === 404) return null;
    const decoded = v.parse(Envelope, await answer.json());

    if (!answer.ok || !decoded.success) throw new Error(`Cloudflare GET ${path} answered ${String(answer.status)}: ${decoded.errors.map((error) => error.message).join('; ')}`);

    return decoded.result ?? null;
  }

  async list(path: string): Promise<Json[]> {
    const items: Json[] = [];

    for (let page = 1; ; page += 1) {
      const answer = await this.request(`${path}?per_page=1000&page=${String(page)}`);
      const decoded = v.parse(Envelope, await answer.json());

      if (!answer.ok || !decoded.success) throw new Error(`Cloudflare GET ${path} answered ${String(answer.status)}: ${decoded.errors.map((error) => error.message).join('; ')}`);
      const batch = v.parse(v.array(JsonSchema), decoded.result);

      items.push(...batch);

      if (batch.length === 0 || page >= (decoded.result_info?.total_pages ?? (batch.length < 1000 ? page : Infinity))) return items;
    }
  }

  async removeApplication(id: string): Promise<boolean> {
    const answer = await this.request(`/containers/applications/${encodeURIComponent(id)}`, { method: 'DELETE' });

    if (answer.status === 404) return false;

    if (!answer.ok) throw new Error(`Cloudflare deleting application ${id} answered ${String(answer.status)}: ${await answer.text()}`);

    return true;
  }
}

/** The deployed wire may predate this CLI. A 426 tries each older armada-protocol; no other error is ignored. */
class Deployment {
  private protocol = PROTOCOL;

  constructor(private readonly connection: Connection, private readonly io: DestroyIO) {}

  async call(path: string, method = 'GET'): Promise<Response> {
    for (; this.protocol >= 1; this.protocol -= 1) {
      const answer = await this.io.fetch(this.connection.url.replace(/\/$/u, '') + path, {
        method, headers: { authorization: `Bearer ${this.connection.token}`, [PROTOCOL_HEADER]: String(this.protocol) },
      });

      if (answer.status === 426) continue;

      if (!answer.ok && answer.status !== 404) throw new Error(`cannot inspect deployment: ${method} ${path} answered ${String(answer.status)}`);

      return answer;
    }

    throw new Error('cannot inspect deployment: no supported armada-protocol');
  }

  async open(): Promise<v.InferOutput<typeof Jobs>['jobs']> {
    const open: v.InferOutput<typeof Jobs>['jobs'] = [];
    const seen = new Set<string>();
    let before: string | undefined;

    for (;;) {
      const answer = await this.call(`/jobs?limit=100${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`);

      if (answer.status === 404) throw new Error('cannot inspect deployment: GET /jobs is unavailable; refusing to destroy it');
      const { jobs } = v.parse(Jobs, await answer.json());

      for (const job of jobs) {
        if (seen.has(job.id)) throw new Error('GET /jobs repeated an id while paging; refusing an incomplete job check');
        seen.add(job.id);

        if (job.phase !== 'done') open.push(job);
      }

      if (jobs.length < 100) return open;
      before = jobs.at(-1)?.id;
    }
  }

  async inventory(): Promise<string[]> {
    const answer = await this.call('/environments/inventory');

    if (answer.status !== 404) {
      const inventory = v.parse(Inventory, await answer.json());

      if (inventory.credentialsExpire !== undefined) this.io.say(`issued registry credentials expire at ${inventory.credentialsExpire}; Cloudflare cannot revoke them individually`);

      return inventory.snapshots;
    }

    const legacy = await this.call('/environments');

    if (legacy.status === 404) throw new Error('cannot inventory this deployment\'s snapshots: GET /environments is unavailable');
    this.io.say('older Worker exposes only its ready snapshots; unrecorded snapshots and deletion debts cannot be identified safely and are not swept');

    return v.parse(Entries, await legacy.json()).flatMap(({ entry }) => entry.state === 'ready' && entry.generation !== undefined ? [entry.generation.snapshot.id] : []);
  }
}

/** Saves each digest before its tags can disappear. Used by both snapshot and built-image deletion. */
class ManifestJournal {
  digest: string | undefined;

  constructor(private readonly state: DestroyState, private readonly io: DestroyIO) {}

  readonly remember = async (digest: string): Promise<void> => {
    this.digest = digest;

    if (!this.state.snapshots.includes(digest)) this.state.snapshots.push(digest);
    this.io.save(this.state);
  };
}

function ran(io: DestroyIO, account: string, words: readonly string[]): string {
  const result = io.run(words, account);

  if (result.exitCode !== 0) throw new Error(`wrangler ${words.slice(0, 3).join(' ')} exited ${String(result.exitCode)}:\n${result.output.slice(-3000)}`);

  return result.output;
}

function refuseJobs(io: DestroyIO, jobs: v.InferOutput<typeof Jobs>['jobs'], force: boolean): void {
  if (jobs.length === 0) return;
  const names = jobs.map((job) => `${job.id}${job.label === '' ? '' : ` (${job.label})`} [${job.phase}]`).join(', ');

  if (!force) throw new Error(`deployment has open jobs: ${names}; wait for them to finish, or use --force to end them`);
  io.say(`--force: ending open jobs: ${names}`);
}

function ownImages(account: string, name: string, applications: v.InferOutput<typeof Application>[]): v.InferOutput<typeof Image>[] {
  return applications.flatMap((application) => {
    const image = application.configuration?.image;

    if (image === undefined || !image.startsWith(`registry.cloudflare.com/${account}/`)) return [];
    const ref = image.slice('registry.cloudflare.com/'.length);
    const split = ref.lastIndexOf(':');
    const repository = ref.slice(0, split);
    const tag = ref.slice(split + 1);
    const expected = `${account}/${application.name.toLowerCase()}`;

    // Current deploy uses no registry image. An older deploy's built image is exactly its application repository;
    // shared/external images are inputs, not resources this deployment owns.
    if (split < 0 || ![expected, `${expected}-image`].includes(repository) || !application.name.startsWith(`${name}-`)) throw new Error(`cannot prove ownership of registry image ${image}; refusing to delete an account-wide image`);

    return [{ repository, tag }];
  });
}

/** Guard a saved inventory too: it is not authority to delete another name's application or namespace. */
function validateInventory(state: DestroyState): void {
  const namespaces = new Map(state.namespaces.map((namespace) => [namespace.id, namespace]));
  const names = new Set(['armadavessel', 'armadapreparer'].map((kind) => `${state.name}-${kind}`));

  for (const namespace of state.namespaces) {
    if (namespace.script !== state.name) throw new Error(`namespace ${namespace.id} belongs to ${namespace.script}, not ${state.name}`);
  }

  for (const application of state.applications) {
    const namespace = namespaces.get(application.durable_objects?.namespace_id ?? '');

    if (!names.has(application.name) || namespace?.script !== state.name || application.name !== `${state.name}-${namespace.class.toLowerCase()}`) throw new Error(`cannot prove ${state.name} owns container application ${application.name}`);
  }

  for (const image of state.images) {
    if (!state.applications.some((application) => [application.name, `${application.name}-image`].includes(image.repository.slice(state.account.length + 1))) || !image.repository.startsWith(`${state.account}/`)) throw new Error(`cannot prove ${state.name} owns image ${image.repository}`);
  }
}

/** Lifecycle deletes in bulk asynchronously and aborts abandoned multipart uploads. Only "not empty" is deferred;
 * auth, permissions, and other failures leave the checkpoint and the connection available to retry. */
async function expireBucket(cloud: Cloudflare, state: DestroyState, io: DestroyIO): Promise<boolean> {
  const bucket = `${state.name}-artifacts`;
  const account = state.account;
  const info = await cloud.read(`/r2/buckets/${bucket}`);

  if (info === null) return true;
  const { rules } = v.parse(Lifecycle, await cloud.read(`/r2/buckets/${bucket}/lifecycle`));
  const rule = rules.find((each) => each.id === EXPIRY_RULE);

  if (rule !== undefined && (!rule.enabled || (rule.conditions.prefix ?? '') !== '' || rule.deleteObjectsTransition?.condition.type !== 'Age' || rule.deleteObjectsTransition.condition.maxAge !== 86400 || rule.abortMultipartUploadsTransition?.condition.type !== 'Age' || rule.abortMultipartUploadsTransition.condition.maxAge !== 86400)) throw new Error(`bucket lifecycle rule ${EXPIRY_RULE} already exists with different actions; refusing to assume it empties this bucket`);

  if (rule === undefined) ran(io, account, ['r2', 'bucket', 'lifecycle', 'add', bucket, EXPIRY_RULE, '', '--expire-days', '1', '--abort-multipart-days', '1', '--force']);

  if (state.bucketAfter === undefined) {
    state.bucketAfter = io.now() + DAY;
    io.save(state);
  }

  const removed = io.run(['r2', 'bucket', 'delete', bucket], account);

  if (removed.exitCode === 0 || removed.output.includes('[code: 10006]')) {
    io.say(`removed bucket ${bucket}`);

    return true;
  }

  if (!/bucket[^\n]*(?:not empty|non[- ]empty)|(?:not empty|non[- ]empty)[^\n]*bucket/iu.test(removed.output)) throw new Error(`cannot delete bucket ${bucket}: ${removed.output.slice(-3000)}`);
  io.say(`bucket ${bucket} expiring; re-run after ${new Date(state.bucketAfter).toISOString()} to remove it (lifecycle processing may take longer)`);

  return false;
}

/** Returns 0 only when the remote purge is complete, 1 while R2's asynchronous lifecycle still has work to do. */
export async function destroyDeployment(name: string, account: string, force: boolean, io: DestroyIO): Promise<number> {
  destroyName(name);
  const token = ran(io, account, ['auth', 'token']).trim().split('\n').at(-1)?.trim() ?? '';

  if (token === '') throw new Error('wrangler supplied no authentication token');
  const cloud = new Cloudflare(account, token, io);
  const scripts = v.parse(v.array(v.object({ id: v.string() })), await cloud.list('/workers/scripts'));
  const namespaces = v.parse(v.array(Namespace), await cloud.list('/workers/durable_objects/namespaces'));
  const applications = v.parse(v.array(Application), await cloud.read('/containers/applications'));
  // Every resource below is matched by the exact name, never a prefix: `armada` is destroyed beside `armada-kinu` (#55).
  const worker = scripts.some((script) => script.id === name);
  let state = io.load();

  if (state !== null && (state.name !== name || state.account !== account)) throw new Error('destroy checkpoint names another deployment or account; refusing to use it');

  if (state?.workerDeleted === true && worker) throw new Error(`${name} was deployed again after its purge started; refusing to delete the new Worker`);
  const connection = worker ? io.connection() : null;

  if (worker && connection === null) throw new Error(`cannot check ${name}'s jobs without its named local connection file; refusing to destroy it`);

  if (connection !== null) {
    v.parse(ConnectionSchema, connection);
    const url = new URL(connection.url);

    if (connection.account !== account || url.protocol !== 'https:' || url.hostname.split('.')[0] !== name || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/') throw new Error(`connection file does not name ${name} in account ${account}`);
  }

  const deployment = connection === null ? null : new Deployment(connection, io);
  let drained = false;

  try {
    if (deployment !== null) {
      refuseJobs(io, await deployment.open(), force);
      // Freeze admission during discovery. The jobs checked a second time include one admitted during the first read.
      const held = await deployment.call('/drain', 'POST');

      drained = held.status !== 404;
      const open = await deployment.open();

      refuseJobs(io, open, force);

      if (drained && v.parse(v.object({ jobs: v.number() }), await held.json()).jobs > open.length) throw new Error('the Worker reports more open jobs than GET /jobs enumerated; re-run for a complete check before destroying it');
    }

    if (state === null) {
      if (!worker && namespaces.some((namespace) => namespace.script === name)) throw new Error(`${name} has namespaces but no Worker to delete them with; refusing to orphan their data`);
      const owned = namespaces.filter((namespace) => namespace.script === name);
      const ownedIds = new Set(owned.map((namespace) => namespace.id));
      const apps = applications.filter((application) => ownedIds.has(application.durable_objects?.namespace_id ?? '') || [ `${name}-armadavessel`, `${name}-armadapreparer` ].includes(application.name));

      state = { name, account, workerDeleted: !worker, namespaces: owned, applications: apps, snapshots: deployment === null ? [] : [...new Set(await deployment.inventory())], images: ownImages(account, name, apps) };
      validateInventory(state);
      io.save(state);
    } else if (worker && deployment !== null) {
      // A failed delete may have left admission restored for hours. Discover what those later jobs created too,
      // but do not accept newly provisioned namespace IDs as the deployment captured by an earlier purge.
      const current = namespaces.filter((namespace) => namespace.script === name);
      const previous = new Set(state.namespaces.map((namespace) => namespace.id));

      if (current.some((namespace) => !previous.has(namespace.id))) throw new Error(`${name}'s namespaces changed since its purge started; refusing to delete a replacement deployment`);
      state.snapshots = [...new Set([...state.snapshots, ...await deployment.inventory()])];
      io.save(state);
    }

    validateInventory(state);

    if (worker) {
      // --force suppresses wrangler's prompt but must NOT extend our --force (open jobs) to other Workers' bindings.
      const references = v.parse(v.object({
        services: v.optional(v.object({ incoming: v.optional(v.array(v.object({})), []), pages_function: v.optional(v.boolean(), false) })),
        durable_objects: v.optional(v.array(v.object({ service: v.string() })), []),
        dispatch_outbounds: v.optional(v.array(v.object({})), []),
      }), await cloud.read(`/workers/scripts/${name}/references`));

      const tails = v.parse(v.array(v.object({})), await cloud.read(`/workers/tails/by-consumer/${name}`));

      if ((references.services?.incoming.length ?? 0) > 0 || references.services?.pages_function === true || references.durable_objects.some((ref) => ref.service !== name) || references.dispatch_outbounds.length > 0 || tails.length > 0) throw new Error(`${name} is referenced by another Worker or Pages project; --force only overrides open jobs`);
      ran(io, account, ['delete', `--name=${name}`, '--force']);
      state.workerDeleted = true;
      io.save(state);
      io.say(`removed Worker ${name} (including its assets and secrets/registry credentials)`);
    } else if (!state.workerDeleted) {
      // The previous delete can succeed remotely even when its process died before writing the acknowledgment.
      state.workerDeleted = true;
      io.save(state);
    }

    // A service deletion removes all its DO namespaces. There is no standalone namespace deletion API.
    const remaining = v.parse(v.array(Namespace), await cloud.list('/workers/durable_objects/namespaces')).filter((namespace) => namespace.script === name);

    if (remaining.length !== 0) throw new Error(`Worker deletion left namespaces: ${remaining.map((namespace) => namespace.id).join(', ')}; re-run to verify Cloudflare finished deleting them`);

    for (const namespace of state.namespaces) io.say(`removed Durable Object namespace ${namespace.id} (${namespace.class}) with Worker ${name}`);
    const currentApps = v.parse(v.array(Application), await cloud.read('/containers/applications'));

    for (const application of state.applications) {
      const current = currentApps.find((each) => each.id === application.id);

      if (current === undefined) continue;

      if (current.name !== application.name || current.durable_objects?.namespace_id !== application.durable_objects?.namespace_id) throw new Error(`application ${application.id} changed ownership; refusing to delete it`);

      if (await cloud.removeApplication(application.id)) io.say(`removed container application ${application.name} (${application.id})`);
    }

    if (state.snapshots.length > 0 || state.images.length > 0) {
      const credentials = await io.credentials(account, token);

      const pending = [...state.snapshots];

      for (const ref of pending) {
        const journal = new ManifestJournal(state, io);
        const deleted = await io.snapshot(credentials, ref, journal.remember);

        if (deleted.kind !== 'left') state.snapshots = state.snapshots.filter((each) => each !== ref && each !== journal.digest);

        if (deleted.kind === 'left' && !state.snapshots.includes(deleted.digest)) state.snapshots.push(deleted.digest);
        io.save(state);

        if (deleted.kind === 'left') throw new Error(`snapshot ${ref} left manifest ${deleted.digest}: ${deleted.reason}; re-run to finish deleting it`);
        io.say(`${deleted.kind === 'absent' ? 'already absent' : 'removed'} snapshot ${ref} (tags and manifest)`);
      }

      for (const image of state.images) {
        const journal = new ManifestJournal(state, io);
        const deleted = await io.image(credentials, image.repository, image.tag, journal.remember);

        if (deleted.kind !== 'left') {
          state.images = state.images.filter((each) => each.repository !== image.repository || each.tag !== image.tag);
          state.snapshots = state.snapshots.filter((each) => each !== journal.digest);
        }

        if (deleted.kind === 'left' && !state.snapshots.includes(deleted.digest)) state.snapshots.push(deleted.digest);
        io.save(state);

        if (deleted.kind === 'left') throw new Error(`image ${image.repository}:${image.tag} left ${deleted.digest}: ${deleted.reason}; re-run to finish deleting it`);
        io.say(`${deleted.kind === 'absent' ? 'already absent' : 'removed'} registry image ${image.repository}:${image.tag}`);
      }
    }

    const bucketGone = await expireBucket(cloud, state, io);

    io.say('issued account-wide registry credentials cannot be revoked individually; they expire (deploy minted them for up to 365 days); shared registry configuration is untouched');
    io.removeConnection();

    if (bucketGone) io.removeState();

    return bucketGone ? 0 : 1;
  } finally {
    if (drained && state?.workerDeleted !== true && deployment !== null) await deployment.call('/drain', 'DELETE');
  }
}
