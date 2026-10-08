/**
 * armada's Worker. A job maps a command or a function over items on a pool of containers started from an environment
 * snapshot. The SDK (`src/sdk.ts`) is its client, and every route takes the bearer the deploy wrote, but `/relay`,
 * which a gang's containers reach each other through with the gang's own token (`relay.ts`).
 */
import * as v from 'valibot';
import {
  briefOf, DRIVER, environmentKey, type Health, jsonOf, JobSpecSchema, OLDEST_CLIENT, PackBase, Packer, Project, PROTOCOL, PROTOCOL_HEADER, PushSchema, RecipeSchema, refusal, SECRET_BYTES, SecretName, Sha,
  TaskSchema, TimingsSchema,
} from '../../src/protocol';
import { bundleKey, packKey, SINGLE, taskKey, type Env } from './env';
import { driverSpec, eventOf, HookConfigSchema } from './hooks';

export { ArmadaJob } from './job';

export { ArmadaVessel } from './vessel';

export { ArmadaEnvironments, ArmadaPreparer } from './environments';

export { ArmadaTimings } from './timings';

export { ArmadaFleet } from './fleet';

export { ArmadaTasks } from './tasks';

export { ArmadaSecrets } from './secrets';

export { ArmadaWebhooks } from './hooks';

/** The bearer, compared in constant time. */
function authorized(request: Request, env: Env): boolean {
  const expected = new TextEncoder().encode(`Bearer ${env.ARMADA_TOKEN}`);
  const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '');

  return env.ARMADA_TOKEN.length >= 32 && expected.length === supplied.length && crypto.subtle.timingSafeEqual(expected, supplied);
}

function jobId(): string {
  return `${new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

const notFound = (): Response => Response.json({ error: 'not found' }, { status: 404 });

/** An R2 object as the response body, or 404. */
async function object(env: Env, key: string): Promise<Response> {
  const found = await env.ARTIFACTS.get(key);

  if (found === null) return notFound();
  const headers = new Headers();

  found.writeHttpMetadata(headers);

  // A log is stored gzipped with its encoding named: served as stored, never compressed a second time.
  return new Response(found.body, { headers, encodeBody: 'manual' });
}

type Handler = (request: Request, env: Env, path: readonly string[], url: URL) => Promise<Response | undefined>;

const Parts = v.object({ parts: v.array(v.object({ partNumber: v.pipe(v.number(), v.integer(), v.minValue(1)), etag: v.string() })) });

/** `/packs/<project>/<sha>/<base>`: a commit's pack, stored once (`packKey`). A pack larger than a request may carry
 *  arrives in parts: `POST ?uploads` opens it, `PUT ?upload=<id>&part=<n>` stores each, `POST ?upload=<id>` with the
 *  parts' etags completes it. */
const packs: Handler = async (request, env, [project, sha, base], url) => {
  if (!v.is(Project, project) || !v.is(Sha, sha) || !v.is(PackBase, base)) return undefined;
  const packer = url.searchParams.get('packer');
  const key = packKey(project, sha, base, v.parse(Packer, packer === null ? undefined : Number(packer)));
  const upload = url.searchParams.get('upload');

  if (request.method === 'HEAD') return new Response(null, { status: (await env.ARTIFACTS.head(key)) === null ? 404 : 200 });

  if (request.method === 'POST' && url.searchParams.has('uploads')) return Response.json({ upload: (await env.ARTIFACTS.createMultipartUpload(key)).uploadId });

  if (upload !== null && request.method === 'PUT' && request.body !== null) {
    return Response.json(await env.ARTIFACTS.resumeMultipartUpload(key, upload).uploadPart(Number(url.searchParams.get('part')), request.body));
  }

  if (upload !== null && request.method === 'POST') {
    await env.ARTIFACTS.resumeMultipartUpload(key, upload).complete(v.parse(Parts, await request.json()).parts);

    return Response.json({ stored: key });
  }

  if (request.method !== 'PUT' || request.body === null) return undefined;
  await env.ARTIFACTS.put(key, request.body);

  return Response.json({ stored: key });
};

/** `POST /tasks` records a push: each id now runs from its bundle, and the project's ids it no longer exports go. */
const tasks: Handler = async (request, env) => {
  if (request.method !== 'POST') return undefined;
  const push = v.parse(PushSchema, await request.json());

  if ((await env.ARTIFACTS.head(bundleKey(push.bundle))) === null) return Response.json({ error: `upload the bundle ${push.bundle} first` }, { status: 409 });
  const refused = await env.TASKS.getByName(SINGLE).publish(push);

  if (refused !== null) return Response.json({ error: refused }, { status: 409 });
  await sweepBundles(env);

  return Response.json({ pushed: push.ids.length });
};

/** How long a bundle no task id points to is kept: past any job that could still be starting containers from it. */
const BUNDLE_GRACE_MS = 7 * 24 * 3600 * 1000;

/** Deletes the bundles no task id points to that are older than BUNDLE_GRACE_MS. */
async function sweepBundles(env: Env): Promise<void> {
  const current = new Set(await env.TASKS.getByName(SINGLE).current());

  for (let cursor: string | undefined; ;) {
    const page = await env.ARTIFACTS.list({ prefix: 'code/', cursor });

    for (const bundle of page.objects) {
      const digest = bundle.key.slice('code/'.length, -'.mjs'.length);

      if (!current.has(digest) && Date.now() - bundle.uploaded.getTime() > BUNDLE_GRACE_MS) await env.ARTIFACTS.delete(bundle.key);
    }

    if (!page.truncated) return;
    cursor = page.cursor;
  }
}

/** `/bundles/<digest>`: a pushed project's bundle, stored once under the digest of its bytes. */
const bundles: Handler = async (request, env, [digest]) => {
  if (digest === undefined || !/^[0-9a-f]{64}$/u.test(digest)) return undefined;

  if (request.method === 'HEAD') return new Response(null, { status: (await env.ARTIFACTS.head(bundleKey(digest))) === null ? 404 : 200 });

  if (request.method !== 'PUT') return undefined;
  const bytes = await request.arrayBuffer();
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  if (actual !== digest) return Response.json({ error: `the bundle's digest is ${actual}, not ${digest}` }, { status: 400 });
  await env.ARTIFACTS.put(bundleKey(digest), bytes);

  return Response.json({ stored: digest });
};

