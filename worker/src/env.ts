import type { ArmadaEnvironments, ArmadaPreparer } from './environments';
import type { ArmadaFleet } from './fleet';
import type { ArmadaWebhooks } from './hooks';
import type { ArmadaSecrets } from './secrets';
import type { ArmadaTasks } from './tasks';
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
  readonly TASKS: DurableObjectNamespace<ArmadaTasks>;
  readonly SECRETS: DurableObjectNamespace<ArmadaSecrets>;
  readonly WEBHOOKS: DurableObjectNamespace<ArmadaWebhooks>;
  /** Packs, task outputs and logs, verdicts. */
  readonly ARTIFACTS: R2Bucket;
  /** The bearer the SDK presents (`~/.config/armada/connection.json`). */
  readonly ARMADA_TOKEN: string;
  /** Concurrent vCPUs across every job of this deployment. */
  readonly FLEET_VCPUS: string;
  /** The commit `armada deploy` built this Worker from, written into the deployed vars. */
  readonly ARMADA_SHA?: string;
  /** The deployed version, which a drain names. */
  readonly VERSION: WorkerVersionMetadata;
  /** How many of the most recently used environments keep their snapshots (`armada deploy --keep`); unset keeps all. */
  readonly KEEP_ENVIRONMENTS?: string;
  /** `user:password` for the account's registry, which deletes the snapshots past them. */
  readonly REGISTRY_CREDENTIALS?: string;
  /** When those credentials expire, an ISO date, which `/health` reports so a deploy can warn ahead of it. */
  readonly REGISTRY_CREDENTIALS_EXPIRE?: string;
}

/** The R2 key of a commit's pack: from the root, or what it adds to an environment's commit, under its packer
 *  (`PACKER`), or under the key an earlier client's pack has always had. */
export const packKey = (project: string, sha: string, base: string, packer: number | undefined): string =>
  `packs/${project}/${sha}.${base}${packer === undefined ? '' : `.p${String(packer)}`}.pack`;

/** The R2 key of a pushed bundle, by the digest of its bytes. It is kept while a task id points to it, and for a week
 *  after, for the jobs still running it (`sweepBundles`). */
export const bundleKey = (digest: string): string => `code/${digest}.mjs`;


/** The R2 keys of a task's output, log and artifacts archive: a gang rank's other than 0 under its rank. */
export const taskKey = (job: string, index: number, leaf: 'output' | 'log' | 'artifacts', rank = 0): string =>
  `jobs/${job}/tasks/${String(index)}/${rank === 0 ? '' : `rank${String(rank)}/`}${leaf === 'log' ? 'log.gz' : leaf === 'artifacts' ? 'artifacts.tar.gz' : 'output'}`;

/** An R2 object into `key`: `small` when it was read whole, else streamed at its known size. */
export async function copyInto(bucket: R2Bucket, key: string, source: R2ObjectBody, small: ArrayBuffer | null, customMetadata?: Record<string, string>): Promise<void> {
  if (small !== null) {
    await bucket.put(key, small, { httpMetadata: source.httpMetadata, customMetadata });

    return;
  }
  const known = new FixedLengthStream(source.size);

  await Promise.all([source.body.pipeTo(known.writable), bucket.put(key, known.readable, { httpMetadata: source.httpMetadata, customMetadata })]);
}

/** Bytes as text, or undefined when they are not UTF-8. */
export function textOf(bytes: ArrayBuffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The one instance of a deployment-wide object. */
export const SINGLE = 'all';

/** An error and every cause under it, on one line. */
function chain(error: Error): string {
  if (error.cause instanceof Error) return `${error.message}: ${chain(error.cause)}`;

  return error.cause === undefined ? error.message : `${error.message}: ${JSON.stringify(error.cause)}`;
}

export const said = (cause: unknown): string => cause instanceof Error ? chain(cause) : String(cause);
