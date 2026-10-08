/**
 * A deployment of armada and the requests it answers: jobs, their events and outputs, packs and bundles. The typed
 * API (`task.ts`) and the CLI are built on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { EventsSchema, HealthSchema, JobStatusSchema, JsonSchema, PACKER, PROTOCOL, PROTOCOL_HEADER, type Health, type JobSpecSchema, type JobStatus, type Json, type Recipe, type Task } from './protocol';

export const CONFIG_DIR = join(homedir(), '.config', 'armada');

/** How often a read is asked of a runner whose gateway failed to answer it (`Armada.call`). */
export const READ_ATTEMPTS = 5;

/** The largest pack, in bytes, sent in one request; a Worker takes 100 MB, and R2 wants every part but the last alike. */
export const PACK_PART = 64 * 1024 * 1024;

/** How to reach a deployment: its URL, bearer and account, and the fleet cap its last deploy gave it. */
export const ConnectionSchema = v.object({ url: v.string(), token: v.string(), account: v.string(), vcpus: v.optional(v.number()) });

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
  /** Each vessel's time from asking for a container to its first answer, sorted. */
  readonly bootMs: readonly number[];
  readonly tasksPerSecond: number;
}

/** Where `armada deploy --name=<name>` writes a deployment's connection: `connection.json` for the default `armada`. */
export function connectionFile(name: string): string {
  return join(CONFIG_DIR, name === 'armada' ? 'connection.json' : `${name}.json`);
}

/** The runner this machine deployed (`armada deploy`), the one `ARMADA_CONNECTION` names, or `ARMADA_URL` and
 *  `ARMADA_TOKEN`. */
export function connect(): Armada {
  const url = process.env['ARMADA_URL'];
  const token = process.env['ARMADA_TOKEN'];

  if (url !== undefined && token !== undefined) return new Armada({ url, token, account: process.env['ARMADA_ACCOUNT'] ?? '' });
  const named = process.env['ARMADA_CONNECTION'];
  const file = named ?? connectionFile('armada');

  if (!existsSync(file)) throw new Error(named === undefined ? 'not deployed from this machine: run `armada deploy`, or set ARMADA_URL and ARMADA_TOKEN' : `no connection file at ${file}`);

  return new Armada(v.parse(ConnectionSchema, JSON.parse(readFileSync(file, 'utf8'))));
}

/** A failed response in one line: the Worker's own error, or the status and the title or first line of any other page,
 *  such as the error page a Worker still rolling out answers with. */
async function failureOf(response: Response): Promise<string> {
  const text = await response.text();

  try {
    const said = v.safeParse(v.object({ error: v.string() }), JSON.parse(text));

    return `${String(response.status)} ${said.success ? said.output.error : text}`;
  } catch {
    const line = (/<title>([^<]*)<\/title>/iu.exec(text)?.[1] ?? text.split('\n').find((each) => each.trim() !== '') ?? '').trim().slice(0, 200);

    return `${String(response.status)} from the Worker (it may still be deploying)${line === '' ? '' : `: ${line}`}`;
  }
}

/** The first version of the wire whose Worker drains. */
const FIRST_DRAIN = 2;