const Items = v.object({ items: v.pipe(v.array(TaskSchema), v.minLength(1)) });

/** `POST /jobs`: the job `created`, which the fleet has already admitted and counts open, made from the request's spec,
 *  or why it is refused. */
async function createJob(request: Request, env: Env, created: string): Promise<Response> {
  const spec = v.parse(JobSpecSchema, await request.json());
  const refused = refusal(spec.run, spec.items, spec.pool, spec.slots);

  if (refused !== null) return Response.json({ error: refused }, { status: 400 });

  if (!spec.open && spec.items.length === 0) return Response.json({ error: 'a job that is not open needs an item' }, { status: 400 });

  if (spec.run.kind === 'task') {
    // The bundle the client just pushed, else the one the task's id was last pushed with, and its runtime.
    const entry = await env.TASKS.getByName(SINGLE).entryOf(spec.run.id);
    const bundle = spec.run.bundle ?? entry?.bundle;
    const runtime = spec.run.bundle === undefined ? entry?.runtime ?? 'node' : spec.run.runtime;

    if (bundle === undefined) return Response.json({ error: `no task ${spec.run.id} is pushed; run armada push in its project` }, { status: 409 });

    if ((await env.ARTIFACTS.head(bundleKey(bundle))) === null) return Response.json({ error: `upload the bundle ${bundle} first` }, { status: 409 });
    spec.run = { ...spec.run, bundle, runtime };
  }

  if (spec.cache !== undefined && spec.run.kind !== 'task') return Response.json({ error: 'a cache is for a pushed task: its bundle is part of the key' }, { status: 400 });
  const held = spec.secrets.length === 0 ? {} : await env.SECRETS.getByName(SINGLE).values(spec.secrets);
  const unset = spec.secrets.find((name) => !(name in held));

  if (unset !== undefined) return Response.json({ error: `no secret ${unset} is set; run armada secret set ${unset}` }, { status: 409 });

  if (spec.commit !== undefined) {
    if (spec.recipe.repo === undefined) return Response.json({ error: 'a commit needs a repository recipe' }, { status: 400 });

    if ((await env.ARTIFACTS.head(packKey(spec.recipe.repo.project, spec.commit.sha, spec.commit.base, spec.commit.packer))) === null) return Response.json({ error: `upload the pack of ${spec.commit.sha} first` }, { status: 409 });
  }

  await env.JOB.getByName(created).create(created, spec, new URL(request.url).origin);

  return Response.json({ id: created });
}

