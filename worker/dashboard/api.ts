/**
 * The dashboard's requests: the Worker's own routes, with the deployment's bearer and the wire's version, each answer
 * parsed by the schema the Worker and the CLI share. The bearer stays in this browser's storage for this origin; `armada
 * dashboard` hands it over in the page's fragment, which no request carries.
 */
import * as v from 'valibot';
import { DEPLOYMENT_HEADER, HealthSchema, jsonOf, PROTOCOL, PROTOCOL_HEADER, type Health } from '../../src/protocol';

const TOKEN = 'armada.token';

/** The Worker refused the bearer, or there is none. */
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
}

/** A bearer in the fragment, as `armada dashboard` opens the page: kept, and taken out of the address bar and history. */
export function takeToken(): void {
  const given = /^#token=([A-Za-z0-9._~-]{32,})$/u.exec(location.hash)?.[1];

  if (given === undefined) return;
  signIn(given);
  history.replaceState(null, '', `${location.pathname}#/`);
}

async function request(path: string): Promise<Response> {
  const headers = new Headers({ [PROTOCOL_HEADER]: String(PROTOCOL) });
  const bearer = token();

  if (bearer !== null) headers.set('authorization', `Bearer ${bearer}`);
  const response = await fetch(path, { headers });

  if (response.status === 403) throw new SignedOut();

  return response;
}

/** What a failed answer says: the Worker's own error, or its status. */
async function failure(response: Response): Promise<string> {
  const said = v.safeParse(v.object({ error: v.string() }), jsonOf(await response.text()));

  return said.success ? said.output.error : `the Worker answered ${String(response.status)}`;
}

async function answered(path: string): Promise<Response> {
  const response = await request(path);

  if (!response.ok) throw new RequestError(response.status, await failure(response));

  return response;
}

export async function get<const S extends v.GenericSchema>(path: string, schema: S): Promise<v.InferOutput<S>> {
  return v.parse(schema, await (await answered(path)).json());
}

/** The deployment's health and its host: this page's own, or the one `armada dashboard --serve` passes requests to. */
export async function deployment(): Promise<{ readonly health: Health; readonly host: string }> {
  const response = await answered('/health');

  return { health: v.parse(HealthSchema, await response.json()), host: response.headers.get(DEPLOYMENT_HEADER) ?? location.hostname };
}

/** A stored object (a log, an output, a task's artifacts), or null where there is none. */
export async function blob(path: string): Promise<Blob | null> {
  const response = await request(path);

  if (response.status === 404) return null;

  if (!response.ok) throw new RequestError(response.status, await failure(response));

  return await response.blob();
}
