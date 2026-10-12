/**
 * The wrangler config `armada deploy` deploys a deployment with: the Worker's template, worker/wrangler.jsonc, with
 * the deployment's own name, account, paths, bucket and vars set as its fields, so any valid formatting of the
 * template deploys the same, and no value is spliced into its text.
 */
import * as v from 'valibot';

/** The template's fields a deployment sets; every other field is the template's own. */
const TemplateSchema = v.looseObject({
  assets: v.looseObject({ directory: v.string() }),
  vars: v.looseObject({ FLEET_VCPUS: v.string(), ARMADA_SHA: v.string(), ARMADA_CONTRACT: v.string() }),
  r2_buckets: v.array(v.looseObject({ binding: v.string(), bucket_name: v.string() })),
});

/** What a deployment sets in the template: `vcpus` absent keeps the template's fleet cap. */
export interface Deployment {
  readonly name: string;
  readonly account: string;
  readonly main: string;
  readonly dashboard: string;
  readonly bucket: string;
  readonly vcpus?: number | undefined;
  readonly sha: string;
  /** The interface its Durable Objects call each other by (`contractOf`). */
  readonly contract: string;
}

/** `template`, a wrangler.jsonc, as `deployment`'s config, JSON. Its `$schema` is a path relative to the template, so
 *  it is left out. */
export function deploymentConfig(template: string, { name, account, main, dashboard, bucket, vcpus, sha, contract }: Deployment): string {
  const { $schema: _schema, ...parsed } = v.parse(v.looseObject({ ...TemplateSchema.entries, $schema: v.optional(v.string()) }), Bun.JSONC.parse(template));

  return JSON.stringify({
    ...parsed, name, account_id: account, main,
    assets: { ...parsed.assets, directory: dashboard },
    vars: { ...parsed.vars, FLEET_VCPUS: vcpus === undefined ? parsed.vars.FLEET_VCPUS : String(vcpus), ARMADA_SHA: sha, ARMADA_CONTRACT: contract },
    r2_buckets: parsed.r2_buckets.map((each) => each.binding === 'ARTIFACTS' ? { ...each, bucket_name: bucket } : each),
  }, null, 2);
}
