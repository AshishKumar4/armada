/**
 * A deployment of armada and the requests it answers: jobs, their events and outputs, packs and bundles. The typed
 * API (`task.ts`) and the CLI are built on it.
 */
import { openJobs, type ListedJob } from './drain';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { CONFIG_FILE, deploymentNamed } from './config';
import { type Cpu, deadlineRefusal, errorOf, EventsSchema, HealthSchema, hostLabel, JobStatusSchema, jsonOf, JsonSchema, median, PACKER, PROTOCOL, PROTOCOL_HEADER, RecipeSchema, IDEMPOTENCY_HEADER, UNMADE_HEADER, TaskRunsSchema, TaskStatusSchema, type Boot, type Commit, type Health, type JobSpecSchema, type JobStatus, type Json, type JsonBody, type Recipe, type Task, type TaskRun, type TaskStatus } from './protocol';

export const CONFIG_DIR = join(homedir(), '.config', 'armada');

/** How long a read is asked again, from its first failure, of a runner it cannot reach, or whose gateway or Worker
 *  failed to answer it (`Armada.call`): a network that drops for a while (2026-11-16: the PC's tunnel down 35 s, every
 *  read failing on a certificate a captive path served) is ridden out, and a runner gone for good still ends the read.
 *  Within a job's lease (`JOB_LEASE_SECONDS`) less a renewal, so a job is never cancelled by its lease while its
 *  client still waits on the runner. */
export const READ_OUTAGE_MS = 120_000;

/** How long one ask of a read waits for its whole answer before it is a failure, asked again as one (`Armada.call`,
 *  `Armada.whole`): a read with no bound waited on a connection that never answered, for five minutes before it
 *  failed, at the end of a train's CI with every task done (2026-11-17: one task's artifacts, a 462-byte archive the
 *  Worker gives in a third of a second). */
export const READ_ANSWER_MS = 60_000;

/** The longest pause between two asks of a read that failed (`Armada.call`). */
export const READ_PAUSE_MS = 15_000;

/** The longest a request the Worker refused while it is redeployed waits before it is asked again (`Armada.call`). */
export const REDEPLOY_WAIT_MS = 15_000;

/** The largest pack, in bytes, sent in one request; a Worker takes 100 MB, and R2 wants every part but the last alike. */
export const PACK_PART = 64 * 1024 * 1024;

/** The times a pack or bundle is stored while another client stores the same at that moment (`storeOnce`). */
const STORE_ATTEMPTS = 6;

export const ConnectionSchema = v.object({ url: v.string(), token: v.string(), account: v.string() });

export type Connection = v.InferOutput<typeof ConnectionSchema>;

export interface Summary {
  readonly tasks: number;
  readonly green: number;
  readonly red: number;
  readonly failed: number;
  /** From the job's creation, environment preparation included. */
  readonly wallMs: number;
  /** From the environment's readiness to the last outcome: the map itself. */
  readonly mapMs: number;
  readonly vessels: number;
  /** Each vessel's time from the fleet's capacity granted to its first answer, sorted. */
  readonly bootMs: readonly number[];
  /** Each booted vessel's boot by phase, from a Worker that times them (#32). */
  readonly boots: readonly Boot[];
  readonly tasksPerSecond: number;
}

/** Where `armada deploy --name=<name>` writes a deployment's connection: `connection.json` for the default `armada`. */
export function connectionFile(name: string): string {
  return join(CONFIG_DIR, name === 'armada' ? 'connection.json' : `${name}.json`);
}