/** The most jobs `GET /jobs` lists at once. */
const LISTED = 100;

/** `POST /jobs` starts one (`route`) and `GET /jobs` lists the recent ones; `/jobs/<id>` is its status,
 *  `/events?after=n` its outcomes, `/cancel` ends it, an open job takes `POST /items` and `POST /close`, `GET /items`
 *  lists its items, and `/tasks/<index>/{output,log}` are a task's stored output and log. */
const jobs: Handler = async (request, env, [id, tail, index, leaf], url) => {
  if (id === undefined) {
    if (request.method !== 'GET') return undefined;
    // `?before=<id>` pages back from a job the last page ended with.
    const limit = Math.min(LISTED, Math.max(1, Number(url.searchParams.get('limit') ?? '30') || 30));
    const before = url.searchParams.get('before') ?? undefined;
    const ids = await env.FLEET.getByName(SINGLE).recent(limit, before);
    const statuses = await Promise.all(ids.map(async (each) => await env.JOB.getByName(each).status()));

    return Response.json({ jobs: statuses.flatMap((status) => status === null ? [] : [briefOf(status)]) });
  }

  const job = env.JOB.getByName(id);

  if (tail === undefined) return Response.json(await job.status() ?? { error: 'no such job' });

  if (tail === 'events') return Response.json(await job.events(Number(url.searchParams.get('after') ?? '0')));

  if (tail === 'cancel' && request.method === 'POST') {
    await job.cancel('cancelled by its client', 'cancelled');

    return Response.json({ cancelled: id });
  }

  if (tail === 'items' && request.method === 'GET') return new Response(await job.items(), { headers: { 'content-type': 'application/json' } });

  if (tail === 'items' && request.method === 'POST') {
    const { items } = v.parse(Items, await request.json());
    const refused = await job.add(items);

    return refused === null ? Response.json({ added: items.length }) : Response.json({ error: refused }, { status: 400 });
  }

  if (tail === 'close' && request.method === 'POST') {
    await job.close();

    return Response.json({ closed: id });
  }

  if (tail !== 'tasks' || index === undefined || !/^\d+$/u.test(index) || (leaf !== 'output' && leaf !== 'log' && leaf !== 'artifacts')) return undefined;
  // A task answered from the cache ran nothing: its output is the cached object itself.
  const cached = leaf === 'output' ? await job.cachedFrom(Number(index)) : undefined;

  return await object(env, cached ?? taskKey(id, Number(index), leaf));
};

/** `/secrets` lists the names set; `PUT /secrets/<name>` sets one from the body, `DELETE` removes it. No route answers
 *  a value. */
const secrets: Handler = async (request, env, [name]) => {
  const held = env.SECRETS.getByName(SINGLE);

  if (name === undefined) return request.method === 'GET' ? Response.json({ names: await held.names() }) : undefined;

  if (!v.is(SecretName, name)) return Response.json({ error: v.safeParse(SecretName, name).issues?.[0].message }, { status: 400 });

  if (request.method === 'DELETE') return Response.json({ deleted: await held.delete(name) });

  if (request.method !== 'PUT') return undefined;
  const value = await request.text();

  if (value === '' || new TextEncoder().encode(value).byteLength > SECRET_BYTES) return Response.json({ error: `a secret holds 1 to ${String(SECRET_BYTES)} bytes` }, { status: 400 });
  await held.set(name, value);

  return Response.json({ stored: name });
};

const VerdictFile = v.looseObject({ sha: Sha, part: v.literal('all'), rows: v.array(v.looseObject({ exitCode: v.number() })) });

/** The most verdicts `GET /verdicts/<project>` lists, newest first. */
const VERDICTS_LISTED = 50;

/** `/verdicts` names the projects with a verdict; `/verdicts/<project>` lists its newest, and `/verdicts/<project>/<sha>`
 *  is a graded CI run's collected verdict file. A verdict is stored with its row counts, so a list reads no file but
 *  one stored before it had them. */
