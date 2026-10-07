/**
 * The armada SDK: map a command or a handler over items on a fleet of containers started from an environment
 * snapshot, and read each task's outcome as it lands.
 *
 *   const armada = connect();
 *   const job = await armada.map({ recipe: { setup: 'apt-get install -y imagemagick' }, items: files, run: { command: ['convert', '{item}', '{out}'] }, output: true });
 *   for await (const outcome of job.outcomes()) console.log(outcome.index, outcome.exitCode);
 *   const summary = await job.summary();
 *
 * A handler is a function's source, called under `node` with the item; its return value is the task's output:
 *
 *   await armada.map({ items: [1, 2, 3], handler: (n: number) => n * n });
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { EventsSchema, JobStatusSchema, PACKER, type JobSpec, type JobSpecSchema, type JobStatus, type Outcome, type Recipe, type RecipeSchema } from './protocol';

export const CONFIG_DIR = join(homedir(), '.config', 'armada');

/** The largest pack, in bytes, sent in one request; a Worker takes 100 MB, and R2 wants every part but the last alike. */
export const PACK_PART = 64 * 1024 * 1024;

export const ConnectionSchema = v.object({ url: v.string(), token: v.string(), account: v.string() });

export type Connection = v.InferOutput<typeof ConnectionSchema>;

/** What `map` takes: a job spec, with a recipe's defaults filled and a handler given as a function if wanted. */
export type MapSpec = Omit<v.InferInput<typeof JobSpecSchema>, 'run' | 'recipe'> & {
  readonly recipe?: v.InferInput<typeof RecipeSchema>;
} & ({ readonly run: JobSpec['run'] } | { readonly handler: ((item: never) => unknown) | string });

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

/** A failed response in one line: the Worker's JSON error as it is, or the status and the title or first line of any
 *  other page, such as the error page a Worker still rolling out answers with. */
async function failureOf(response: Response): Promise<string> {
  const text = await response.text();

  try {
    JSON.parse(text);

    return `${String(response.status)} ${text}`;
  } catch {
    const line = (/<title>([^<]*)<\/title>/iu.exec(text)?.[1] ?? text.split('\n').find((each) => each.trim() !== '') ?? '').trim().slice(0, 200);

    return `${String(response.status)} from the Worker (it may still be deploying)${line === '' ? '' : `: ${line}`}`;
  }
}

export class Armada {
  constructor(readonly connection: Connection) {}

  async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);

    headers.set('authorization', `Bearer ${this.connection.token}`);
    const response = await fetch(this.connection.url.replace(/\/$/u, '') + path, { ...init, headers });

    if (!response.ok && response.status !== 404) throw new Error(`${init.method ?? 'GET'} ${path}: ${await failureOf(response)}`);

    return response;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return await (await this.call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
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

  async map(spec: MapSpec): Promise<Job> {
    const run = 'run' in spec ? spec.run : { handler: typeof spec.handler === 'string' ? spec.handler : spec.handler.toString() };
    const body: Record<string, unknown> = { ...spec, recipe: spec.recipe ?? {}, run };

    delete body['handler'];
    const { id } = v.parse(v.object({ id: v.string() }), await this.post('/jobs', body));

    return new Job(this, id);
  }

  job(id: string): Job {
    return new Job(this, id);
  }
}

export class Job {
  constructor(private readonly armada: Armada, readonly id: string) {}

  async status(): Promise<JobStatus> {
    return v.parse(JobStatusSchema, await (await this.armada.call(`/jobs/${this.id}`)).json());
  }

  /** Each task's outcome, as it lands, until the job is done. Read in batches, never a round trip per line. */
  async *outcomes(pollMs = 1_000): AsyncGenerator<Outcome> {
    let after = 0;

    for (;;) {
      const batch = v.parse(EventsSchema, await (await this.armada.call(`/jobs/${this.id}/events?after=${String(after)}`)).json());

      for (const event of batch.events) {
        after = event.seq;
        yield event.outcome;
      }

      if (batch.done) return;

      if (batch.events.length === 0) await Bun.sleep(pollMs);
    }
  }

  /** A task's stored output (`{out}`, or a handler's JSON value) as text, or null. */
  async output(index: number): Promise<string | null> {
    const response = await this.armada.call(`/jobs/${this.id}/tasks/${String(index)}/output`);

    return response.status === 404 ? null : await response.text();
  }

  /** A task's stored output as its exact bytes (an image, an archive), or null. */
  async outputBytes(index: number): Promise<Uint8Array | null> {
    const response = await this.armada.call(`/jobs/${this.id}/tasks/${String(index)}/output`);

    return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer());
  }

  async log(index: number): Promise<string | null> {
    const response = await this.armada.call(`/jobs/${this.id}/tasks/${String(index)}/log`);

    return response.status === 404 ? null : await response.text();
  }

  async cancel(): Promise<void> {
    await this.armada.call(`/jobs/${this.id}/cancel`, { method: 'POST' });
  }

  async summary(): Promise<Summary> {
    const status = await this.status();
    const finished = status.finishedAt ?? Date.now();
    const mapMs = finished - (status.startedAt ?? finished);
    const bootMs = status.vessels.flatMap((vessel) => vessel.bootMs === null ? [] : [vessel.bootMs]).sort((left, right) => left - right);
    const done = status.tasks.exited + status.tasks.failed;

    return {
      tasks: status.tasks.total, green: status.tasks.exited - status.tasks.red, red: status.tasks.red, failed: status.tasks.failed,
      wallMs: finished - status.createdAt, mapMs, vessels: status.vessels.length, bootMs, tasksPerSecond: mapMs > 0 ? done / (mapMs / 1000) : 0,
    };
  }
}
