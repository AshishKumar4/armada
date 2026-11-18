import { describe, expect, test } from 'bun:test';
import { DrainBound, drainWithin, openJobs, Unlisted, type Drainable, type ListedJob } from '../src/drain';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivedOf } from '../src/contract';
import { clientRefusal, DRIVER, drainReasons, OLDEST_CLIENT, PROTOCOL, type Health } from '../src/protocol';

const MINUTE = 60_000;

/** A deployed version whose open jobs finish after `finishing` asks of the drain (never, where null), every call kept
 *  in order, on a clock that each sleep advances; `listing` its open jobs' answer. */
function deployment(finishing: number | null, listing: () => Promise<ListedJob[]>) {
  const calls: string[] = [];
  const held: boolean[] = [];
  let asks = 0;
  let clock = 0;

  const deployed: Drainable = {
    drain: async () => {
      calls.push('drain');
      asks += 1;

      return await Promise.resolve(finishing !== null && asks > finishing ? 0 : OPEN.length);
    },
    admit: async () => {
      calls.push('admit');
      await Promise.resolve();
    },
    openJobs: listing,
  };

  const options = {
    held: (holds: boolean) => { held.push(holds); },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      await Promise.resolve();
    },
    // No Worker request outlasts its share of the bound here: each answers at once.
    expiry: async () => { await new Promise<never>(() => undefined); },
    pollMs: MINUTE,
  };

  return { deployed, calls, held, options };
}

const OPEN: ListedJob[] = [
  { id: 'job-b', label: 'nvgpu-lean', phase: 'running', createdAt: -120 * MINUTE },
  { id: 'job-a', label: '', phase: 'preparing', createdAt: -180 * MINUTE },
];

const listed = async () => await Promise.resolve([...OPEN]);

describe('a deploy drains the deployed version for a bound at most', () => {
  test('open jobs that outlast the bound end the drain: the deployed version admits jobs again and the deploy ends naming them', async () => {
    const { deployed, calls, held, options } = deployment(null, listed);
    const said: string[] = [];
    const ended = drainWithin(deployed, { ...options, boundMs: 5 * MINUTE, say: (line) => { said.push(line); } });

    // Every job still open is named, oldest first, with its age at the bound.
    await expect(ended).rejects.toBeInstanceOf(DrainBound);
    await expect(ended).rejects.toThrow(/job-a[^]*185 min[^]*job-b[^]*125 min/u);
    // Refused for the bound and no longer: asked each minute until it, then admitted once; held, then let go.
    expect(calls).toEqual(['drain', 'drain', 'drain', 'drain', 'drain', 'admit']);
    expect(options.now()).toBe(5 * MINUTE);
    expect(held).toEqual([true, false]);
    expect(said).toHaveLength(6);
  });

  test('a Worker that stops answering is let go at the bound: every ask given up on is ended before the admission', async () => {
    let asks = 0;
    const calls: string[] = [];
    const held: boolean[] = [];
    const signals: AbortSignal[] = [];

    const silent: Drainable = {
      drain: async (signal) => {
        asks += 1;
        calls.push('drain');

        if (signal !== undefined) signals.push(signal);

        return asks === 1 ? await Promise.resolve(2) : await new Promise<never>(() => undefined);
      },
      admit: async () => {
        // A retry still pending would renew the drain after this admission.
        calls.push(signals.every((signal) => signal.aborted) ? 'admit, every ask ended' : 'admit, an ask still pending');
        await new Promise<never>(() => undefined);
      },
      openJobs: async () => await new Promise<never>(() => undefined),
    };

    // Every pending request is abandoned once its span passes (a macrotask later), the answered one first.
    const expiry = async () => { await new Promise((settled) => { setTimeout(settled, 0); }); };

    const ended = drainWithin(silent, { boundMs: 5 * MINUTE, held: (holds) => { held.push(holds); }, say: () => undefined, now: () => 0, sleep: async () => { await Promise.resolve(); }, expiry, pollMs: MINUTE });

    await expect(ended).rejects.toBeInstanceOf(DrainBound);
    expect([calls, held]).toEqual([['drain', 'drain', 'admit, every ask ended'], [true, false]]);
  });

  test('an admission refused at the bound still lets the drain go and ends the deploy', async () => {
    const { deployed, held, options } = deployment(null, listed);
    const refusing: Drainable = { ...deployed, admit: async () => { await Promise.reject(new Error('DELETE /drain: connection dropped')); } };

    await expect(drainWithin(refusing, { ...options, boundMs: 2 * MINUTE, say: () => undefined })).rejects.toBeInstanceOf(DrainBound);
    expect(held).toEqual([true, false]);
  });

  test('open jobs that finish within the bound leave the drain held for the deploy, never admitting, listed or not', async () => {
    for (const listing of [listed, async () => await Promise.reject(new Error('GET /jobs is unavailable'))]) {
      const { deployed, calls, held, options } = deployment(2, listing);

      await drainWithin(deployed, { ...options, boundMs: 5 * MINUTE, say: () => undefined });

      expect([calls, held]).toEqual([['drain', 'drain', 'drain'], [true]]);
    }
  });

  test('a Worker too old to drain is neither drained nor admitted', async () => {
    const calls: string[] = [];
    const held: boolean[] = [];

    const old: Drainable = {
      drain: async () => {
        calls.push('drain');

        return await Promise.resolve(null);
      },
      admit: async () => {
        calls.push('admit');
        await Promise.resolve();
      },
      openJobs: async () => await Promise.resolve([]),
    };

    await drainWithin(old, { boundMs: MINUTE, held: (holds) => { held.push(holds); }, say: () => undefined, now: () => 0, sleep: async () => { await Promise.resolve(); }, expiry: async () => { await new Promise<never>(() => undefined); }, pollMs: 1 });

    expect([held, calls]).toEqual([[], ['drain']]);
  });
});