const verdicts: Handler = async (request, env, [project, sha]) => {
  if (project === undefined) {
    if (request.method !== 'GET') return undefined;
    const projects: string[] = [];

    for (let cursor: string | undefined; ;) {
      const page = await env.ARTIFACTS.list({ prefix: 'verdicts/', delimiter: '/', cursor });

      projects.push(...page.delimitedPrefixes.map((prefix) => prefix.slice('verdicts/'.length, -1)));

      if (!page.truncated) return Response.json({ projects: projects.filter((name) => v.is(Project, name)) });
      cursor = page.cursor;
    }
  }

  if (!v.is(Project, project)) return undefined;

  if (sha === undefined) return request.method === 'GET' ? Response.json({ verdicts: await verdictsOf(env, project) }) : undefined;

  if (!v.is(Sha, sha)) return undefined;
  const key = `verdicts/${project}/${sha}.json`;

  if (request.method === 'GET') return await object(env, key);

  if (request.method !== 'PUT') return undefined;
  const file = v.parse(VerdictFile, await request.json());

  if (file.sha !== sha) return Response.json({ error: `the verdict is of ${file.sha}, not ${sha}` }, { status: 400 });
  await env.ARTIFACTS.put(key, JSON.stringify(file), {
    httpMetadata: { contentType: 'application/json' }, customMetadata: { rows: String(file.rows.length), reds: String(file.rows.filter((row) => row.exitCode !== 0).length) },
  });

  return Response.json({ stored: key });
};

/** A project's newest verdicts with their counts. */
async function verdictsOf(env: Env, project: string): Promise<{ sha: string; uploaded: number; rows: number; reds: number }[]> {
  const listed: R2Object[] = [];

  for (let cursor: string | undefined; ;) {
    const page = await env.ARTIFACTS.list({ prefix: `verdicts/${project}/`, cursor, include: ['customMetadata'] });

    listed.push(...page.objects);

    if (!page.truncated) break;
    cursor = page.cursor;
  }

  const newest = listed.sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime()).slice(0, VERDICTS_LISTED);

  return await Promise.all(newest.map(async (stored) => {
    const sha = stored.key.slice(`verdicts/${project}/`.length, -'.json'.length);
    const { rows, reds } = stored.customMetadata ?? {};

    if (rows !== undefined && reds !== undefined) return { sha, uploaded: stored.uploaded.getTime(), rows: Number(rows), reds: Number(reds) };
    const file = v.parse(VerdictFile, await (await env.ARTIFACTS.get(stored.key))?.json());

    return { sha, uploaded: stored.uploaded.getTime(), rows: file.rows.length, reds: file.rows.filter((row) => row.exitCode !== 0).length };
  }));
}

/** `/timings/<project>`: GET the medians a plan weighs rows by; POST a graded run's green rows and files. */
const timings: Handler = async (request, env, [project]) => {
  if (!v.is(Project, project)) return undefined;
  const store = env.TIMINGS.getByName(project);

  if (request.method === 'GET') return Response.json(await store.estimates());

  if (request.method !== 'POST') return undefined;
  await store.record(v.parse(TimingsSchema, await request.json()));

  return Response.json({ recorded: true });
};

/** `/environments` lists them, `POST /environments/resolve` names a recipe's key and pack base, `POST
 *  /environments/prune` deletes the snapshots past those it keeps with the registry credentials it is given (`armada
 *  prune`), and `DELETE /environments/<key>` forgets one. */
const environments: Handler = async (request, env, [key]) => {
  const registry = env.ENVIRONMENTS.getByName(SINGLE);

  if (key === undefined) return Response.json(await registry.list());

  if (key === 'resolve' && request.method === 'POST') {
    const resolved = await environmentKey(v.parse(v.object({ recipe: RecipeSchema }), await request.json()).recipe);

    return Response.json({ key: resolved, base: await registry.base(resolved) });
  }

  if (key === 'prune' && request.method === 'POST') {
    const { keep, credentials } = v.parse(v.object({ keep: v.pipe(v.number(), v.integer(), v.minValue(0)), credentials: v.pipe(v.string(), v.includes(':')) }), await request.json());

    return Response.json({ pruned: await registry.prune(keep, credentials) });
  }

  if (request.method !== 'DELETE') return undefined;
  await registry.forget(key);

  return Response.json({ forgotten: key });
};

/** `/webhooks` (bearer'd): a project's webhook config, set with its GitHub-signing secret once, listed without
 *  them, or removed. `POST /webhooks/github/<project>` is the unauthenticated endpoint, in `webhooked`. */