/** The deployment the nearest `.armada.json` at or above `from` names (`deployment`), or none. */
export function projectDeployment(from: string): string | undefined {
  let dir = resolve(from);

  while (!existsSync(join(dir, CONFIG_FILE))) {
    if (dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }

  return deploymentNamed(readFileSync(join(dir, CONFIG_FILE), 'utf8'));
}

/** Why there is no connection to read at `file`, and what makes one. */
function noConnection(file: string, named: string | undefined, pinned: string | undefined): string {
  if (named !== undefined) return `no connection file at ${file}`;

  if (pinned !== undefined) return `this project's ${CONFIG_FILE} names the deployment ${pinned}, and this machine has no connection for it at ${file}: run \`armada deploy --name=${pinned}\``;

  return 'not deployed from this machine: run `armada deploy`, or set ARMADA_URL and ARMADA_TOKEN';
}

/** The connection file `connect` reads from `from`: the one `ARMADA_CONNECTION` (or `--connection`) names, else the one
 *  for the deployment the project's `.armada.json` names, else the one this machine deployed (`armada deploy`); `named`
 *  and `pinned` say which of the first two it is. */
export function connectionAt(from: string) {
  const named = process.env['ARMADA_CONNECTION'];
  const pinned = named === undefined ? projectDeployment(from) : undefined;

  return { file: named ?? connectionFile(pinned ?? 'armada'), named, pinned };
}

/** The runner `ARMADA_CONNECTION` (or `--connection`) names; else the one `ARMADA_URL` and `ARMADA_TOKEN` give; else the
 *  deployment the project at `from` names in its `.armada.json`; else the one this machine deployed (`armada deploy`). A
 *  named connection comes first: it is the one asked for. */
export function connect(from = process.cwd()): Armada {
  const url = process.env['ARMADA_URL'];
  const token = process.env['ARMADA_TOKEN'];

  if (process.env['ARMADA_CONNECTION'] === undefined && url !== undefined && token !== undefined) return new Armada({ url, token, account: process.env['ARMADA_ACCOUNT'] ?? '' });
  const { file, named, pinned } = connectionAt(from);

  if (!existsSync(file)) throw new Error(noConnection(file, named, pinned));

  return new Armada(v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8'))));
}

/** `recipe` as this client sends it: a repository recipe's environment is one this client's packs prepare (`PACKER`),
 *  whoever wrote the recipe. */
function ownPacker(recipe: v.InferInput<typeof RecipeSchema>): v.InferInput<typeof RecipeSchema> {
  return recipe.repo === undefined ? recipe : { ...recipe, repo: { ...recipe.repo, packer: PACKER } };
}

/** A failed response in one line: the Worker's own error, or the status and the title or first line of any other page,
 *  such as the error page a Worker still rolling out answers with. */
async function failureOf(response: Response): Promise<string> {
  const text = await response.text();
  const said = v.safeParse(v.object({ error: v.string() }), jsonOf(text));

  if (said.success) return `${String(response.status)} ${said.output.error}`;
  const line = (/<title>([^<]*)<\/title>/iu.exec(text)?.[1] ?? text.split('\n').find((each) => each.trim() !== '') ?? '').trim().slice(0, 200);

  return `${String(response.status)} from the Worker (it may still be deploying)${line === '' ? '' : `: ${line}`}`;
}

/** What the Worker says of a 503 of its own (its JSON error, not a gateway's page), which it answers only while it is
 *  redeployed, a drain admitting no job or its objects still on the earlier code, having made nothing of the request;
 *  null for any other answer. */
async function redeploying(response: Response): Promise<string | null> {
  // A refusal for load that made nothing (UNMADE_HEADER) is no deploy's: its client asks again within its read's budget.
  if (response.status !== 503 || response.headers.get(UNMADE_HEADER) === '1') return null;
  const said = v.safeParse(v.object({ error: v.string() }), jsonOf(await response.clone().text()));

  return said.success ? said.output.error : null;
}

/** `ms` waited, or ended at once, rejecting with its reason, once `signal` aborts: a request its caller gave up on asks
 *  nothing more. */
async function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal === null || signal === undefined) {
    await Bun.sleep(ms);

    return;
  }

  signal.throwIfAborted();
  await new Promise<void>((waited, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      waited();
    }, ms);

    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** The answer of `send`, asked again while the Worker refuses it for a redeploy (`redeploying`), a second apart more
 *  each time up to REDEPLOY_WAIT_MS, the refusal said once under `request`'s name; never again once `signal` aborts. */
async function deployed(request: string, send: () => Promise<Response>, signal: AbortSignal | null | undefined): Promise<Response> {
  for (let refusals = 1; ; refusals += 1) {
    signal?.throwIfAborted();
    const sent = await send();
    const refused = await redeploying(sent);

    if (refused === null) return sent;

    if (refusals === 1) console.error(`${request}: ${refused}; asked again until the deploy is done`);
    await pause(Math.min(refusals * 1000, REDEPLOY_WAIT_MS), signal);
  }
}

/** The first version of the wire whose Worker drains. */
const FIRST_DRAIN = 2;

/** A runner a request could not reach: the connection failed (dropped, refused, its TLS refused) through every ask
 *  `Armada.call` made of it. What the runner holds stands; only this client lost it. */
export class Unreachable extends Error {
  constructor(readonly request: string, options: { readonly cause: unknown }) {
    super(`${request}: ${errorOf(options).message}`, options);
    this.name = 'Unreachable';
  }
}

/** A request the Worker answered with an error: its status, and what it said. */
export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

/** `answer`'s body, whole, each wait for its next bytes bounded by `idleMs`: past it, `bounded` aborts with why. */
async function bodyOf(answer: Response, idleMs: number, bounded: AbortController): Promise<Uint8Array> {
  const reader = answer.body?.getReader();

  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];

  for (;;) {
    // Past it, the ask is aborted, which errors its body's stream and so ends a read waiting on it.
    const idle = setTimeout(() => { bounded.abort(new Error(`no bytes in ${String(Math.round(idleMs / 1000))} s`)); }, idleMs);

    try {
      const { done, value } = await reader.read();

      if (bounded.signal.aborted) throw bounded.signal.reason;

      if (done) break;
      chunks.push(value);
    } finally {
      clearTimeout(idle);
    }
  }

  return Bun.concatArrayBuffers(chunks, Infinity, true);
}

