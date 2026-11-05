import { describe, expect, spyOn, test } from 'bun:test';
import { gangToken } from '../src/env';
import { ArmadaHub } from '../src/hub';
import { accepted, controlled, gone, opened, passed, type Part, type Sockets } from '../src/pairing';
import { RELAY_HEADER } from '../src/relay';
import { state, world } from './harness';
import { closure, deliver, heard, hubContext, Pair, platform, sever } from './hibernation';

/** A socket as the hub's pairing sees it: what was sent to it, and how it was closed. */
class Fake {
  readonly sent: (string | ArrayBuffer)[] = [];
  closed: readonly [number, string] | undefined;

  constructor(readonly name: string) {}
}

/** The hub's sockets in memory, as its Durable Object keeps them in hibernation: a part and tags each, and no other
 *  state, so a new view over the same sockets is the hub after it woke. */
class Registry implements Sockets<Fake> {
  readonly parts = new Map<Fake, Part>();

  readonly tags = new Map<Fake, readonly string[]>();

  tagged(tag: string): Fake[] {
    return [...this.tags].filter(([socket, tags]) => socket.closed === undefined && tags.includes(tag)).map(([socket]) => socket);
  }

  part(socket: Fake): Part {
    const part = this.parts.get(socket);

    if (part === undefined) throw new Error(`${socket.name} was never taken`);

    return part;
  }

  take(socket: Fake, part: Part, tags: readonly string[]): void {
    this.parts.set(socket, part);
    this.tags.set(socket, tags);
  }

  mark(socket: Fake, part: Part): void {
    this.parts.set(socket, part);
  }

  send(socket: Fake, message: string | ArrayBuffer): void {
    socket.sent.push(message);
  }

  close(socket: Fake, code: number, reason: string): void {
    socket.closed ??= [code, reason];
  }

  /** The hub after hibernation: the same sockets, their parts and tags as their attachments kept them. */
  woken(): Registry {
    const again = new Registry();

    for (const [socket, part] of this.parts) again.take(socket, structuredClone(part), this.tags.get(socket) ?? []);

    return again;
  }
}

const LINK = '0123456789abcdef';

