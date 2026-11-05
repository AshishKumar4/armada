import { accepted, controlled, opened, type Part, type Sockets } from '../src/pairing';

/** What a hub's socket is in the harness: a control socket, or one end of a link. */
export interface Opened {
  readonly kind: string;
  readonly link: string;
  readonly port: number;
  readonly resume: boolean;
  readonly accept: boolean;
}

/** What the harness's hub asks of a socket Bun serves: its data, to send, to close, and to drop without a Close. */
export interface Served {
  readonly data: Opened;
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** The hub's sockets as Bun holds them: each one's part and tags beside it, as a hub's attachments keep them. */
export class BunSockets implements Sockets<Served> {
  private readonly held = new Map<Served, { part: Part; readonly tags: readonly string[]; closed: boolean }>();

  tagged(tag: string): Served[] {
    return [...this.held].filter(([, held]) => !held.closed && held.tags.includes(tag)).map(([socket]) => socket);
  }

  part(socket: Served): Part {
    const held = this.held.get(socket);

    if (held === undefined) throw new Error('a socket the hub never took');

    return held.part;
  }

  take(socket: Served, part: Part, tags: readonly string[]): void {
    this.held.set(socket, { part, tags, closed: false });
  }

  mark(socket: Served, part: Part): void {
    const held = this.held.get(socket);

    if (held !== undefined) held.part = part;
  }

  send(socket: Served, message: string | ArrayBuffer): void {
    socket.send(message);
  }

  close(socket: Served, code: number, reason: string): void {
    this.gone(socket);
    socket.close(code, reason);
  }

  gone(socket: Served): void {
    const held = this.held.get(socket);

    if (held !== undefined) held.closed = true;
  }
}

/** What a relay's upgrade request says of its socket: `/hub/<job>/<index>/<attempt>/<rank>/<kind>?<query>`. */
export function opening(request: Request): Opened {
  const url = new URL(request.url);

  return {
    kind: url.pathname.split('/')[6] ?? '',
    link: url.searchParams.get('id') ?? '',
    port: Number(url.searchParams.get('port')),
    resume: url.searchParams.has('resume'),
    accept: url.searchParams.has('accept'),
  };
}

/** A relay's socket that has just opened, taken by the hub as `ArmadaHub` takes it. */
export function admit(hub: BunSockets, socket: Served): void {
  if (socket.data.kind === 'control') controlled(hub, socket);
  else if (socket.data.accept) accepted(hub, socket, socket.data.link);
  else opened(hub, socket, socket.data);
}