export class Armada {
  /** `answerMs`: how long one ask of a read waits for its whole answer (READ_ANSWER_MS). */
  constructor(readonly connection: Connection, readonly answerMs = READ_ANSWER_MS) {}

  /** The wire's version this client speaks to the deployment: its own, or an older one a drain found the deployed
   *  Worker speaks, for the drain, the health and the admit, which are the same in every version. */
  private spoken = PROTOCOL;

  /** A request to the runner. A read (GET, HEAD) that meets a gateway's 502, 503 or 504, the Worker's own 500, or a
   *  connection that fails (dropped, refused, its TLS refused), is asked again for READ_OUTAGE_MS, a second apart more
   *  each time up to READ_PAUSE_MS, the failure said once with its cause: the Worker answers it again unchanged, and a
   *  `run` that polls for hours should not end on a network's blip. A write is asked once, but where the Worker says it
   *  made nothing of it (UNMADE_HEADER: its admission refused for load), which is asked again as a read is, its pause
   *  drawn at random up to the read's, so writes refused together do not come back together (Dew, 2026-11-18: five of
   *  a reach's fifty maps failed their POST /jobs on an overloaded fleet, and their tasks had no outcome). A 500 says
   *  nothing of what a write made, so no write is asked again on one. A Durable Object the runtime
   *  restarted throws once under a read ("Worker threw exception"), and the next read is answered. Any request the
   *  Worker refuses while it is redeployed (`redeploying`), which made nothing of it, is asked again until the deploy is
   *  done, a second apart more each time up to REDEPLOY_WAIT_MS, said once: a job submitted during a deploy's drain
   *  starts after it, never fails on it (Main, 2026-11-06: a drain refused every lane's run). The deploy bounds that
   *  wait: its drain lasts while its open jobs finish, each within its deadline, and lapses if the deploy dies. */
  async call(path: string, init: RequestInit = {}, protocol = PROTOCOL): Promise<Response> {
    return await this.asked(path, init, protocol, false);
  }

