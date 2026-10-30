/**
 * What the rest of a Cloudflare account runs, read from its Containers API under a read-only token: the account's
 * vCPUs, and the most the other apps' containers hold now. A deployment's fleet lends its jobs what the account leaves
 * idle past its own cap (`ArmadaFleet`), and `armada deploy` reads it once to check the token it is given.
 */
import * as v from 'valibot';

const API = 'https://api.cloudflare.com/client/v4';

/** How long one read of the API may take. */
const ASKED_MS = 10_000;

const MeSchema = v.object({ result: v.object({ limits: v.object({
  total_vcpu: v.number(), vcpu_per_deployment: v.number(), total_memory_mib: v.number(), memory_mib_per_deployment: v.number(),
}) }) });

const AppsSchema = v.object({
  result: v.array(v.object({ name: v.string(), health: v.object({ instances: v.object({ active: v.number(), starting: v.number() }) }) })),
});

/** The account's vCPUs and memory (MiB), and those the other apps' containers hold now. */
export interface Account {
  readonly vcpus: number;
  readonly others: number;
  readonly memory: number;
  readonly othersMemory: number;
}

/** Who reads it: the token, the account, and the deployment whose own apps it leaves out. */
export interface Reader {
  readonly token: string;
  readonly account: string;
  readonly name: string;
}

/** The account as the API says now. Each other app's running and starting containers count at the most vCPUs and
 *  memory one container may have: the apps list says how many each runs, not their sizes, and each app's instances would cost a
 *  request a page. The deployment's own apps are its fleet's, which counts them itself. */
export async function readAccount({ token, account, name }: Reader): Promise<Account> {
  const read = async <S extends v.GenericSchema>(path: string, schema: S): Promise<v.InferOutput<S>> => {
    const answer = await fetch(`${API}/accounts/${account}/containers${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ASKED_MS) });

    if (!answer.ok) throw new Error(`the Containers API answered ${path} with ${String(answer.status)}`);

    return v.parse(schema, await answer.json());
  };

  const [me, apps] = await Promise.all([read('/me', MeSchema), read('/applications', AppsSchema)]);
  const own = new Set([`${name}-armadavessel`, `${name}-armadapreparer`]);
  const containers = apps.result.filter((app) => !own.has(app.name)).reduce((sum, app) => sum + app.health.instances.active + app.health.instances.starting, 0);

  const { limits } = me.result;

  return {
    vcpus: limits.total_vcpu, others: containers * limits.vcpu_per_deployment, memory: limits.total_memory_mib, othersMemory: containers * limits.memory_mib_per_deployment,
  };
}
