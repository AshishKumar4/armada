/**
 * A rank's hub (`ArmadaHub`) over WebSockets as its Durable Object holds them, for the tests that drive it through its
 * `fetch` and its event handlers: the platform's `WebSocketPair` and socket states, a registry that lists a socket
 * closing until its close completes (as `getWebSockets` does), and storage that answers nothing, so a hub that touches it
 * waits forever and says so.
 */
import * as v from 'valibot';
import type { ArmadaHub } from '../src/hub';
import { PartSchema, type Part } from '../src/pairing';
import { state } from './harness';

/** The members of a WebSocket the hub uses. */
export type Socket = Partial<WebSocket>;

/** What a socket was told: each message, and how it was closed. */
interface Told {
  readonly sent: (string | ArrayBuffer | ArrayBufferView)[];
  closed?: readonly [number, string];
}

const told = new WeakMap<Socket, Told>();

const settling = new WeakMap<Socket, () => void>();

const OPEN = 1;

const CLOSING = 2;

const CLOSED = 3;

/** A socket as a Durable Object holds one: open until closed, then closing until `settle`, keeping its attachment and
 *  what it was told. */
function peer(): Socket {
  const heard: Told = { sent: [] };
  let attachment: Part | undefined;
  let readyState = OPEN;

  const socket: Socket = {
    get readyState() {
      return readyState;
    },
    send: (message) => { heard.sent.push(message); },
    close: (code, reason) => {
      readyState = CLOSING;
      heard.closed ??= [code ?? 1005, reason ?? ''];
    },
    serializeAttachment: (value) => { attachment = v.parse(PartSchema, value); },
    deserializeAttachment: () => structuredClone(attachment),
  };

  told.set(socket, heard);
  settling.set(socket, () => { readyState = CLOSED; });

  return socket;
}

/** The two ends a hub's upgrade makes: the first is the relay's, the second the hub's. */
export class Pair {
  static readonly made: Pair[] = [];

  readonly 0 = peer();

  readonly 1 = peer();

  constructor() {
    Pair.made.push(this);
  }
}

/** What `socket` was sent, in order; undefined for no socket. */
export const heard = (socket: Socket | undefined) => socket === undefined ? undefined : told.get(socket)?.sent;

/** How `socket` was closed, as its code and reason, once it was. */
export const closure = (socket: Socket | undefined) => socket === undefined ? undefined : told.get(socket)?.closed;

/** `socket`'s connection goes, the network's doing: it is closing, and its close event is yet to come. */
export function sever(socket: Socket | undefined, code: number, reason: string): void {
  socket?.close?.(code, reason);
}

/** `socket`'s close completes: the platform stops listing it, and its close event is the hub's to take. */
export function settle(socket: Socket | undefined): void {
  if (socket !== undefined) settling.get(socket)?.();
}

/** A hub's Durable Object state whose storage waits forever, each call to it counted in `touched`, and whose WebSocket
 *  registry lists every socket the hub took, closing ones too, until it settles. */
export function hubContext(touched: string[]): DurableObjectState {
  const registry = new Map<Socket, readonly string[]>();
  const { ctx } = state();

  for (const method of ['get', 'put', 'delete', 'list', 'setAlarm', 'getAlarm', 'deleteAlarm'] as const) {
    Object.assign(ctx.storage, { [method]: async () => { touched.push(method); await new Promise<never>(() => undefined); } });
  }

  Object.assign(ctx, {
    acceptWebSocket: (socket: Socket, tags: readonly string[]) => { registry.set(socket, tags); },
    getWebSockets: (tag: string) => [...registry].filter(([socket, tags]) => socket.readyState !== CLOSED && tags.includes(tag)).map(([socket]) => socket),
  });

  return ctx;
}

/** The platform's WebSocketPair and the socket states the hub reads, in place of Bun's, until the function this returns
 *  puts them back. */
export function platform(): () => void {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'WebSocketPair');
  const constants = Object.getOwnPropertyDescriptors(WebSocket);

  Object.assign(globalThis, { WebSocketPair: Pair });
  Object.assign(WebSocket, { READY_STATE_OPEN: OPEN, READY_STATE_CONNECTING: 0 });

  return () => {
    Pair.made.length = 0;

    if (saved === undefined) Reflect.deleteProperty(globalThis, 'WebSocketPair');
    else Object.defineProperty(globalThis, 'WebSocketPair', saved);

    for (const name of ['READY_STATE_OPEN', 'READY_STATE_CONNECTING']) {
      const descriptor = constants[name];

      if (descriptor === undefined) Reflect.deleteProperty(WebSocket, name);
      else Object.defineProperty(WebSocket, name, descriptor);
    }
  };
}

/** `message` from a relay on `socket`, which the hub took, delivered as the runtime does: its own event. */
export async function deliver(hub: ArmadaHub, socket: Socket | undefined, message: string | ArrayBuffer): Promise<void> {
  if (socket === undefined) throw new Error('no such socket');
  // SAFETY: a socket here was constructed by `peer` above, which defines the only members the hub calls on a
  // WebSocket: readyState, send, close and the attachments.
  await hub.webSocketMessage(socket as WebSocket, message);
}
