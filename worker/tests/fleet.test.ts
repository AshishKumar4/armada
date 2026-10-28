import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { fakeFetch } from '../../tests/fakes';
import { INACTIVITY_MS } from '../src/container';
import { ArmadaFleet, RECALL_GRACE_MS, SAMPLE_MS, WANT_MS, type Grant } from '../src/fleet';
import { ArmadaVessel, type VesselSpec } from '../src/vessel';
import { container, namespace, state, world } from './harness';

const fleetOf = (vcpus: number) => new ArmadaFleet(state().ctx, world({ FLEET_VCPUS: String(vcpus) }));

/** A job's deadline, an hour from now. */
const deadlineAt = Date.now() + 60 * 60_000;

describe('the fleet', () => {
  test('grants a gang\'s ranks only once all of them fit, so two jobs\' gangs never each hold half of a full fleet', async () => {
    const fleet = fleetOf(2);
    // Two jobs, each a gang of two 1-vCPU ranks, ask in turn.
    const granted = [];

    for (const holder of ['a/v1', 'b/v1', 'a/v2', 'b/v2']) granted.push(await fleet.acquire(holder, 1, { reserve: 2, deadlineAt }));

    await fleet.release('a/v1');
    await fleet.release('a/v2');

    expect({ granted, after: [await fleet.acquire('b/v1', 1, { reserve: 2, deadlineAt }), await fleet.acquire('b/v2', 1, { reserve: 2, deadlineAt })] }).toEqual({ granted: ['held', null, 'held', null], after: ['held', 'held'] });
  });

  // #49: on a full fleet, other jobs' single containers took each vCPU freed, and two gangs waited out their deadlines.
  test('grants a waiting holder before newer ones it would no longer fit beside, until it stops asking', async () => {
    const full = async () => {
      const fleet = fleetOf(8);

      for (const holder of ['a/v1', 'a/v2', 'a/v3']) await fleet.acquire(holder, 2, { deadlineAt });

      // A gang of two 2-vCPU ranks needs 4 at once, and 2 are free: it waits, and a newer 2-vCPU holder waits behind it.
      return { fleet, asked: [await fleet.acquire('g/v1', 2, { reserve: 4, deadlineAt }), await fleet.acquire('n/v1', 2, { deadlineAt })] };
    };

    const waited = await full();

    await waited.fleet.release('a/v1');
    const freed = [await waited.fleet.acquire('n/v1', 2, { deadlineAt })];

    for (const rank of ['g/v1', 'g/v2']) freed.push(await waited.fleet.acquire(rank, 2, { reserve: 4, deadlineAt }));
    // The gang's job was cancelled, and its ranks stopped asking.
    const left = await full();
    const after = await left.fleet.acquire('n/v1', 2, { deadlineAt, now: Date.now() + WANT_MS + 1 });

    expect({ asked: waited.asked, freed, after }).toEqual({ asked: [null, null], freed: [null, 'held', 'held'], after: 'held' });
  });

  // #60: a train's suite waited a median of 530 s for containers that developers' suites held between their tasks.
  test('grants a job of higher priority before older waiters, and recalls the newest holds of lower ones until it fits', async () => {
    const fleet = fleetOf(8);
    const at = Date.now();

    for (const holder of ['low/v1', 'low/v2']) await fleet.acquire(holder, 4, { deadlineAt });
    const asked = [await fleet.acquire('older/v1', 4, { deadlineAt, now: at }), await fleet.acquire('train/v1', 4, { deadlineAt, priority: 5, now: at })];
    const renews = [await fleet.renews('low/v1'), await fleet.renews('low/v2')];
    // The recalled one ends the task it runs within a grace from its recall (#63, #66); the other runs on.
    const ends = [await fleet.beat('low/v1'), await fleet.beat('low/v2')];

    // The recalled container finishes its task and ends: the train's is granted, though the older waiter asks first.
    await fleet.release('low/v2');
    const freed = [await fleet.acquire('older/v1', 4, { deadlineAt }), await fleet.acquire('train/v1', 4, { deadlineAt, priority: 5 })];
    // Jobs of one priority recall nothing of each other.
    const level = fleetOf(4);

    await level.acquire('a/v1', 4, { deadlineAt });
    await level.acquire('b/v1', 4, { deadlineAt });
    // A preparation holds its container to its end, newest though it is: a job's container is recalled in its place.
    const preparing = fleetOf(8);

    await preparing.acquire('low/v1', 4, { deadlineAt });
    await preparing.acquire('preparing/k/1', 4, { deadlineAt, recallable: false });
    await preparing.acquire('train/v1', 4, { deadlineAt, priority: 5 });

    expect({ asked, renews, ends, freed, level: await level.renews('a/v1'), preparing: [await preparing.renews('low/v1'), await preparing.renews('preparing/k/1')] })
      .toEqual({ asked: [null, null], renews: [true, false], ends: [null, at + RECALL_GRACE_MS], freed: [null, 'held'], level: true, preparing: [false, true] });
  });

  test('keeps one line across jobs: a job\'s newer holder waits behind another job\'s older one, however old its own', async () => {
    const fleet = fleetOf(4);

    await fleet.acquire('x/v1', 4, { deadlineAt });
    const asked = [await fleet.acquire('a/v1', 2, { deadlineAt }), await fleet.acquire('b/v1', 2, { deadlineAt })];

    await fleet.release('x/v1');
    const freed = [];

    for (const holder of ['a/v2', 'a/v1', 'b/v1']) freed.push(await fleet.acquire(holder, 2, { deadlineAt }));

    expect({ asked, freed }).toEqual({ asked: [null, null], freed: [null, 'held', 'held'] });
  });

  test('keeps a container\'s vCPUs held until it is gone: until a stop that failed has had its container end', async () => {
    const fleet = fleetOf(4);

    await fleet.acquire('a/v1', 4, { deadlineAt });
    await fleet.release('a/v1', 60_000);
    const whileRunning = await fleet.acquire('b/v1', 4, { deadlineAt });
    const later = await fleet.acquire('b/v1', 4, { deadlineAt, now: Date.now() + 61_000 });

    expect({ whileRunning, later }).toEqual({ whileRunning: null, later: 'held' });
  });

  test('frees an ended gang\'s reserve while one container that would not stop still holds its own vCPUs', async () => {
    const fleet = fleetOf(2);

    for (const rank of ['v1', 'v2', 'v3', 'v4']) await fleet.acquire(`a/${rank}`, 0.5, { reserve: 2, deadlineAt });
    await fleet.release('a/v1', INACTIVITY_MS);

    for (const rank of ['v2', 'v3', 'v4']) await fleet.release(`a/${rank}`);
    await fleet.closed('a');

    expect({ used: await fleet.used(), granted: await fleet.acquire('b/v1', 1.5, { deadlineAt }), more: await fleet.acquire('b/v2', 0.5, { deadlineAt }) })
      .toEqual({ used: 0.5, granted: 'held', more: null });
  });

  test('lets a holder\'s vCPUs lapse only after its job\'s deadline and a container\'s idle timeout', async () => {
    const fleet = fleetOf(4);
    const ends = Date.now() + 10 * 60 * 60_000;

    await fleet.acquire('long/v1', 4, { deadlineAt: ends });
    const beforeEnd = await fleet.acquire('b/v1', 4, { deadlineAt, now: ends - 1 });
    const afterLease = await fleet.acquire('b/v1', 4, { deadlineAt, now: ends + INACTIVITY_MS + 1 });

    expect({ beforeEnd, afterLease }).toEqual({ beforeEnd: null, afterLease: 'held' });
  });

  test('keeps the hold of a holder whose job has no deadline while it says it runs, and lets it lapse an idle timeout after', async () => {
    const fleet = fleetOf(4);
    const start = Date.now();
    const said = start + 10 * 60 * 60_000;

    await fleet.acquire('open/v1', 4, { deadlineAt: start, renewed: true, now: start });
    await fleet.beat('open/v1', said);
    const running = await fleet.acquire('b/v1', 4, { deadlineAt, now: said + INACTIVITY_MS - 1 });
    const lapsed = await fleet.acquire('b/v1', 4, { deadlineAt, now: said + INACTIVITY_MS + 1 });

    expect({ running, lapsed }).toEqual({ running: null, lapsed: 'held' });
  });
});