  /** `call`'s request, its answer read whole within each ask where `whole` (its bytes held in the Response it gives):
   *  each ask of a read, and its body with it where `whole`, bounded by `answerMs` from its sending, one past it a
   *  failed read asked again within the read's one outage budget; a redeploy's refusals waited outside every ask's
   *  bound (review: a bound around the redeploy wait cut it short, and a body's bound around the read restarted its
   *  outage budget). */
  private async asked(path: string, init: RequestInit, protocol: number, whole: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';
    // A write its key makes idempotent (IDEMPOTENCY_HEADER) is asked again as a read is, its own ask unbounded: its body
    // goes up as fast as the network takes it (row 8848: a pack's part, and POST /jobs, each failed a whole CI run on
    // one dropped connection).
    const repeatable = read || headers.has(IDEMPOTENCY_HEADER);
    // When the outage began: when the ask that first failed was sent, its own wait counted (a redeploy's wait before it,
    // `deployed`, is no outage). Every later ask and pause ends within the budget it leaves (the armada audit,
    // 2026-11-18: a pause could pass the budget's end, and a full ask start after it).
    let began: number | null = null;
    let asking = Date.now();
    const remaining = (): number => began === null ? Infinity : began + READ_OUTAGE_MS - Date.now();

    // Whether a read that failed, or a write the runtime refused unmade, is asked again, the first failure said with its
    // cause.
    const again = (cause: string, unmade = false): boolean => {
      if ((!repeatable && !unmade) || init.signal?.aborted === true) return false;

      if (began === null) {
        began = asking;
        console.error(`${method} ${path}: ${cause}; asked again for up to ${String(READ_OUTAGE_MS / 1000)} s`);
      }

      return remaining() > 0;
    };

    headers.set('authorization', `Bearer ${this.connection.token}`);
    headers.set(PROTOCOL_HEADER, String(protocol));

    for (let attempt = 1; ; attempt += 1) {
      let sent: Response;

      // One ask: a read's answered within `answerMs` (its body too, where `whole`), or failed with why.
      const send = async (): Promise<Response> => {
        const bounded = new AbortController();
        const bound = Math.max(1, Math.min(this.answerMs, remaining()));

        asking = Date.now();
        const timer = read ? setTimeout(() => { bounded.abort(new Error(`no answer in ${String(Math.round(bound / 1000))} s`)); }, bound) : undefined;
        const signal = init.signal === undefined || init.signal === null ? bounded.signal : AbortSignal.any([init.signal, bounded.signal]);

        try {
          const answer = await fetch(this.connection.url.replace(/\/$/u, '') + path, { ...init, headers, signal });

          if (!whole) return answer;
          // Its body bounded by its silence, not its length: a large artifact's bytes still coming are no lost answer
          // (row 8848: one past `answerMs` failed its CI run whole).
          clearTimeout(timer);

          return new Response(await bodyOf(answer, bound, bounded), { status: answer.status, headers: answer.headers });
        } catch (cause) {
          throw bounded.signal.aborted && init.signal?.aborted !== true ? bounded.signal.reason : cause;
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        sent = await deployed(`${method} ${path}`, send, init.signal);
      } catch (cause) {
        // A connection that failed is asked again, as a gateway's failure is; one its caller gave up on, never.
        if (init.signal?.aborted === true) throw cause;

        if (!again(errorOf({ cause }).message)) throw new Unreachable(`${method} ${path}`, { cause });
        await pause(Math.min(attempt * 1000, READ_PAUSE_MS, remaining()), init.signal);
        continue;
      }

      if ([500, 502, 503, 504].includes(sent.status) && again(`answered ${String(sent.status)}`)) {
        await pause(Math.min(attempt * 1000, READ_PAUSE_MS, remaining()), init.signal);
        continue;
      }

      if (!read && sent.headers.get(UNMADE_HEADER) === '1' && again(`answered ${String(sent.status)}, nothing made`, true)) {
        await pause(Math.random() * Math.min(attempt * 1000, READ_PAUSE_MS, remaining()), init.signal);
        continue;
      }

      // The Worker's own 404 says a thing is absent; an HTML one is a page from a Worker not yet answering.
      const absent = sent.status === 404 && sent.headers.get('content-type')?.startsWith('text/html') !== true;

      if (!sent.ok && !absent) throw new RequestError(sent.status, `${method} ${path}: ${await failureOf(sent)}`);

      return sent;
    }
  }

  /** `body` as JSON, and the answer's JSON. */
  async post(path: string, body: JsonBody, headers: Record<string, string> = {}): Promise<Json> {
    return v.parse(JsonSchema, await (await this.call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json());
  }

  /** The deployment's health; `signal` ends the ask, and every retry of it, once aborted. */
  async health(signal?: AbortSignal): Promise<Health> {
    return v.parse(HealthSchema, await (await this.call('/health', signal === undefined ? {} : { signal }, this.spoken)).json());
  }

  /** Admits no new job until the version deployed now is replaced, or `admit` is called; answers how many jobs are
   *  still open, or null for a Worker too old to drain. `signal` ends the ask, and every retry of it, once aborted. */
  async drain(signal?: AbortSignal): Promise<number | null> {
    // A Worker that answers the drain only in its own version is asked in each older one, down to the first that had it.
    for (let protocol = PROTOCOL; protocol >= FIRST_DRAIN; protocol -= 1) {
      const answer = await this.drainIn(protocol, signal);

      if (answer !== null) {
        this.spoken = protocol;

        return answer.status === 404 ? null : v.parse(v.object({ jobs: v.number() }), await answer.json()).jobs;
      }
    }

    return null;
  }

  async admit(signal?: AbortSignal): Promise<void> {
    await this.call('/drain', { method: 'DELETE', signal }, this.spoken);
  }

  /** Its jobs not yet done, every page read (`openJobs`) in the newest wire the Worker lists them in: one that drains
   *  in any wire still lists its jobs only in its own. */
  async openJobs(signal?: AbortSignal): Promise<ListedJob[]> {
    return await openJobs(async (path) => await this.readIn(path, signal));
  }

  /** `path` read in the newest wire the Worker answers it in, from this client's own down. */
  private async readIn(path: string, signal: AbortSignal | undefined): Promise<Response> {
    for (let protocol = PROTOCOL; ; protocol -= 1) {
      try {
        return await this.call(path, { signal }, protocol);
      } catch (cause) {
        if (!(cause instanceof RequestError && cause.status === 426) || protocol <= 1) throw cause;
      }
    }
  }

  /** The drain asked in wire `protocol`, or null when the Worker answers that it speaks another. */
  private async drainIn(protocol: number, signal: AbortSignal | undefined): Promise<Response | null> {
    try {
      return await this.call('/drain', { method: 'POST', signal }, protocol);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 426) return null;

      throw cause;
    }
  }

  /** A recipe's environment key, and what a commit for it should be packed against. */
  async resolve(recipe: Recipe, cpu?: readonly Cpu[]): Promise<{ readonly key: string; readonly base: string }> {
    const asked = { recipe: ownPacker(recipe) };

    return v.parse(v.object({ key: v.string(), base: v.string() }), await this.post('/environments/resolve', cpu === undefined ? asked : { ...asked, cpu }));
  }

  /** Where the runner keeps a commit's pack, under this client's `PACKER` and its shallow boundary (`CommitSchema`). */
  packPath(project: string, { sha, base, shallow = [] }: Pick<Commit, 'sha' | 'base' | 'shallow'>): string {
    return `/packs/${project}/${sha}/${base}?packer=${String(PACKER)}${shallow.length === 0 ? '' : `&shallow=${shallow.join(',')}`}`;
  }

  /** Whether the runner holds the pack at `path`. */
  async packHeld(path: string): Promise<boolean> {
    return (await this.call(path, { method: 'HEAD' })).status !== 404;
  }

  /** The pack in `file` stored at `path`: its size, or null where another client stored it first. One larger than a
   *  request may carry goes in parts of PACK_PART bytes, read from the file one at a time, and an upload that fails is
   *  aborted, so its parts don't stay in the bucket; the bucket's lifecycle aborts what a client that died left. Asked
   *  again while another client stores the same at that moment, which the runner answers 429 (#62). */
  async storePack(path: string, file: string): Promise<number | null> {
    const body = Bun.file(file);

    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.putPack(path, body);

        return body.size;
      } catch (cause) {
        if (!(cause instanceof RequestError) || cause.status !== 429 || attempt >= STORE_ATTEMPTS) throw cause;
      }

      await Bun.sleep(attempt * 1000);

      if (await this.packHeld(path)) return null;
    }
  }

  /** Stores what `path` names once: none when the runner has it, else `put`'s, asked again while another client stores
   *  the same at that moment, which the runner answers 429 (#62); what `put` answered, or null for none. */
  private async storeOnce<T>(path: string, put: () => Promise<T>): Promise<T | null> {
    for (let attempt = 1; ; attempt += 1) {
      if ((await this.call(path, { method: 'HEAD' })).status !== 404) return null;

      try {
        return await put();
      } catch (cause) {
        if (!(cause instanceof RequestError) || cause.status !== 429 || attempt >= STORE_ATTEMPTS) throw cause;
      }

      await Bun.sleep(attempt * 1000);
    }
  }

  /** `body` at `path`: in one PUT, or in parts past PACK_PART bytes, each read from it as it is sent. */
  private async putPack(path: string, body: ReturnType<typeof Bun.file>): Promise<void> {
    if (body.size <= PACK_PART) {
      await this.call(path, { method: 'PUT', body });

      return;
    }

    const { upload } = v.parse(v.object({ upload: v.string() }), await this.post(`${path}&uploads`, {}));
    const uploading = `${path}&upload=${encodeURIComponent(upload)}`;
    const parts = [];

    try {
      for (let start = 0, partNumber = 1; start < body.size; start += PACK_PART, partNumber += 1) {
        // A part put again is the same part, whole: its key makes it idempotent.
        const stored = await (await this.call(`${uploading}&part=${String(partNumber)}`, {
          method: 'PUT', body: body.slice(start, start + PACK_PART), headers: { [IDEMPOTENCY_HEADER]: `part ${String(partNumber)}` },
        })).json();

        parts.push(v.parse(v.object({ partNumber: v.number(), etag: v.string() }), stored));
      }

      await this.post(uploading, { parts });
    } catch (cause) {
      // The upload's own failure is the error; an abort that fails too leaves the parts to the bucket's lifecycle.
      await Promise.allSettled([this.call(uploading, { method: 'DELETE' })]);
      throw cause;
    }
  }

  /** Stores a function's bundle once, under the sha-256 of its bytes, and returns that digest. */
  async uploadBundle(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    const path = `/bundles/${digest}`;

    await this.storeOnce(path, async () => await this.call(path, { method: 'PUT', body: bytes }));

    return digest;
  }

  /** Sets the deployment's secret `name`, which a task that names it gets in its environment. */
  async setSecret(name: string, value: string): Promise<void> {
    await this.call(`/secrets/${name}`, { method: 'PUT', body: value });
  }

  /** The names of the deployment's secrets: no call reads a value back. */
  async secrets(): Promise<string[]> {
    return v.parse(v.object({ names: v.array(v.string()) }), await (await this.call('/secrets')).json()).names;
  }

  /** Whether there was one to delete. */
  async deleteSecret(name: string): Promise<boolean> {
    return v.parse(v.object({ deleted: v.boolean() }), await (await this.call(`/secrets/${name}`, { method: 'DELETE' })).json()).deleted;
  }

  async create(spec: v.InferInput<typeof JobSpecSchema>): Promise<string> {
    const refused = deadlineRefusal(spec.timeout, spec.deadline, spec.lease);

    if (refused !== null) throw new Error(refused);

    // One key for every ask of this job: a POST /jobs asked again after a dropped connection gets the job its first ask
    // made, never a second (`ArmadaFleet.admitKeyed`).
    return v.parse(v.object({ id: v.string() }), await this.post('/jobs', { ...spec, recipe: ownPacker(spec.recipe) }, { [IDEMPOTENCY_HEADER]: crypto.randomUUID() })).id;
  }

  async add(id: string, items: readonly Task[]): Promise<void> {
    await this.post(`/jobs/${id}/items`, { items });
  }

  async close(id: string): Promise<void> {
    await this.call(`/jobs/${id}/close`, { method: 'POST' });
  }

  async cancel(id: string): Promise<void> {
    await this.call(`/jobs/${id}/cancel`, { method: 'POST' });
  }

  /** Renews job `id`'s lease (`JobSpec.lease`): whether it still runs to hold one. */
  async renew(id: string): Promise<boolean> {
    return v.parse(v.object({ held: v.boolean() }), await (await this.call(`/jobs/${id}/lease`, { method: 'POST' })).json()).held;
  }

  async status(id: string): Promise<JobStatus> {
    const answer = await this.call(`/jobs/${id}`);

    if (answer.status === 404) throw new RequestError(404, `no job ${id} in this deployment`);

    return v.parse(JobStatusSchema, await answer.json());
  }

  /** Task `index` of job `id`: what it ran, where it stands, and once it ended, how long its last run took and where. */
  async task(id: string, index: number): Promise<TaskStatus> {
    const answer = await this.call(`/jobs/${id}/tasks/${String(index)}`);

    if (answer.status === 404) throw new RequestError(404, `no task ${String(index)} in job ${id}`);

    return v.parse(TaskStatusSchema, await answer.json());
  }

  /** Outcomes after `after`, in batches, and whether the job is done. */
  async events(id: string, after: number): Promise<v.InferOutput<typeof EventsSchema>> {
    return v.parse(EventsSchema, await (await this.call(`/jobs/${id}/events?after=${String(after)}`)).json());
  }

  /** Each task's item, in order. */
  async items(id: string): Promise<Json[]> {
    return v.parse(v.object({ items: v.array(JsonSchema) }), await (await this.call(`/jobs/${id}/items`)).json()).items;
  }

  /** A task's stored output as its bytes, or null. */
  async output(id: string, index: number): Promise<Uint8Array | null> {
    const stream = await this.outputStream(id, index);

    return stream === null ? null : await new Response(stream).bytes();
  }

  /** A task's stored output as it downloads, for one too large to hold, or null. */
  async outputStream(id: string, index: number): Promise<ReadableStream<Uint8Array> | null> {
    const response = await this.call(`/jobs/${id}/tasks/${String(index)}/output`);

    return response.status === 404 ? null : response.body;
  }

  async log(id: string, index: number): Promise<string | null> {
    const response = await this.call(`/jobs/${id}/tasks/${String(index)}/log`);

    return response.status === 404 ? null : await response.text();
  }

  /** Each run of a task that kept a log: for a gang, every rank of every attempt (`TaskRunsSchema`). */
  async runs(id: string, index: number): Promise<TaskRun[]> {
    return v.parse(TaskRunsSchema, await (await this.call(`/jobs/${id}/tasks/${String(index)}/runs`)).json()).runs;
  }

  /** One run's log (`runs`), or null. */
  async runLog(id: string, index: number, { vessel, attempt }: Pick<TaskRun, 'vessel' | 'attempt'>): Promise<string | null> {
    const response = await this.call(`/jobs/${id}/tasks/${String(index)}/runs/${vessel}.${String(attempt)}/log`);

    return response.status === 404 ? null : await response.text();
  }

  /** A task's artifacts directory as its stored tar.gz, or null. */
  async artifacts(id: string, index: number): Promise<Uint8Array | null> {
    return await this.whole(`/jobs/${id}/tasks/${String(index)}/artifacts`);
  }

  /** A read's whole answer, its bytes, or null where the Worker says it is absent: each ask bounded from its sending
   *  to its first byte, and then by each wait for its next (`asked`). */
  async whole(path: string): Promise<Uint8Array | null> {
    const answer = await this.asked(path, {}, PROTOCOL, true);

    return answer.status === 404 ? null : await answer.bytes();
  }
}

