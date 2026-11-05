import { describe, expect, test } from 'bun:test';
import { gangToken } from '../src/env';
import { ArmadaHub } from '../src/hub';
import { RELAY_HEADER } from '../src/relay';
import { ArmadaVessel } from '../src/vessel';
import worker from '../src/worker';
import { container, namespace, state, world } from './harness';
import { deliver, heard, hubContext, Pair, platform, type Socket } from './hibernation';

const JOB = '20261011120000-0123abcd';

const TOKEN = 't'.repeat(32);

/** Relay opens to a gang's ranks through the Worker's route, one hub per rank, beside a rank's vessel whose lifecycle
 *  storage can be made to answer nothing, as 2026-10-23's did for minutes. The platform's WebSocket pair and its
 *  constants are replaced until `restore`. */
async function gang() {
  const hubs = new Map<string, ArmadaHub>();
  const touched: string[] = [];
  const reachedVessels: string[] = [];
  const held = Promise.withResolvers<void>();
  const unplatform = platform();

  const vesselState = state(container(() => ({ exitCode: 0, stdout: '' })));
  const { storage } = vesselState.ctx;
  const [get, put] = [storage.get.bind(storage), storage.put.bind(storage)];
  let stalled = false;

  Object.assign(vesselState.ctx.storage, {
    get: async (...args: Parameters<typeof get>) => {
      if (stalled) await held.promise;

      return await get(...args);
    },
    put: async (...args: Parameters<typeof put>) => {
      if (stalled) await held.promise;

      return await put(...args);
    },
  });

  const vessel = new ArmadaVessel(vesselState.ctx, world({}));

  const env = world({
    ARMADA_TOKEN: TOKEN,
    HUB: namespace((name: string) => {
      const hub = hubs.get(name) ?? new ArmadaHub(hubContext(touched), env);

      hubs.set(name, hub);

      return hub;
    }),
    VESSEL: namespace((name: string) => {
      reachedVessels.push(name);

      return vessel;
    }),
  });

  const token = await gangToken(TOKEN, JOB, 3, 1);

  return {
    vessel, touched, reachedVessels,
    /** A relay's upgrade to `rank`'s hub (`path` after its name): its status, and the hub's end of its WebSocket. */
    open: async (rank: number, path: string) => {
      const before = Pair.made.length;

      const answer = await worker.fetch(new Request(`https://armada.example/hub/${JOB}/3/1/${String(rank)}/${path}`,
        { headers: { upgrade: 'websocket', [RELAY_HEADER]: token } }), env);

      return { status: answer.status, socket: Pair.made.slice(before)[0]?.[1] };
    },
    /** A relay's message on its socket to `rank`'s hub, delivered as the runtime does. */
    send: async (rank: number, socket: Socket | undefined, message: string | ArrayBuffer) => {
      const hub = hubs.get(`${JOB}/3/1/${String(rank)}`);

      if (hub === undefined) throw new Error('no such hub');
      await deliver(hub, socket, message);
    },
    /** From now, every read and write of the rank's vessel waits for `release`. */
    stall: () => { stalled = true; },
    release: () => { held.resolve(); },
    restore: () => {
      held.resolve();
      unplatform();
    },
  };
}

describe('a relay upgrade under vessel pressure (Dew ledger 1401)', () => {
  test('answers and pairs a new link, and carries an existing link\'s traffic, while the vessel\'s lifecycle storage is stalled', async () => {
    const relays = await gang();

    try {
      const [first, second] = ['b6464de9b6dd1d83', 'b9a39aec101bf946'];
      // Rank 2's relay keeps a control socket at its hub; rank 0 opens a link to its port, which rank 2's relay takes up.
      const control = await relays.open(2, 'control?from=2&n=1');
      const out = await relays.open(2, `link?id=${first}&port=33133&from=0&n=1`);
      const end = await relays.open(2, `link?id=${first}&accept=1&from=2`);

      // The vessel's storage stalls with that link in flight: its next lifecycle call waits for it. A request that
      // awaited it would wait with it, and this test with them.
      relays.stall();
      const lifecycle = { state: 'waiting' };
      const stopping = relays.vessel.stop().then(() => { lifecycle.state = 'answered'; });

      await relays.send(2, out.socket, 'a0');
      await relays.send(2, end.socket, new Uint8Array([7, 8]).buffer);
      const next = await relays.open(2, `link?id=${second}&port=33133&from=0&n=1`);
      const accepted = await relays.open(2, `link?id=${second}&accept=1&from=2`);

      await relays.send(2, next.socket, 'e9');
      const during = lifecycle.state;

      relays.release();
      await stopping;

      expect({
        statuses: [control, out, end, next, accepted].map((each) => each.status),
        told: heard(control.socket), first: [heard(out.socket), heard(end.socket)], second: [heard(next.socket), heard(accepted.socket)],
        during, after: lifecycle.state, vessels: relays.reachedVessels, storage: relays.touched,
      }).toEqual({
        statuses: [101, 101, 101, 101, 101],
        told: [`o ${first} 33133 0`, `o ${second} 33133 0`],
        first: [['r', new Uint8Array([7, 8]).buffer], ['r', 'a0']],
        second: [['r'], ['r', 'e9']],
        during: 'waiting', after: 'answered', vessels: [], storage: [],
      });
    } finally {
      relays.restore();
    }
  });

  test('has no relay route in the vessel: a link is the hub\'s alone', () => {
    expect(Object.getOwnPropertyNames(ArmadaVessel.prototype).filter((name) => /^(?:fetch|webSocket)/u.test(name))).toEqual([]);
  });
});
