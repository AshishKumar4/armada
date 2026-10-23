/**
 * How a rank's hub pairs its sockets (`ArmadaHub`, hub.ts): over whatever holds them, the Durable Object's
 * hibernatable WebSockets or a test's, with no state but each socket's part and tags.
 */

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

/** A relay's open of `link` to this rank's `port`, a resume or not: an earlier open of it, and its pair, give way,
 *  and the control socket, if there is one now, is told. */
export function opened<S>(sockets: Sockets<S>, socket: S, { link, port, resume }: { readonly link: string; readonly port: number; readonly resume: boolean }): void {
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