describe('a fleet that lends what the account leaves idle', () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
    setSystemTime();
  });

  /** An account of 100 vCPUs, 4 at most a container, as its Containers API tells the token `token`: this deployment's
   *  own apps, and another's `others.containers`. */
  function account() {
    const others = { containers: 10 };

    globalThis.fetch = fakeFetch((request) => {
      if (request.headers.get('authorization') !== 'Bearer token') return Response.json({ success: false }, { status: 403 });

      if (new URL(request.url).pathname === '/client/v4/accounts/acct/containers/me') return Response.json({ result: { limits: { total_vcpu: 100, vcpu_per_deployment: 4 } } });

      return Response.json({
        result: [
          { name: 'x-armadavessel', health: { instances: { active: 25, starting: 1 } } },
          { name: 'other-armadavessel', health: { instances: { active: others.containers, starting: 0 } } },
        ],
      });
    });

    return others;
  }

  /** A fleet of `cap` vCPUs, deployed as `x` in that account with `token`, keeping what it keeps in `stored`. */
  const lender = (token: string, stored = state(), cap = 8) => new ArmadaFleet(stored.ctx, world({ FLEET_VCPUS: String(cap), ARMADA_NAME: 'x', ARMADA_ACCOUNT: 'acct', ACCOUNT_TOKEN: token }));

  /** Each of `holders` asks in turn for 4 vCPUs it may borrow. */
  const borrowing = async (fleet: ArmadaFleet, holders: readonly string[]) => {
    const grants = [];

    for (const holder of holders) grants.push(await fleet.acquire(holder, 4, { deadlineAt, borrows: true }));

    return grants;
  };

  test('lends past its cap half of what the account leaves idle, recalls its newest loans once others fill it, and lends none past a stale read', async () => {
    const others = account();
    const fleet = lender('token');
    const unread = await borrowing(fleet, ['j/v1', 'j/v2', 'j/v3']);

    // Idle: 90 of 100 vCPUs (10 left for other apps to start in), less the other app's 40 and the 8 held: 42, half lent.
    await fleet.alarm();
    const lent = await borrowing(fleet, ['j/v3', 'j/v4', 'j/v5', 'j/v6', 'j/v7', 'j/v8']);

    others.containers = 20;
    await fleet.alarm();
    const renewed = await Promise.all(['j/v7', 'j/v6', 'j/v5', 'j/v4', 'j/v3'].map(async (holder) => await fleet.renews(holder)));

    setSystemTime(new Date(Date.now() + 5 * SAMPLE_MS));

    expect({ unread, lent, renewed, stale: await fleet.renews('j/v4'), limit: (await fleet.shares()).limit }).toEqual({
      unread: ['held', 'held', null], lent: ['borrowed', 'borrowed', 'borrowed', 'borrowed', 'borrowed', null], renewed: [false, false, false, true, true], stale: false, limit: 8,
    });
  });

  test('lends nothing without a token, with one the account refuses, or once its token is taken away', async () => {
    account();

    const lent = await Promise.all(['', 'a token the account refuses'].map(async (token) => {
      const fleet = lender(token);

      // The third asks past the cap, and has the account read, where a token lets it.
      await borrowing(fleet, ['j/v1', 'j/v2', 'j/v3']);
      await fleet.alarm();

      return await borrowing(fleet, ['j/v3']);
    }));

    // A deploy with an empty token, while the last read is still fresh.
    const stored = state();

    await borrowing(lender('token', stored), ['j/v1', 'j/v2', 'j/v3']);
    await lender('token', stored).alarm();

    expect({ lent, taken: await borrowing(lender('', stored), ['j/v3']) }).toEqual({ lent: [[null], [null]], taken: [null] });
  });

  test('recalls its loans while a holder that may not borrow waits for room under its cap, and lends none meanwhile', async () => {
    account();
    const fleet = lender('token');

    // The third asks past the cap, and has the account read.
    await borrowing(fleet, ['j/v1', 'j/v2', 'j/v3']);
    await fleet.alarm();
    const lent = await borrowing(fleet, ['j/v3', 'j/v4']);

    // A container within the cap ends: the preparation would fit there, but for the loans.
    await fleet.release('j/v2');
    const preparing = await fleet.acquire('preparing/k/1', 4, { deadlineAt });
    const recalled = await Promise.all(['j/v4', 'j/v3'].map(async (holder) => await fleet.renews(holder)));
    const meanwhile = await borrowing(fleet, ['j/v5']);

    for (const holder of ['j/v3', 'j/v4']) await fleet.release(holder);

    expect({ lent, preparing, recalled, meanwhile, after: await fleet.acquire('preparing/k/1', 4, { deadlineAt }) }).toEqual({
      lent: ['borrowed', 'borrowed'], preparing: null, recalled: [false, false], meanwhile: [null], after: 'held',
    });
  });

  test('keeps its loans while a holder that may not borrow waits on holds within its cap, which no recall would free', async () => {
    account();
    const fleet = lender('token');

    await borrowing(fleet, ['j/v1', 'j/v2', 'j/v3']);
    await fleet.alarm();
    const lent = await borrowing(fleet, ['j/v3']);
    const rank = await fleet.acquire('g/v1', 4, { reserve: 8, deadlineAt });

    expect({ lent, rank, renewed: await fleet.renews('j/v3'), more: await borrowing(fleet, ['j/v4']) }).toEqual({ lent: ['borrowed'], rank: null, renewed: true, more: ['borrowed'] });
  });

  test('recalls the loans a gang\'s next rank waits on, its job\'s own among them', async () => {
    account();
    const fleet = lender('token', state(), 12);

    // Job j holds a container for its gang of two and job p another: 12, the cap. Then k and j each borrow one more.
    await fleet.acquire('j/v1', 4, { reserve: 8, deadlineAt });
    await fleet.acquire('p/v1', 4, { deadlineAt });
    await borrowing(fleet, ['k/v1']);
    await fleet.alarm();
    const lent = [...await borrowing(fleet, ['k/v1']), await fleet.acquire('j/v2', 4, { deadlineAt, borrows: true })];
    const rank = await fleet.acquire('j/v3', 4, { reserve: 8, deadlineAt });

    expect({ lent, rank, renewed: [await fleet.renews('j/v2'), await fleet.renews('k/v1')] }).toEqual({ lent: ['borrowed', 'borrowed'], rank: null, renewed: [false, false] });
  });

  test('keeps a holder\'s vCPUs while it asks again beside loans that keep it out', async () => {
    account();
    const fleet = lender('token');

    await borrowing(fleet, ['j/v1', 'p/v1']);
    await borrowing(fleet, ['k/v1']);
    await fleet.alarm();
    const lent = await borrowing(fleet, ['k/v1']);
    const again = await fleet.acquire('p/v1', 4, { deadlineAt });

    expect({ lent, again, recalled: await fleet.renews('k/v1'), used: await fleet.used() }).toEqual({ lent: ['borrowed'], again: null, recalled: false, used: 12 });
  });
});

