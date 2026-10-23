/**
 * ArmadaHub: one rank's end of its gang's network, which the gang's relays dial out to (`relay.ts`). It performs no
 * storage operation, ever: a Durable Object delivers no event while one is pending (its input gate), and a vessel's
 * storage, which stalls and resets under the platform (a vessel's object stalled 2.5 min, and its relay opens with
 * it), is off every link's path. What it holds lives in its WebSockets' tags and attachments, so it survives
 * hibernation as they do.
 *
 * The rank's relay keeps a control socket here. A relay opening a link to the rank's port opens a data socket here
 * ('out'); the hub tells the control socket `o <link> <port> <0|1>`, and the rank's relay dials its own data socket
 * for the link ('in'). The two are paired and each told `r`, before which neither end sends the link's messages, and
 * from then the hub passes each message to the other. A link's protocol, its numbered bytes, counts and resumes, is
 * the relays' alone. A control socket that goes is uncertainty, not a rank gone: the opens waiting stay, and its
 * next control socket is told them. A socket that goes closes the other of its pair only.
 */

import { DurableObject } from 'cloudflare:workers';
import { equal, gangToken, type Env } from './env';
import { LINK_ID, RELAY_HEADER } from './relay';

/** A socket's part, kept in its attachment: the control socket, or one end of a link, its pair once paired. */
export interface Part {
  readonly role: 'control' | 'out' | 'in';
  readonly link?: string;
  readonly port?: number;
  readonly resume?: boolean;
  /** The pair it is in: one per pairing, so a replaced pair's close reaches none of its successor's. */
  readonly pair?: string | null;
}

/** What the pairing needs of where its sockets live: the Durable Object's hibernatable WebSockets, or a test's. */
export interface Sockets<S> {
  /** Every open socket with `tag`. */
  tagged(tag: string): S[];
  part(socket: S): Part;
  /** Takes `socket` with `part` under `tags`. */
  take(socket: S, part: Part, tags: readonly string[]): void;
  mark(socket: S, part: Part): void;
  send(socket: S, message: string | ArrayBuffer): void;
  close(socket: S, code: number, reason: string): void;
}

/** What a waiting open says to the control socket. */
const said = (part: Part): string => `o ${part.link ?? ''} ${String(part.port ?? 0)} ${part.resume === true ? '1' : '0'}`;

/** The rank's relay's control socket: one at a time, the newest; told every open still waiting. */
export function controlled<S>(sockets: Sockets<S>, socket: S): void {
  for (const earlier of sockets.tagged('control')) sockets.close(earlier, 1000, 'a newer control socket');
  sockets.take(socket, { role: 'control' }, ['control']);

  for (const waiting of sockets.tagged('out')) {
    const part = sockets.part(waiting);

    if (part.pair == null) sockets.send(socket, said(part));
  }
}

/** A relay's open of `link` to this rank's `port`: an earlier open of it, and its pair, give way, and the control
 *  socket, if there is one now, is told. */
export function opened<S>(sockets: Sockets<S>, socket: S, link: string, port: number, resume: boolean): void {
  for (const earlier of [...sockets.tagged(`out:${link}`), ...sockets.tagged(`in:${link}`)]) sockets.close(earlier, 1000, 'a newer open of its link');
  const part: Part = { role: 'out', link, port, resume, pair: null };

  sockets.take(socket, part, ['out', `out:${link}`]);

  for (const control of sockets.tagged('control')) sockets.send(control, said(part));
}

/** The rank's relay's end of `link`: paired with its waiting open and both told `r`, or closed where none waits. */
export function accepted<S>(sockets: Sockets<S>, socket: S, link: string): void {
  const waiting = sockets.tagged(`out:${link}`).find((each) => sockets.part(each).pair == null);

  if (waiting === undefined) {
    sockets.take(socket, { role: 'in', link, pair: null }, ['in', `in:${link}`]);
    sockets.close(socket, 4404, 'no open of this link waits');

    return;
  }

  const pair = crypto.randomUUID();

  sockets.mark(waiting, { ...sockets.part(waiting), pair });
  sockets.take(socket, { role: 'in', link, pair }, ['in', `in:${link}`]);
  sockets.send(waiting, 'r');
  sockets.send(socket, 'r');
}

