/**
 * armada's Worker. A job maps a command or a function over items on a pool of containers started from an environment
 * snapshot. The SDK (`src/sdk.ts`) is its client, and every route takes the bearer the deploy wrote.
 */
import * as v from 'valibot';
import { DRIVER, environmentKey, JobSpecSchema, PackBase, Packer, Project, PROTOCOL, PROTOCOL_HEADER, RecipeSchema, refusal, Sha, TaskSchema, TimingsSchema, type Health } from '../../src/protocol';
import { bundleKey, packKey, SINGLE, taskKey, type Env } from './env';

export { ArmadaJob } from './job';

export { ArmadaVessel } from './vessel';

export { ArmadaEnvironments, ArmadaPreparer } from './environments';

export { ArmadaTimings } from './timings';

export { ArmadaFleet } from './fleet';

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

/** `/bundles/<digest>`: a function's bundle, stored once under the digest of its bytes. */
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

/** `POST /jobs` starts one; `/jobs/<id>` is its status, `/events?after=n` its outcomes, `/cancel` ends it, an open
 *  job takes `POST /items` and `POST /close`, `GET /items` lists its items, and `/tasks/<index>/{output,log}` are a
 *  task's stored output and log. */
const jobs: Handler = async (request, env, [id, tail, index, leaf], url) => {
  if (id === undefined) {
    if (request.method !== 'POST') return undefined;
    const spec = v.parse(JobSpecSchema, await request.json());
    const refused = refusal(spec.run, spec.items);

    if (refused !== null) return Response.json({ error: refused }, { status: 400 });

    if (!spec.open && spec.items.length === 0) return Response.json({ error: 'a job that is not open needs an item' }, { status: 400 });

    if (spec.run.kind === 'fn' && (await env.ARTIFACTS.head(bundleKey(spec.run.bundle))) === null) return Response.json({ error: `upload the bundle ${spec.run.bundle} first` }, { status: 409 });

    if (spec.commit !== undefined) {
      if (spec.recipe.repo === undefined) return Response.json({ error: 'a commit needs a repository recipe' }, { status: 400 });

      if ((await env.ARTIFACTS.head(packKey(spec.recipe.repo.project, spec.commit.sha, spec.commit.base, spec.commit.packer))) === null) return Response.json({ error: `upload the pack of ${spec.commit.sha} first` }, { status: 409 });
    }

    const created = jobId();

    await env.JOB.getByName(created).create(created, spec);

    return Response.json({ id: created });
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

  return tail === 'tasks' && index !== undefined && /^\d+$/u.test(index) && (leaf === 'output' || leaf === 'log') ? await object(env, taskKey(id, Number(index), leaf)) : undefined;
};

/** `/verdicts/<project>/<sha>`: a graded CI run's collected verdict file. */
const verdicts: Handler = async (request, env, [project, sha]) => {
  if (!v.is(Project, project) || !v.is(Sha, sha)) return undefined;
  const key = `verdicts/${project}/${sha}.json`;

  if (request.method === 'GET') return await object(env, key);

  if (request.method !== 'PUT') return undefined;
  const file = v.parse(v.looseObject({ sha: v.literal(sha), part: v.literal('all'), rows: v.array(v.looseObject({ exitCode: v.number() })) }), await request.json());

  await env.ARTIFACTS.put(key, JSON.stringify(file), { httpMetadata: { contentType: 'application/json' } });

  return Response.json({ stored: key });
};

/** `/timings/<project>`: GET the medians a plan weighs rows by; POST a graded run's green rows and files. */
const timings: Handler = async (request, env, [project]) => {
  if (!v.is(Project, project)) return undefined;
  const store = env.TIMINGS.getByName(project);

  if (request.method === 'GET') return Response.json(await store.estimates());

  if (request.method !== 'POST') return undefined;
  await store.record(v.parse(TimingsSchema, await request.json()));

  return Response.json({ recorded: true });
};

/** `/environments` lists them, `POST /environments/resolve` names a recipe's key and pack base, and
 *  `DELETE /environments/<key>` forgets one whose snapshot was pruned. */
const environments: Handler = async (request, env, [key]) => {
  const registry = env.ENVIRONMENTS.getByName(SINGLE);

  if (key === undefined) return Response.json(await registry.list());

  if (key === 'resolve' && request.method === 'POST') {
    const resolved = await environmentKey(v.parse(v.object({ recipe: RecipeSchema }), await request.json()).recipe);

    return Response.json({ key: resolved, base: await registry.base(resolved) });
  }

  if (request.method !== 'DELETE') return undefined;
  await registry.forget(key);

  return Response.json({ forgotten: key });
};

const ROUTES: ReadonlyMap<string, Handler> = new Map([['packs', packs], ['bundles', bundles], ['jobs', jobs], ['verdicts', verdicts], ['timings', timings], ['environments', environments]]);

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [head = '', ...path] = url.pathname.split('/').filter((segment) => segment !== '');

  const fleet = env.FLEET.getByName(SINGLE);

  if (head === 'health') return Response.json({ ok: true, driver: DRIVER, protocol: PROTOCOL, vcpus: await fleet.used(), jobs: await fleet.jobs() } satisfies Health);

  // `armada deploy` drains the deployed version first: it admits no new job, and the open ones finish.
  if (head === 'drain' && request.method === 'POST') return Response.json({ jobs: await fleet.drain(env.VERSION.id) });

  if (head === 'drain' && request.method === 'DELETE') {
    await fleet.admit();

    return Response.json({ admitting: true });
  }

  if (head === 'jobs' && path.length === 0 && request.method === 'POST' && !(await fleet.admits(env.VERSION.id))) {
    return Response.json({ error: 'armada is being redeployed and takes no new job until that is done; run again in a few minutes' }, { status: 503 });
  }

  return await ROUTES.get(head)?.(request, env, path, url) ?? notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return Response.json({ error: 'forbidden' }, { status: 403 });
    // A request with no version is from a client older than the version was.
    const spoken = Number(request.headers.get(PROTOCOL_HEADER) ?? '1');

    if (spoken !== PROTOCOL) {
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