describe('a vessel stopped while the fleet answers', () => {
  /** A vessel stopped while its fleet grants it 4 vCPUs, which the fleet answers as `answer` says: whether it started,
   *  and whether the fleet has them free again. A fleet still on earlier code answers true. */
  async function stoppedWhileGranted(answer: (grant: Grant | null) => Grant | boolean | null) {
    const fleet = fleetOf(4);
    const answered = Promise.withResolvers<void>();
    let started = false;
    const box = Object.assign(container(() => ({ exitCode: 0, stdout: 'ready\n' })), { start: () => { started = true; } });
    const stored = state(box);

    const env = world({
      FLEET: namespace(() => ({
        acquire: async () => {
          await answered.promise;

          return answer(await fleet.acquire('j/v1', 4, { deadlineAt }));
        },
        release: fleet.release.bind(fleet),
        renews: fleet.renews.bind(fleet),
        beat: fleet.beat.bind(fleet),
      })),
      JOB: namespace(() => ({ moved: async () => true })),
    });

    const vessel = new ArmadaVessel(stored.ctx, env);
    const spec: VesselSpec = { jobId: 'j', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4, workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null, output: false, timeout: 60 };

    await vessel.begin(spec);
    const alarm = vessel.alarm();

    await vessel.stop();
    answered.resolve();
    await alarm;

    return { started, free: await fleet.acquire('other/v1', 4, { deadlineAt }) };
  }

  test('gives back what it was granted and starts nothing, whatever code its fleet runs', async () => {
    expect([await stoppedWhileGranted((grant) => grant), await stoppedWhileGranted((grant) => grant !== null)]).toEqual([{ started: false, free: 'held' }, { started: false, free: 'held' }]);
  });
});


