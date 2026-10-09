import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { PROTOCOL } from '../../src/protocol';
import { KEEP_MASK, MASK } from '../src/container';
import type { Generation } from '../src/environments';
import { ArmadaJob } from '../src/job';
import { ArmadaSecrets } from '../src/secrets';
import worker from '../src/worker';
import { namespace, state, world } from './harness';

const TOKEN = 't'.repeat(32);

const VALUE = 'sk-the-value-of-the-key';

const generation: Generation = { key: 'k'.repeat(64), snapshot: { id: 'snapshot', size: 1 }, sha: null, created: 0, seconds: {} };

/** A deployment with one job object, whose storage is read back whole, and a request to it. */
function deployment() {
  const kept = state();
  const secrets = new ArmadaSecrets(state().ctx, world({}));

  const env = world({
    ARMADA_TOKEN: TOKEN, SECRETS: namespace(() => secrets), JOB: namespace(() => job),
    VESSEL: namespace(() => ({ begin: async () => undefined, stop: async () => undefined })),
    ENVIRONMENTS: namespace(() => ({ used: async () => undefined, ensure: async () => ({ kind: 'ready', generation }) })),
  });

  const job = new ArmadaJob(kept.ctx, env);

  const ask = async (path: string, method: string, body?: string) => {
    const answer = await worker.fetch(new Request(`https://armada.test${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}`, 'armada-protocol': String(PROTOCOL) } }), env);

    return [answer.status, answer.headers.get('content-type')?.includes('json') === true ? await answer.json() : await answer.text()];
  };

  return { ask, job, kept };
}

describe('a secret', () => {
  test('is set and deleted by name, listed by name, and no route answers its value', async () => {
    const { ask } = deployment();

    expect({
      set: await ask('/secrets/API_KEY', 'PUT', VALUE), lower: (await ask('/secrets/api_key', 'PUT', VALUE))[0], empty: (await ask('/secrets/EMPTY', 'PUT', ''))[0],
      listed: await ask('/secrets', 'GET'), read: (await ask('/secrets/API_KEY', 'GET'))[0],
      deleted: await ask('/secrets/API_KEY', 'DELETE'), again: await ask('/secrets/API_KEY', 'DELETE'), after: await ask('/secrets', 'GET'),
    }).toEqual({
      set: [200, { stored: 'API_KEY' }], lower: 400, empty: 400, listed: [200, { names: ['API_KEY'] }], read: 404,
      deleted: [200, { deleted: true }], again: [200, { deleted: false }], after: [200, { names: [] }],
    });
  });

  test('a job naming one is refused until it is set; each claim then carries its value, and nothing the job keeps does', async () => {
    const { ask, job, kept } = deployment();
    const spec = JSON.stringify({ recipe: {}, items: [{ item: 'a', argv: ['true'] }], run: { kind: 'command' }, secrets: ['API_KEY'] });
    const refused = await ask('/jobs', 'POST', spec);

    await ask('/secrets/API_KEY', 'PUT', VALUE);
    const [status, created] = await ask('/jobs', 'POST', spec);

    await job.alarm();
    const claim = await job.claim('v1');
    const shown = JSON.stringify(await ask(`/jobs/${v.parse(v.object({ id: v.string() }), created).id}`, 'GET'));

    expect({ refused, status, value: claim !== null && !('waitMs' in claim) ? [claim.env['API_KEY'], claim.secrets] : claim, stored: kept.dump().includes(VALUE), shown: shown.includes(VALUE) }).toEqual({
      refused: [409, { error: 'no secret API_KEY is set; run armada secret set API_KEY' }], status: 200, value: [VALUE, ['API_KEY']], stored: false, shown: false,
    });
  });
});

describe('the mask', () => {
  test('replaces each value the task started with, across a read\'s boundary and longest first, and leaves a value too short to mask', () => {
    const dir = mkdtempSync(join(tmpdir(), 'armada-mask-'));
    const [log, kept] = [join(dir, 'log'), join(dir, 'mask.json')];

    try {
      const keep = spawnSync('node', ['-e', KEEP_MASK, kept], { env: { PATH: process.env['PATH'], ARMADA_MASK: 'API_KEY LONG SHORT', API_KEY: VALUE, LONG: `${VALUE}-long`, SHORT: 'abc' }, encoding: 'utf8' });
      const mode = statSync(kept).mode & 0o777;

      // The first value straddles the 1 MiB read.
      writeFileSync(log, `${'x'.repeat((1 << 20) - 5)}${VALUE} and ${VALUE}-long then abc\n`);
      const ran = spawnSync('node', ['-e', MASK, log, kept], { env: { PATH: process.env['PATH'] }, encoding: 'utf8' });

      expect({ keep: keep.status, mode: mode.toString(8), exit: ran.status, stderr: ran.stderr, after: readFileSync(log, 'utf8'), kept: existsSync(kept) })
        .toEqual({ keep: 0, mode: '600', exit: 0, stderr: '', after: `${'x'.repeat((1 << 20) - 5)}*** and *** then abc\n`, kept: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