describe('a deploy says why it drains', () => {
  const health = (fields: Partial<Health>): Health => ({ ok: true, driver: DRIVER, protocol: PROTOCOL, oldest: 3, vcpus: 1, jobs: 0, contract: 'this', ...fields });

  test('one reason for each way the deployed Worker differs, none where this one takes over its jobs', () => {
    expect([
      drainReasons(health({}), false, 'this').length,
      drainReasons(health({}), true, 'this').length,
      drainReasons(health({ protocol: PROTOCOL + 1, driver: DRIVER + 1, contract: 'earlier' }), false, 'this').length,
      drainReasons(null, false, 'this').length,
    ]).toEqual([0, 1, 3, 1]);
  });
});

describe('the open jobs are read whole or not at all', () => {
  const page = (ids: readonly string[], done: ReadonlySet<string> = new Set()) =>
    Response.json({ jobs: ids.map((id) => ({ id, label: '', phase: done.has(id) ? 'done' : 'running', createdAt: 0 })) });

  test('every page is read, done jobs left out', async () => {
    const first = Array.from({ length: 100 }, (_, at) => `j${String(at)}`);
    const asked: string[] = [];

    const open = await openJobs(async (path) => {
      asked.push(path);

      return await Promise.resolve(path.includes('before=') ? page(['last'], new Set()) : page(first, new Set(['j0'])));
    });

    expect([open.length, asked]).toEqual([100, ['/jobs?open', '/jobs?limit=100', '/jobs?limit=100&before=j99']]);
  });

  test('the whole open set is read in one ask where the Worker gives it, its pages never', async () => {
    const asked: string[] = [];

    const open = await openJobs(async (path) => {
      asked.push(path);

      return await Promise.resolve(Response.json({ jobs: [{ id: 'old', label: '', phase: 'running', createdAt: 0 }], open: true }));
    });

    expect([open.map((job) => job.id), asked]).toEqual([['old'], ['/jobs?open']]);
  });

  test('a listing that repeats an id, or that no Worker answers, is refused', async () => {
    const repeated = Array.from({ length: 100 }, () => 'same');

    await expect(openJobs(async () => await Promise.resolve(page(repeated)))).rejects.toEqual(new Unlisted('repeated'));
    await expect(openJobs(async () => await Promise.resolve(new Response(null, { status: 404 })))).rejects.toEqual(new Unlisted('unavailable'));
  });
});

