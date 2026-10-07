import type { ArmadaEnvironments, ArmadaPreparer } from './environments';
import type { ArmadaFleet } from './fleet';
import type { ArmadaJob } from './job';
import type { ArmadaTimings } from './timings';
import type { ArmadaVessel } from './vessel';

export interface Env {
  readonly JOB: DurableObjectNamespace<ArmadaJob>;
  readonly VESSEL: DurableObjectNamespace<ArmadaVessel>;
  readonly ENVIRONMENTS: DurableObjectNamespace<ArmadaEnvironments>;
  readonly PREPARER: DurableObjectNamespace<ArmadaPreparer>;
  readonly TIMINGS: DurableObjectNamespace<ArmadaTimings>;
  readonly FLEET: DurableObjectNamespace<ArmadaFleet>;
  /** Packs, task outputs and logs, verdicts. */
  readonly ARTIFACTS: R2Bucket;
  /** The bearer the SDK presents (`~/.config/armada/connection.json`). */
  readonly ARMADA_TOKEN: string;
  /** Concurrent vCPUs across every job on the account: Cloudflare's ceiling is 1,500. */
  readonly FLEET_VCPUS: string;
}

/** The R2 key of a commit's pack: from the root, or what it adds to an environment's commit, under its packer
 *  (`PACKER`), or under the key an earlier client's pack has always had. */
export const packKey = (project: string, sha: string, base: string, packer: number | undefined): string =>
  `packs/${project}/${sha}.${base}${packer === undefined ? '' : `.p${String(packer)}`}.pack`;

/** The R2 keys of a task's output and log. */
export const taskKey = (job: string, index: number, leaf: 'output' | 'log'): string => `jobs/${job}/tasks/${String(index)}/${leaf === 'log' ? 'log.gz' : 'output'}`;

/** The one instance of an account-wide object. */
export const SINGLE = 'all';

/** An error and every cause under it, on one line. */
export function chain(error: Error): string {
  if (error.cause instanceof Error) return `${error.message}: ${chain(error.cause)}`;

  return error.cause === undefined ? error.message : `${error.message}: ${JSON.stringify(error.cause)}`;
}

export const said = (cause: unknown): string => cause instanceof Error ? chain(cause) : String(cause);