/** A request the Worker answered with an error: its status, and what it said. */
export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export class Armada {
  constructor(readonly connection: Connection) {}

  /** The wire's version this client speaks to the deployment: its own, or an older one a drain found the deployed
   *  Worker speaks, for the drain, the health and the admit, which are the same in every version. */
  private spoken = PROTOCOL;

  /** A request to the runner. A read (GET, HEAD) that meets a gateway's 502, 503 or 504, the Worker's own 500, or a
   *  dropped connection, is asked again, up to READ_ATTEMPTS times a second apart more each time: the Worker answers it
   *  again unchanged, and a `run` that polls for half an hour should not end on one. A Durable Object the runtime
   *  restarted throws once under a read ("Worker threw exception"), and the next read is answered. */
  async call(path: string, init: RequestInit = {}, protocol = PROTOCOL): Promise<Response> {
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const attempts = method === 'GET' || method === 'HEAD' ? READ_ATTEMPTS : 1;

    headers.set('authorization', `Bearer ${this.connection.token}`);
    headers.set(PROTOCOL_HEADER, String(protocol));

    for (let attempt = 1; ; attempt += 1) {
      const sent = await fetch(this.connection.url.replace(/\/$/u, '') + path, { ...init, headers }).catch((error: unknown) => error);
      const passing = sent instanceof Response ? [500, 502, 503, 504].includes(sent.status) : true;

      if (passing && attempt < attempts) {
        await Bun.sleep(attempt * 1000);
        continue;
      }
      if (!(sent instanceof Response)) throw sent;
      // The Worker's own 404 says a thing is absent; an HTML one is a page from a Worker not yet answering.
      const absent = sent.status === 404 && sent.headers.get('content-type')?.startsWith('text/html') !== true;

      if (!sent.ok && !absent) throw new RequestError(sent.status, `${method} ${path}: ${await failureOf(sent)}`);

      return sent;
    }
  }

  /** `body` as JSON, and the answer's JSON. */
  async post<Body>(path: string, body: Body): Promise<Json> {
    return v.parse(JsonSchema, await (await this.call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  }

  async health(): Promise<Health> {
    return v.parse(HealthSchema, await (await this.call('/health', {}, this.spoken)).json());
  }

  /** Admits no new job until the version deployed now is replaced, or `admit` is called; answers how many jobs are
   *  still open, or null for a Worker too old to drain. */
  async drain(): Promise<number | null> {
    // A Worker that answers the drain only in its own version is asked in each older one, down to the first that had it.
    for (let protocol = PROTOCOL; protocol >= FIRST_DRAIN; protocol -= 1) {
      const answer = await this.call('/drain', { method: 'POST' }, protocol).catch((cause: unknown) => {
        if (cause instanceof RequestError && cause.status === 426) return null;
        throw cause;
      });

      if (answer !== null) {
        this.spoken = protocol;

        return answer.status === 404 ? null : v.parse(v.object({ jobs: v.number() }), await answer.json()).jobs;
      }
    }

    return null;
  }

  async admit(): Promise<void> {
    await this.call('/drain', { method: 'DELETE' }, this.spoken);
  }

  /** A recipe's environment key, and what a commit for it should be packed against. */
  async resolve(recipe: Recipe): Promise<{ readonly key: string; readonly base: string }> {
    return v.parse(v.object({ key: v.string(), base: v.string() }), await this.post('/environments/resolve', { recipe }));
  }

  /** Stores a commit's pack once, under this client's `PACKER`; `pack` is called only when the runner lacks it. One
   *  larger than a request may carry goes in parts of PACK_PART bytes. */
  async uploadPack(project: string, sha: string, base: string, pack: () => Blob): Promise<number | null> {
    const path = `/packs/${project}/${sha}/${base}?packer=${String(PACKER)}`;

    if ((await this.call(path, { method: 'HEAD' })).status !== 404) return null;
    const body = pack();

    if (body.size <= PACK_PART) {
      await this.call(path, { method: 'PUT', body });

      return body.size;
    }
    const { upload } = v.parse(v.object({ upload: v.string() }), await this.post(`${path}&uploads`, {}));
    const bytes = new Uint8Array(await body.arrayBuffer());
    const parts = [];

    for (let start = 0, partNumber = 1; start < bytes.length; start += PACK_PART, partNumber += 1) {
      const stored = await (await this.call(`${path}&upload=${encodeURIComponent(upload)}&part=${String(partNumber)}`, { method: 'PUT', body: bytes.subarray(start, start + PACK_PART) })).json();

      parts.push(v.parse(v.object({ partNumber: v.number(), etag: v.string() }), stored));
    }
    await this.post(`${path}&upload=${encodeURIComponent(upload)}`, { parts });

    return body.size;
  }

  /** Stores a function's bundle once, under the sha-256 of its bytes, and returns that digest. */
  async uploadBundle(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    const path = `/bundles/${digest}`;

    if ((await this.call(path, { method: 'HEAD' })).status === 404) await this.call(path, { method: 'PUT', body: bytes });

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
    return v.parse(v.object({ id: v.string() }), await this.post('/jobs', spec)).id;
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

  async status(id: string): Promise<JobStatus> {
    return v.parse(JobStatusSchema, await (await this.call(`/jobs/${id}`)).json());
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

  /** A task's artifacts directory as its stored tar.gz, or null. */
  async artifacts(id: string, index: number): Promise<Uint8Array | null> {
    const response = await this.call(`/jobs/${id}/tasks/${String(index)}/artifacts`);

    return response.status === 404 ? null : await new Response(response.body).bytes();
  }
}

/** A job's times and counts, from its status. */
export function summaryOf(status: JobStatus): Summary {
  const finished = status.finishedAt ?? Date.now();
  const mapMs = finished - (status.startedAt ?? finished);
  const bootMs = status.vessels.flatMap((vessel) => vessel.bootMs === null ? [] : [vessel.bootMs]).sort((left, right) => left - right);
  const done = status.tasks.exited + status.tasks.failed;

  return {
    tasks: status.tasks.total, green: status.tasks.exited - status.tasks.red, red: status.tasks.red, failed: status.tasks.failed,
    wallMs: finished - status.createdAt, mapMs, vessels: status.vessels.length, bootMs, tasksPerSecond: mapMs > 0 ? done / (mapMs / 1000) : 0,
  };
}