const webhooks: Handler = async (request, env, [project]) => {
  const hooks = env.WEBHOOKS.getByName(SINGLE);

  if (project === undefined) return request.method === 'GET' ? Response.json({ webhooks: await hooks.list() }) : undefined;

  if (!v.is(Project, project)) return undefined;

  if (request.method === 'POST') {
    await hooks.configure(project, v.parse(HookConfigSchema, await request.json()));

    return Response.json({ configured: project });
  }

  if (request.method !== 'DELETE') return undefined;

  return Response.json({ removed: project, ...await hooks.remove(project) });
};

/** `/fleet`: the vCPUs each job holds now, under the deployment's cap. */
const fleet: Handler = async (request, env) => request.method === 'GET' ? Response.json(await env.FLEET.getByName(SINGLE).shares()) : undefined;

const ROUTES: ReadonlyMap<string, Handler> = new Map([
  ['packs', packs], ['bundles', bundles], ['tasks', tasks], ['jobs', jobs], ['verdicts', verdicts], ['timings', timings], ['environments', environments], ['secrets', secrets], ['fleet', fleet], ['webhooks', webhooks],
]);

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [head = '', ...path] = url.pathname.split('/').filter((segment) => segment !== '');

  const fleet = env.FLEET.getByName(SINGLE);

  if (head === 'health') {
    const keepUntil = env.REGISTRY_CREDENTIALS_EXPIRE;

    return Response.json({
      ok: true, driver: DRIVER, protocol: PROTOCOL, oldest: OLDEST_CLIENT, vcpus: await fleet.used(), jobs: await fleet.jobs(),
      ...(env.ARMADA_SHA === undefined || env.ARMADA_SHA === '' ? {} : { sha: env.ARMADA_SHA }), ...keepUntil === undefined ? {} : { keepUntil },
    } satisfies Health);
  }

  // `armada deploy` drains the deployed version first: it admits no new job, and the open ones finish.
  if (head === 'drain' && request.method === 'POST') return Response.json({ jobs: await fleet.drain(env.VERSION.id) });

  if (head === 'drain' && request.method === 'DELETE') {
    await fleet.admit();

    return Response.json({ admitting: true });
  }

  if (head === 'jobs' && path.length === 0 && request.method === 'POST') {
    const created = jobId();

    // Admitted and counted open in one step of the fleet's, so a drain that counts no open job has admitted none that
    // is still being made; a job refused or failed on the way gives its place back.
    if (!(await fleet.reserve(env.VERSION.id, created))) {
      return Response.json({ error: 'armada is being redeployed and takes no new job until that is done; run again in a few minutes' }, { status: 503 });
    }

    const answer = await createJob(request, env, created).catch(async (cause: unknown) => {
      await fleet.closed(created);
      throw cause;
    });

    if (!answer.ok) await fleet.closed(created);

    return answer;
  }

  return await ROUTES.get(head)?.(request, env, path, url) ?? notFound();
}

/** Whether `signature` is GitHub's `X-Hub-Signature-256` for `body` under `secret`, timed-safe. */
export async function signed(secret: string, signature: string, body: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const expected = new TextEncoder().encode(`sha256=${mac}`);
  const supplied = new TextEncoder().encode(signature);

  return expected.length === supplied.length && crypto.subtle.timingSafeEqual(expected, supplied);
}

/** `POST /webhooks/github/<project>`: outside the bearer, checked only by GitHub's signature. A valid push to a
 *  built branch or a same-repo pull request starts that commit's driver job — `armada run <sha> --json` on the
 *  deployment itself — once per delivery and once per commit. */
