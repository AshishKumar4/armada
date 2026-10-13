/**
 * The dashboard's requests: a deployment's routes, with its bearer and the wire's version, each answer parsed by the
 * schema the Worker and the CLI share. A deployment is this page's own, whose bearer stays in this browser's storage
 * for this origin, or another the page reads beside it, from that one's own origin under its bearer. `armada dashboard`
 * hands the bearers over in the page's fragment, which no request carries.
 */
import * as v from 'valibot';
import { DEPLOYMENT_HEADER, HealthSchema, jsonOf, PROTOCOL, PROTOCOL_HEADER, type Health } from '../../src/protocol';

const TOKEN = 'armada.token';

/** The other deployments this browser reads beside this page's own (`armada dashboard --all`). */
const OTHERS = 'armada.others';

/** Another deployment, as its connection file names it. */
const OtherSchema = v.object({ url: v.pipe(v.string(), v.url()), token: v.string() });

/** The Worker refused this page's own bearer, or there is none. */
export class SignedOut extends Error {
  constructor() {
    super('signed out');
    this.name = 'SignedOut';
  }
}

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export const token = (): string | null => localStorage.getItem(TOKEN);

export function signIn(bearer: string): void {
  localStorage.setItem(TOKEN, bearer.trim());
}

export function signOut(): void {
  localStorage.removeItem(TOKEN);
  localStorage.removeItem(OTHERS);
}

/** What `armada dashboard` puts in the fragment: this deployment's bearer, or every deployment's connection with
 *  `--all`. Kept, and taken out of the address bar and history, as is one that does not read, which changes nothing. */
export function takeToken(): void {
  const given = /^#token=([A-Za-z0-9._~-]{32,})$/u.exec(location.hash)?.[1];
  const all = /^#deployments=([A-Za-z0-9_-]+)$/u.exec(location.hash)?.[1];

  if (given !== undefined) signIn(given);

  // Base64 whose length leaves one character over decodes to nothing; any other decodes.
  if (all !== undefined && all.length % 4 !== 1) {
    const text = new TextDecoder().decode(Uint8Array.from(atob(all.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0)));
    const connections = v.safeParse(v.array(OtherSchema), jsonOf(text));

    if (connections.success) {
      const own = connections.output.find((each) => new URL(each.url).origin === location.origin);

      if (own !== undefined) signIn(own.token);
      localStorage.setItem(OTHERS, JSON.stringify(connections.output.filter((each) => each !== own)));
    }
  }

  if (given !== undefined || all !== undefined) history.replaceState(null, '', `${location.pathname}#/`);
}

/** A deployment the page reads, and where its pages are. */
export interface Client {
  /** The first label of its host, its Worker's name. */
  readonly name: string;
  /** Its host, which names it in the page's addresses: two accounts may each have a Worker of one name. */
  readonly host: string;
  /** Whether it is this page's own deployment. */
  readonly own: boolean;
  get<const S extends v.GenericSchema>(path: string, schema: S, signal?: AbortSignal): Promise<v.InferOutput<S>>;
  /** A stored object (a log, an output, a task's artifacts), or null where there is none. */
  blob(path: string, signal?: AbortSignal): Promise<Blob | null>;
  /** The page's address of `page` (`jobs/<id>`, or '' for its fleet) on this deployment. */
  href(page: string): string;
}

/** How the page names `at` among `all`: its Worker's name, or its host where another has the same name. */
export const labelOf = (at: Client, all: readonly Client[]): string => all.filter((each) => each.name === at.name).length > 1 ? at.host : at.name;

/** What a failed answer says: the Worker's own error, or its status. */
async function failure(response: Response): Promise<string> {
  const said = v.safeParse(v.object({ error: v.string() }), jsonOf(await response.text()));

  return said.success ? said.output.error : `the Worker answered ${String(response.status)}`;
}

/** A request to the deployment at `url` ('' for this page's own) under the bearer `bearer` answers when asked. Only
 *  this page's own refusing its bearer signs the page out; another's refusal is that one's failure. */
async function request(url: string, bearer: () => string | null, path: string, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers({ [PROTOCOL_HEADER]: String(PROTOCOL) });
  const held = bearer();

  if (held !== null) headers.set('authorization', `Bearer ${held}`);
  const response = await fetch(url + path, { headers, signal });

  if (response.status === 403 && url === '') throw new SignedOut();

  return response;
}

async function answered(url: string, bearer: () => string | null, path: string, signal?: AbortSignal): Promise<Response> {
  const response = await request(url, bearer, path, signal);

  if (!response.ok) throw new RequestError(response.status, await failure(response));

  return response;
}

/** A client of the deployment on `host` at `url` ('' for this page's own) under the bearer `bearer` answers when asked.
 *  Its pages' addresses name its host when the page reads more than one deployment (`scoped`), the bare ones being
 *  every deployment's; else they are this page's own. */
function client(host: string, url: string, bearer: () => string | null, scoped: boolean): Client {
  return {
    name: host.split('.')[0] ?? host, host, own: url === '',
    get: async (path, schema, signal) => v.parse(schema, await (await answered(url, bearer, path, signal)).json()),
    blob: async (path, signal) => {
      const response = await request(url, bearer, path, signal);

      if (response.status === 404) return null;

      if (!response.ok) throw new RequestError(response.status, await failure(response));

      return await response.blob();
    },
    href: (page) => scoped ? `#/@${host}/${page}` : `#/${page}`,
  };
}

/** The other deployments this browser reads, each under its own bearer. */
function others(): Client[] {
  const kept = v.safeParse(v.array(OtherSchema), jsonOf(localStorage.getItem(OTHERS) ?? '[]'));

  return kept.success ? kept.output.map(({ url, token: bearer }) => client(new URL(url).host, url.replace(/\/$/u, ''), () => bearer, true)) : [];
}

/** The deployments this page reads, its own first, and its own health. Its own is the page's host, or the one
 *  `armada dashboard --serve` passes requests to. */
export async function deployments(): Promise<{ readonly own: Client; readonly others: readonly Client[]; readonly health: Health }> {
  const response = await answered('', token, '/health');
  const beside = others();

  return {
    own: client(response.headers.get(DEPLOYMENT_HEADER) ?? location.host, '', token, beside.length > 0), others: beside, health: v.parse(HealthSchema, await response.json()),
  };
}