describe('a vessel its job no longer wants', () => {
  test('leaves the fleet\'s line and ends, as one whose stop was lost when its job ended does', async () => {
    const fleet = fleetOf(4);
    let wanted = true;

    await fleet.acquire('x/v1', 4, { deadlineAt });
    const stored = state();
    const vessel = new ArmadaVessel(stored.ctx, world({ FLEET: namespace(() => fleet), JOB: namespace(() => ({ moved: async () => wanted })) }));

    await vessel.begin({ jobId: 'j', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4, workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null, output: false, timeout: 60 });
    // Refused, it waits in line; then its job ends, and the stop it sent is lost.
    await vessel.alarm();
    wanted = false;
    await vessel.alarm();
    await fleet.release('x/v1');

    expect({ newer: await fleet.acquire('n/v1', 4, { deadlineAt }), alarm: await stored.ctx.storage.getAlarm() }).toEqual({ newer: 'held', alarm: null });
  });
});

describe('a vessel of a job of higher priority (#60)', () => {
  test('has the fleet recall a lower job\'s container while it waits, which takes no new task', async () => {
    const fleet = fleetOf(4);

    await fleet.acquire('low/v1', 4, { deadlineAt });
    const stored = state();
    const vessel = new ArmadaVessel(stored.ctx, world({ FLEET: namespace(() => fleet), JOB: namespace(() => ({ moved: async () => true })) }));

    await vessel.begin({ jobId: 'train', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4, workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null, output: false, timeout: 60, priority: 5 });
    await vessel.alarm();

    expect({ low: await fleet.renews('low/v1'), state: await stored.ctx.storage.get('state') }).toEqual({ low: false, state: 'waiting' });
  });

  // #66: Dew's train waited on lower lanes' containers, each until its task of minutes ended, and hit its deadline.
  test('takes a recalled container running a long task within the grace, so the higher job starts then, not at the task\'s end', async () => {
    const fleet = fleetOf(4);
    const preempted: boolean[] = [];
    const recalled = Date.now();
    // The lower job's container, a task launched on it and still running.
    const stored = state(container((argv) => ({ exitCode: 0, stdout: argv[3] === 'wait' ? '' : '' })));
    const low = new ArmadaVessel(stored.ctx, world({ FLEET: namespace(() => fleet), JOB: namespace(() => ({ preempted: async (_name: string, gone: boolean) => { preempted.push(gone); }, still: async () => true })) }));

    await fleet.acquire('low/v1', 4, { deadlineAt });
    await stored.ctx.storage.put({ spec: { jobId: 'low', name: 'v1', snapshot: 's', instance: 'standard-4', vcpus: 4, workdir: '/w', commit: null, tmpfs: [], files: {}, bundle: null, output: false, timeout: null, deadlineAt },
      state: 'working', 'slot:0': { claim: { index: 0, attempt: 1, argv: ['sleep', '900'], secrets: [], duplicate: false }, startedAt: recalled - 60_000 } });

    try {
      setSystemTime(recalled);
      const asked = await fleet.acquire('train/v1', 4, { deadlineAt, priority: 5 });

      // Past its grace: the container ends, and its job hears the fleet took it.
      setSystemTime(recalled + RECALL_GRACE_MS + 1);
      await low.alarm();

      expect({ asked, preempted, state: await stored.ctx.storage.get('state'), train: await fleet.acquire('train/v1', 4, { deadlineAt, priority: 5 }) })
        .toEqual({ asked: null, preempted: [true], state: 'done', train: 'held' });
    } finally {
      setSystemTime();
    }
  });
});