describe('a rank\'s hub', () => {
  test('keeps an open waiting for the rank\'s relay, tells its control socket, and tells the next one after it goes', () => {
    const hub = new Registry();
    const [out, control, again] = [new Fake('out'), new Fake('control'), new Fake('control again')];

    opened(hub, out, { link: LINK, port: 9000, resume: false });
    controlled(hub, control);
    hub.close(control, 1006, 'the network dropped it');
    gone(hub, control);
    controlled(hub, again);

    // A control socket gone is no rank gone: the open is not closed, nor told the link is held nowhere ('g').
    expect({ control: control.sent, again: again.sent, out: out.sent, closed: out.closed })
      .toEqual({ control: [`o ${LINK} 9000 0`], again: [`o ${LINK} 9000 0`], out: [], closed: undefined });
  });

  test('pairs the rank\'s end with the open, tells both, and passes each message to the other, after hibernation too', () => {
    const hub = new Registry();
    const [out, control, end] = [new Fake('out'), new Fake('control'), new Fake('in')];

    controlled(hub, control);
    opened(hub, out, { link: LINK, port: 9000, resume: true });
    accepted(hub, end, LINK);
    const woken = hub.woken();

    passed(woken, out, 'a0');
    passed(woken, end, new Uint8Array([1, 2]).buffer);

    expect({ control: control.sent, out: out.sent, end: end.sent })
      .toEqual({ control: [`o ${LINK} 9000 1`], out: ['r', new Uint8Array([1, 2]).buffer], end: ['r', 'a0'] });
  });

  test('closes an end with no open waiting, and a message before its pair', () => {
    const hub = new Registry();
    const [end, out] = [new Fake('in'), new Fake('out')];

    accepted(hub, end, LINK);
    opened(hub, out, { link: LINK, port: 9000, resume: false });
    passed(hub, out, 'a0');

    expect([end.closed, out.closed]).toEqual([[4404, 'no open of this link waits'], [4409, 'a message before its pair']]);
  });

  test('gives a link\'s newer open the link, the earlier pair closed and its closes reaching none of the newer one', () => {
    const hub = new Registry();
    const [first, firstEnd, second, secondEnd] = [new Fake('out 1'), new Fake('in 1'), new Fake('out 2'), new Fake('in 2')];

    opened(hub, first, { link: LINK, port: 9000, resume: false });
    accepted(hub, firstEnd, LINK);
    opened(hub, second, { link: LINK, port: 9000, resume: true });
    gone(hub, first);
    gone(hub, firstEnd);
    accepted(hub, secondEnd, LINK);
    passed(hub, second, 'e3');

    expect({ first: first.closed, firstEnd: firstEnd.closed, second: [second.closed, second.sent], secondEnd: [secondEnd.closed, secondEnd.sent] }).toEqual({
      first: [1000, 'a newer open of its link'], firstEnd: [1000, 'a newer open of its link'], second: [undefined, ['r']], secondEnd: [undefined, ['r', 'e3']],
    });
  });

  test('closes the other end of a pair when one goes, so each takes the next its relay makes', () => {
    const hub = new Registry();
    const [out, end] = [new Fake('out'), new Fake('in')];

    opened(hub, out, { link: LINK, port: 9000, resume: false });
    accepted(hub, end, LINK);
    hub.close(out, 1006, 'gone');
    gone(hub, out);

    expect(end.closed).toEqual([1000, 'the other end of its pair went']);
  });

  test('takes only a WebSocket that presents its gang attempt\'s token, to a port under a link id', async () => {
    const env = world({ ARMADA_TOKEN: 't'.repeat(32) });
    const hub = new ArmadaHub(state().ctx, env);
    const token = await gangToken(env.ARMADA_TOKEN, 'job', 3, 1);

    const ask = async (presented: string, path: string) => (await hub.fetch(new Request(`https://armada.example/hub/job/3/1/0/${path}`,
      { headers: { [RELAY_HEADER]: presented, upgrade: 'websocket' } }))).status;

    const other = await gangToken(env.ARMADA_TOKEN, 'job', 3, 2);

    expect([await ask(other, 'control'), await ask(token, `link?id=${LINK}&port=0`), await ask(token, 'link?id=x&port=9000'), await ask(token, 'other')])
      .toEqual([403, 400, 400, 400]);
  });

  test('puts a request on the log as it reaches the hub, before anything is awaited, and a refusal with its status', async () => {
    const logged: unknown[] = [];
    const log = spyOn(console, 'log').mockImplementation((line: string) => { logged.push(JSON.parse(line)); });
    const error = spyOn(console, 'error').mockImplementation((line: string) => { logged.push(JSON.parse(line)); });
    const hub = new ArmadaHub(state().ctx, world({ ARMADA_TOKEN: 't'.repeat(32) }));

    try {
      const answer = hub.fetch(new Request(`https://armada.example/hub/job/3/1/0/link?id=${LINK}&port=9000&from=1&n=2`,
        { headers: { [RELAY_HEADER]: 'a-wrong-token', upgrade: 'websocket' } }));

      const reached = [...logged];

      expect({ reached, status: (await answer).status, logged }).toEqual({
        reached: [{ hub: 'job/3/1/0', open: 'link', id: LINK, port: '9000', from: '1', n: '2', phase: 'reached' }],
        status: 403,
        logged: [{ hub: 'job/3/1/0', open: 'link', id: LINK, port: '9000', from: '1', n: '2', phase: 'reached' },
          { hub: 'job/3/1/0', open: 'link', id: LINK, port: '9000', from: '1', n: '2', phase: 'refused', status: 403, error: 'forbidden' }],
      });
      // What the relay presents is never logged.
      expect(JSON.stringify(logged)).not.toContain('a-wrong-token');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

/** The hub as its Durable Object runs it: `ask` is a relay's upgrade, answered with the hub's end of its WebSocket,
 *  which the platform's registry lists closing, after `close`, until its close event (`settle`). */
async function listing() {
  const unplatform = platform();
  const env = world({ ARMADA_TOKEN: 't'.repeat(32) });
  const touched: string[] = [];
  const hub = new ArmadaHub(hubContext(touched), env);
  const token = await gangToken(env.ARMADA_TOKEN, 'job', 3, 1);

  return {
    hub, touched, unplatform,
    ask: async (path: string) => {
      const before = Pair.made.length;

      const answer = await hub.fetch(new Request(`https://armada.example/hub/job/3/1/0/${path}`, { headers: { [RELAY_HEADER]: token, upgrade: 'websocket' } }));

      return { status: answer.status, socket: Pair.made.slice(before)[0]?.[1] };
    },
  };
}

describe('a rank\'s hub over the platform\'s sockets, which list one closing until its close event', () => {
  test('pairs the rank\'s end with the open that replaced an earlier one, which is closing, not with that one', async () => {
    const { ask, touched, unplatform } = await listing();

    try {
      const control = await ask('control');
      const first = await ask(`link?id=${LINK}&port=9000`);
      const second = await ask(`link?id=${LINK}&port=9000&resume=1`);
      const end = await ask(`link?id=${LINK}&accept=1`);

      // The replaced open is closed and told nothing; its replacement is the one paired, and each end told so.
      expect({ control: heard(control.socket), first: [heard(first.socket), closure(first.socket)], second: heard(second.socket), end: heard(end.socket), storage: touched })
        .toEqual({
          control: [`o ${LINK} 9000 0`, `o ${LINK} 9000 1`], first: [[], [1000, 'a newer open of its link']], second: ['r'], end: ['r'], storage: [],
        });
    } finally {
      unplatform();
    }
  });

  test('closes an end whose pair is closing when it sends, as the pair\'s own close does, not as a message before its pair', async () => {
    const { ask, hub, unplatform } = await listing();

    try {
      const out = await ask(`link?id=${LINK}&port=9000`);
      const end = await ask(`link?id=${LINK}&accept=1`);

      sever(out.socket, 1006, 'the network dropped it');
      await deliver(hub, end.socket, 'a0');

      expect({ end: closure(end.socket), told: heard(end.socket) }).toEqual({ end: [1000, 'the other end of its pair went'], told: ['r'] });
    } finally {
      unplatform();
    }
  });
});
