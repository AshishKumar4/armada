/**
 * The wrangler config `armada deploy` deploys a deployment with: the Worker's template, worker/wrangler.jsonc, with
 * the deployment's own name, account, paths, bucket and vars set as its fields, so any valid formatting of the
 * template deploys the same, and no value is spliced into its text.
 */
import * as v from 'valibot';

/** The template's fields a deployment sets; every other field is the template's own. */
const TemplateSchema = v.looseObject({
  assets: v.looseObject({ directory: v.string() }),
  vars: v.looseObject({ ARMADA_SHA: v.string(), ARMADA_CONTRACT: v.string() }),
  r2_buckets: v.array(v.looseObject({ binding: v.string(), bucket_name: v.string() })),
});

/** What a deployment sets in the template, its fleet's cap among them (`fleetCap`): the template holds none. */
export interface Deployment {
  readonly name: string;
  readonly account: string;
  readonly main: string;
  readonly dashboard: string;
  readonly bucket: string;
  readonly vcpus: number;
  /** The fleet's memory cap in MiB (FLEET_MEMORY_MIB): absent where the deploy could not read the account. */
  readonly memoryMib?: number | undefined;
  readonly sha: string;
  /** The interface its Durable Objects call each other by (`contractOf`). */
  readonly contract: string;
  /** The CPUs it prepares environments on (`cpusOf`'s form); absent for whatever host each is given. */
  readonly prepareCpu?: string | undefined;
}

/** `template`, a wrangler.jsonc, as `deployment`'s config, JSON. Its `$schema` is a path relative to the template, so
 *  it is left out. */
export function deploymentConfig(template: string, { name, account, main, dashboard, bucket, vcpus, memoryMib, sha, contract, prepareCpu }: Deployment): string {
  const { $schema: _schema, ...parsed } = v.parse(v.looseObject({ ...TemplateSchema.entries, $schema: v.optional(v.string()) }), Bun.JSONC.parse(template));

  // Its name and account also name its own container apps among the account's (`readAccount`); FLEET_MEMORY_MIB the
  // fleet's memory, where the deploy read the account's.
  const vars = new Map(Object.entries({ ...parsed.vars, FLEET_VCPUS: String(vcpus), ARMADA_SHA: sha, ARMADA_CONTRACT: contract, ARMADA_NAME: name, ARMADA_ACCOUNT: account }));

  if (prepareCpu !== undefined) vars.set('PREPARE_CPU', prepareCpu);

  if (memoryMib !== undefined) vars.set('FLEET_MEMORY_MIB', String(memoryMib));

  return JSON.stringify({
    ...parsed, name, account_id: account, main,
    assets: { ...parsed.assets, directory: dashboard },
    vars: Object.fromEntries(vars),
    r2_buckets: parsed.r2_buckets.map((each) => each.binding === 'ARTIFACTS' ? { ...each, bucket_name: bucket } : each),
  }, null, 2);
}

/** The fleet cap (FLEET_VCPUS) a deploy of `name` gives it: the one asked (`--vcpus`), else the one its deployed
 *  Worker states (`deployed`, its /fleet's), so a redeploy keeps a deployment's cap; a first deploy that names none is
 *  refused, as no default may size what a fleet spends and holds (2026-11-07 to 11-13: five redeploys of
 *  armada-dew8 without --vcpus each set the template's 1500, halving its owner's 2900). */
export function fleetCap(name: string, asked: number | undefined, deployed: number | null): number {
  if (asked !== undefined) return asked;

  if (deployed !== null) return deployed;

  throw new Error(`${name} states no fleet cap of its own (a first deploy, or a Worker that did not answer its /fleet): name it, --vcpus=N`);
}
