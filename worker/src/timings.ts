/**
 * ArmadaTimings: what a project's graded runs measured, to weigh its next plan. A graded run reports each green row's
 * seconds and each file's; a red or hung row reports nothing, so a hang never becomes an estimate. It also reports the
 * most one task used, and the next run reads the most of the last runs, to pick its size.
 */
import { DurableObject } from 'cloudflare:workers';
import { medians, recordSamples, type Timings } from '../../src/protocol';
import type { Env } from './env';

interface History {
  readonly rows: Record<string, number[]>;
  readonly files: Record<string, number[]>;
  /** `memory` and `cores`, one sample per run. */
  readonly usage?: Record<string, number[]>;
}

export class ArmadaTimings extends DurableObject<Env> {
  async record(timings: Timings): Promise<void> {
    const history = await this.ctx.storage.get<History>('history');
    const usage = history?.usage ?? {};

    await this.ctx.storage.put('history', {
      rows: recordSamples(history?.rows ?? {}, timings.rows),
      files: recordSamples(history?.files ?? {}, timings.files),
      usage: timings.usage === undefined || timings.usage === null ? usage : recordSamples(usage, timings.usage),
    } satisfies History);
  }

  async estimates(): Promise<Timings> {
    const history = await this.ctx.storage.get<History>('history');
    const { memory = [], cores = [] } = history?.usage ?? {};

    return {
      rows: medians(history?.rows ?? {}), files: medians(history?.files ?? {}),
      usage: memory.length === 0 ? null : { memory: Math.max(...memory), cores: Math.max(...cores) },
    };
  }
}