// 2026-11-18: the deploy re-keyed a pinned job's environment behind the same types, and every job of the pinned
// client was refused mid-job until it moved.
describe('a deploy whose clients derive differently', () => {
  const health = (fields: Partial<Health>): Health => ({ ok: true, driver: DRIVER, protocol: PROTOCOL, oldest: OLDEST_CLIENT, vcpus: 1, jobs: 0, contract: 'this', ...fields });

  test('is refused while its wire still serves the clients that derive it the earlier way, and goes on once it does not', () => {
    const deployed = health({ derived: 'a'.repeat(64), oldest: OLDEST_CLIENT });

    expect({
      changed: clientRefusal(deployed, 'b'.repeat(64)) !== null,
      same: clientRefusal(deployed, 'a'.repeat(64)),
      raised: clientRefusal(health({ derived: 'a'.repeat(64), oldest: OLDEST_CLIENT - 1 }), 'b'.repeat(64)),
      unsaid: clientRefusal(health({}), 'b'.repeat(64)),
      none: clientRefusal(null, 'b'.repeat(64)),
    }).toEqual({ changed: true, same: null, raised: null, unsaid: null, none: null });
  });

  test('derives a new fingerprint from a shared derivation\'s body, its literals and what it imports, and none from a comment, formatting or the Worker alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'armada-derived-'));

    try {
      const write = (protocol: string, { worker = 'export const x = 1;\n', keys = 'export function keyPart(a: number): number {\n  return a * 2;\n}\n' } = {}) => {
        mkdirSync(join(root, 'src'), { recursive: true });
        mkdirSync(join(root, 'worker', 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'protocol.ts'), protocol);
        writeFileSync(join(root, 'src', 'keys.ts'), keys);
        writeFileSync(join(root, 'src', 'sdk.ts'), "import { keyOf, labelOf, type Shape } from './protocol';\nexport const k = [keyOf, labelOf];\n");
        writeFileSync(join(root, 'worker', 'src', 'worker.ts'), `import {\n  keyOf,\n  labelOf,\n  helper,\n} from '../../src/protocol';\n${worker}`);

        return derivedOf(root);
      };

      const base = [
        "import { keyPart } from './keys';",
        'const SALT = 1;',
        '',
        '/** The key. */',
        'export function keyOf(a: number): string {',
        '  return `${String(keyPart(a) + SALT)}-',
        'tail/*a*/`;',
        '}',
        '',
        "export const labelOf = (name: string): string => name.replace(/[/]x/gu, '//not a comment');",
        '',
        'export function helper(): number {',
        '  return 2;',
        '}',
        '',
      ].join('\n');

      const first = write(base);
      const changed = (text: string) => text !== first;

      expect({
        comment: write(base.replace('const SALT = 1;', '// why\nconst SALT = 1; /* and how */')) === first,
        formatting: write(base.replace('return `${String(keyPart(a) + SALT)}', 'return   `${String(keyPart(a)+SALT)}')) === first,
        worker: write(base, { worker: 'export const x = 2;\n' }) === first,
        // A function the client does not import, though the Worker does: no derivation they share.
        unshared: write(base.replace('return 2;', 'return 3;')) === first,
        body: changed(write(base.replace('keyPart(a) + SALT', 'keyPart(a) - SALT'))),
        reached: changed(write(base.replace('const SALT = 1;', 'const SALT = 2;'))),
        // An unindented line of a template literal, a comment's look within one, a string and a regex: each as written.
        template: changed(write(base.replace('tail/*a*/', 'tail/*b*/'))),
        string: changed(write(base.replace("'//not a comment'", "'//not  a comment'"))),
        regex: changed(write(base.replace('/[/]x/gu', '/[/]y/gu'))),
        imported: changed(write(base, { keys: 'export function keyPart(a: number): number {\n  return a * 3;\n}\n' })),
        // Operators read whole, and a regex after a control statement's condition read as one.
        operator: write(base.replace('keyPart(a) + SALT', 'keyPart(a) + ++SALT')) !== write(base.replace('keyPart(a) + SALT', 'keyPart(a)++ + SALT')),
        conditioned: write(base.replace('  return `${String(', "  if (SALT) /a + b/u.test('x');\n  return `${String("))
          !== write(base.replace('  return `${String(', "  if (SALT) /a+b/u.test('x');\n  return `${String(")),
      }).toEqual({ comment: true, formatting: true, worker: true, unshared: true, body: true, reached: true, template: true, string: true, regex: true, imported: true, operator: true, conditioned: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
