/**
 * ArmadaTimings: what a project's graded runs measured, to weigh its next plan. A graded run reports each green row's
 * seconds and each file's; a red or hung row reports nothing, so a hang never becomes an estimate.
 */
import { DurableObject } from 'cloudflare:workers';
import { medians, recordSamples, type Timings } from '../../src/protocol';
import type { Env } from './env';

interface History {
  readonly rows: Record<string, number[]>;
  readonly files: Record<string, number[]>;
}

export class ArmadaTimings extends DurableObject<Env> {
  async record(timings: Timings): Promise<void> {
    const history = await this.ctx.storage.get<History>('history');

    await this.ctx.storage.put('history', {
      rows: recordSamples(history?.rows ?? {}, timings.rows),
      files: recordSamples(history?.files ?? {}, timings.files),
    } satisfies History);
  }

  async estimates(): Promise<Timings> {
    const history = await this.ctx.storage.get<History>('history');

    return { rows: medians(history?.rows ?? {}), files: medians(history?.files ?? {}) };
  }
}