/** A job's times and counts, from its status. */
export function summaryOf(status: JobStatus): Summary {
  const finished = status.finishedAt ?? Date.now();
  const mapMs = finished - (status.startedAt ?? finished);
  const bootMs = status.vessels.flatMap((vessel) => vessel.bootMs === null ? [] : [vessel.bootMs]).sort((left, right) => left - right);
  const boots = status.vessels.flatMap((vessel) => vessel.boot === undefined ? [] : [vessel.boot]);
  const done = status.tasks.exited + status.tasks.failed;

  return {
    tasks: status.tasks.total, green: status.tasks.exited - status.tasks.red, red: status.tasks.red, failed: status.tasks.failed,
    wallMs: finished - status.createdAt, mapMs, vessels: status.vessels.length, bootMs, boots, tasksPerSecond: mapMs > 0 ? done / (mapMs / 1000) : 0,
  };
}

/** A job's containers and their boots in one line: their first answers, then the median of each boot phase (#32), and
 *  the hosts they ran on, most first (#40). */
export function describeBoots({ vessels, bootMs, boots }: Summary): string {
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const answers = `${String(vessels)} containers; first answers ${seconds(bootMs[0] ?? 0)} to ${seconds(bootMs.at(-1) ?? 0)} (median ${seconds(median(bootMs))})`;

  if (boots.length === 0) return answers;
  const restarts = boots.reduce((sum, boot) => sum + boot.restarts.length, 0);
  const hosts = Map.groupBy(boots.flatMap((boot) => boot.host === undefined ? [] : [hostLabel(boot.host)]), (host) => host);
  const onHosts = [...hosts].toSorted(([, left], [, right]) => right.length - left.length).map(([host, each]) => `${String(each.length)} on ${host}`);

  return `${answers}; median boot: ${seconds(median(boots.map((boot) => boot.waitMs)))} waiting for capacity, ${seconds(median(boots.map((boot) => boot.startMs)))} starting, `
    + `${seconds(median(boots.map((boot) => boot.setupMs)))} setting up${restarts > 0 ? `; ${String(restarts)} start${restarts === 1 ? '' : 's'} made again` : ''}`
    + `${onHosts.length === 0 ? '' : `; ${onHosts.join(', ')}`}`;
}
