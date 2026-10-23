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
import * as v from 'valibot';
import { accepted, controlled, gone, opened, PartSchema, passed, type Part, type Sockets } from './pairing';
import { LINK_ID, RELAY_HEADER } from './relay';

/** The hub's sockets as its Durable Object keeps them: hibernatable, their parts in their attachments. */
class Hibernating implements Sockets<WebSocket> {
  constructor(private readonly ctx: DurableObjectState) {}

  tagged(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  part(socket: WebSocket): Part {
    return v.parse(PartSchema, socket.deserializeAttachment());
  }

  take(socket: WebSocket, part: Part, tags: readonly string[]): void {
    this.ctx.acceptWebSocket(socket, [...tags]);
    socket.serializeAttachment(part);
  }

  mark(socket: WebSocket, part: Part): void {
    socket.serializeAttachment(part);
  }

  /** To an open socket only: one closing has its close event to come, which ends its pair (`gone`). An object takes
   *  one event at a time, so its state holds from this check to the send. */
  send(socket: WebSocket, message: string | ArrayBuffer): void {
    if (socket.readyState === WebSocket.READY_STATE_OPEN) socket.send(message);
  }

  close(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.READY_STATE_OPEN || socket.readyState === WebSocket.READY_STATE_CONNECTING) socket.close(code, reason);
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
    else opened(this.sockets, server, { link, port, resume: url.searchParams.has('resume') });

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