export async function webhooked(request: Request, env: Env, project: string): Promise<Response> {
  const ignored = (note: string) => Response.json({ note });
  const hooks = env.WEBHOOKS.getByName(SINGLE);
  const config = await hooks.configOf(project);

  if (config === undefined) return notFound();

  const body = await request.text();
  const signature = request.headers.get('X-Hub-Signature-256') ?? '';

  if (!(await signed(config.secret, signature, body))) return Response.json({ error: 'bad signature' }, { status: 401 });

  const delivery = request.headers.get('X-GitHub-Delivery') ?? '';

  if (delivery !== '' && await hooks.seen(delivery)) return ignored('duplicate');

  const asked = eventOf(request.headers.get('X-GitHub-Event') ?? '', jsonOf(body), config);

  if (asked.kind === 'ping') return ignored('pong');

  if (asked.kind === 'fork') return ignored('fork pull requests are not built');

  if (asked.kind !== 'push' && asked.kind !== 'pr') return ignored('ignored');

  const sha = asked.sha;

  if ((await env.ARTIFACTS.head(`verdicts/${project}/${sha}.json`)) !== null) return ignored('already');
  const open = await hooks.driving(project, sha);

  if (open !== undefined) {
    const prior = await env.JOB.getByName(open).status();

    if (prior !== null && prior.phase !== 'done') return ignored('already');
  }

  const created = jobId();
  const fleet = env.FLEET.getByName(SINGLE);

  if (!(await fleet.reserve(env.VERSION.id, created))) return Response.json({ error: 'armada is being redeployed and takes no new job until that is done' }, { status: 503 });

  // The driver installs armada at the commit this Worker was deployed from, which `armada deploy` records.
  if (env.ARMADA_SHA === undefined || env.ARMADA_SHA === '') return Response.json({ error: 'this Worker does not know its commit; deploy it with armada deploy' }, { status: 503 });
  const spec = v.parse(JobSpecSchema, driverSpec(project, sha, new URL(request.url).origin, env.ARMADA_SHA, config));
  const held = spec.secrets.length === 0 ? {} : await env.SECRETS.getByName(SINGLE).values(spec.secrets);
  const unset = spec.secrets.find((name) => !(name in held));

  if (unset !== undefined) {
    await fleet.closed(created);

    return Response.json({ error: `no secret ${unset} is set; run armada secret set ${unset}` }, { status: 409 });
  }

  await env.JOB.getByName(created).create(created, spec, new URL(request.url).origin).catch(async (cause: unknown) => {
    await fleet.closed(created);
    throw cause;
  });
  await hooks.drove(project, sha, created);

  return Response.json({ started: created });
}

/** `/relay/<job>/<vessel>?port=n`: a gang rank's relay, reaching the rank `vessel` runs. No container holds the
 *  deployment's bearer, so the relay presents its gang's token instead, which the vessel checks. */
async function relayed(request: Request, env: Env, [job, vessel]: readonly string[]): Promise<Response> {
  if (job === undefined || vessel === undefined || !/^\d{14}-[0-9a-f]{8}$/u.test(job) || !/^[vr]\d{1,4}$/u.test(vessel)) return notFound();

  return await env.VESSEL.getByName(`${job}/${vessel}`).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [first, ...rest] = new URL(request.url).pathname.split('/').filter((segment) => segment !== '');

    if (first === 'relay') return await relayed(request, env, rest);

    // The webhook endpoint is outside the bearer: the project's own GitHub-signing secret is the only check.
    const [service, hooked, ...extra] = rest;

    if (first === 'webhooks' && service === 'github' && hooked !== undefined && extra.length === 0 && request.method === 'POST') return await webhooked(request, env, hooked);

    // The dashboard is static assets under /ui/, served before the Worker runs; a browser at the root is sent there.
    if (first === undefined && (request.method === 'GET' || request.method === 'HEAD')) return Response.redirect(new URL('/ui/', request.url).href, 302);

    if (!authorized(request, env)) return Response.json({ error: 'forbidden' }, { status: 403 });
    // A request with no version is from a client older than the version was. The drain and the health are the same in
    // every version, so a deploy drains the version it replaces whatever version it speaks.
    const spoken = Number(request.headers.get(PROTOCOL_HEADER) ?? '1');
    const head = new URL(request.url).pathname.split('/')[1];

    if ((spoken < OLDEST_CLIENT || spoken > PROTOCOL) && head !== 'drain' && head !== 'health') {
      return Response.json({
        error: spoken > PROTOCOL ? 'the deployed Worker is older than this armada client: run `armada deploy` to update it'
          : 'this armada client is older than the deployed Worker. Update it to the deployed version: an install from install.sh with `curl -fsSL https://raw.githubusercontent.com/AshishKumar4/armada/main/install.sh | sh`, a checkout with `git pull`, and a project that pins armada by moving its pin',
      }, { status: 426 });
    }

    try {
      return await route(request, env);
    } catch (cause) {
      if (cause instanceof v.ValiError) return Response.json({ error: cause.message }, { status: 400 });
      throw cause;
    }
  },
} satisfies ExportedHandler<Env>;