/** The other socket of `socket`'s pair, or undefined. */
function partner<S>(sockets: Sockets<S>, socket: S): S | undefined {
  const part = sockets.part(socket);

  if (part.role === 'control' || part.pair == null) return undefined;

  return sockets.tagged(`${part.role === 'out' ? 'in' : 'out'}:${part.link ?? ''}`).find((each) => sockets.part(each).pair === part.pair);
}

/** A message on a socket: an end's, passed to the other end of its pair. One before its pairing breaks the
 *  handshake, which neither end does, and closes it. */
export function passed<S>(sockets: Sockets<S>, socket: S, message: string | ArrayBuffer): void {
  if (sockets.part(socket).role === 'control') return;
  const other = partner(sockets, socket);

  if (other === undefined) {
    sockets.close(socket, 4409, 'a message before its pair');

    return;
  }

  sockets.send(other, message);
}

/** A socket gone: the other of its pair goes too, so each end takes the next its relay makes. */
export function gone<S>(sockets: Sockets<S>, socket: S): void {
  const other = partner(sockets, socket);

  if (other !== undefined) sockets.close(other, 1000, 'the other end of its pair went');
}

/** The hub's sockets as its Durable Object keeps them: hibernatable, their parts in their attachments. */
class Hibernating implements Sockets<WebSocket> {
  constructor(private readonly ctx: DurableObjectState) {}

  tagged(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  part(socket: WebSocket): Part {
    // SAFETY: every socket this object takes is given its part as it is taken (`take`), and only a Part is ever set.
    return socket.deserializeAttachment() as Part;
  }

  take(socket: WebSocket, part: Part, tags: readonly string[]): void {
    this.ctx.acceptWebSocket(socket, [...tags]);
    socket.serializeAttachment(part);
  }

  mark(socket: WebSocket, part: Part): void {
    socket.serializeAttachment(part);
  }

  send(socket: WebSocket, message: string | ArrayBuffer): void {
    try {
      socket.send(message);
    } catch {
      // A socket closing as it is sent to: its close event follows, which ends its pair.
    }
  }

  close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed: nothing more to end.
    }
  }
}

export class ArmadaHub extends DurableObject<Env> {
  private readonly sockets = new Hibernating(this.ctx);

  /** `/hub/<job>/<index>/<attempt>/<rank>/control`, or `/link?id=<link>&port=<port>[&resume=1]` to open a link to the
   *  rank, or `/link?id=<link>&accept=1` for the rank's own end of it: a WebSocket that presents the gang's token. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , job = '', index = '', attempt = '', , kind = ''] = url.pathname.split('/');
    const token = await gangToken(this.env.ARMADA_TOKEN, job, Number(index), Number(attempt));

    if (!equal(token, request.headers.get(RELAY_HEADER) ?? '')) return new Response('forbidden', { status: 403 });
    const link = url.searchParams.get('id') ?? '';
    const port = Number(url.searchParams.get('port'));

    if (request.headers.get('upgrade') !== 'websocket' || (kind !== 'control' && (kind !== 'link' || !LINK_ID.test(link)
      || (!url.searchParams.has('accept') && (!Number.isInteger(port) || port < 1 || port > 65_535))))) {
      return new Response('a hub takes a control WebSocket, or a link\'s, to a port under its id', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    if (client === undefined || server === undefined) throw new Error('a WebSocketPair has two ends');

    if (kind === 'control') controlled(this.sockets, server);
    else if (url.searchParams.has('accept')) accepted(this.sockets, server, link);
    else opened(this.sockets, server, link, port, url.searchParams.has('resume'));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    passed(this.sockets, socket, message);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    gone(this.sockets, socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    gone(this.sockets, socket);
  }
}
