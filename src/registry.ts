/**
 * Deleting a container snapshot. The Containers API has no delete; a snapshot is a tag in a repository of the
 * account's registry, and a set tag beside it. The CLI (`armada prune`) and the Worker (`armada deploy --keep`) both
 * delete through the registry, the Worker with credentials the deploy minted.
 */
import * as v from 'valibot';
import type { Health } from './protocol';

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Manifest = v.object({ annotations: v.optional(v.record(v.string(), v.string()), {}) });

const Catalog = v.object({ repositories: v.record(v.string(), v.nullable(v.array(v.string()))) });

const ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

/** WebCrypto, which both Bun and the Workers runtime have. */
const sha256 = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** `user:password` for the account's registry, valid `minutes`, minted with `token`: an API token that may edit
 *  Containers, or wrangler's own login. */
export async function registryCredentials(account: string, token: string, minutes = 5): Promise<string> {
  const minted = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiration_minutes: minutes, permissions: ['pull', 'push'] }),
  });
  const answer = v.parse(Minted, await minted.json());

  if (!answer.success || answer.result == null) throw new Error(`minting registry credentials answered ${String(minted.status)}: ${answer.errors.map((error) => error.message).join('; ')}`);

  return `${answer.result.username}:${answer.result.password}`;
}

/** Deletes the snapshot `id`'s tags with the registry `credentials` (`user:password`). */
export async function deleteSnapshotWith(credentials: string, id: string): Promise<'deleted' | 'absent'> {
  const authorization = `Basic ${btoa(credentials)}`;
  const snapshot = `rootfs-snapshot-${await sha256(id)}`;
  const catalog = v.parse(Catalog, await (await fetch('https://registry.cloudflare.com/v2/_catalog?tags=true', { headers: { authorization } })).json());
  const repository = Object.entries(catalog.repositories).find(([, tags]) => tags?.includes(snapshot) === true)?.[0];

  if (repository === undefined) return 'absent';
  const manifest = (tag: string) => `https://registry.cloudflare.com/v2/${repository}/manifests/${tag}`;
  const read = await fetch(manifest(snapshot), { headers: { authorization, accept: ACCEPT } });

  if (read.status === 404) return 'absent';

  if (!read.ok) throw new Error(`reading ${snapshot} answered ${String(read.status)}: ${await read.text()}`);
  const set = v.parse(Manifest, await read.json()).annotations['io.cloudflare.cloudchamber.snapshot_set_id'];

  for (const tag of set === undefined ? [snapshot] : [snapshot, `rootfs-set-${await sha256(set)}`]) {
    const deleted = await fetch(manifest(tag), { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

    if (!deleted.ok && deleted.status !== 404) throw new Error(`deleting ${tag} answered ${String(deleted.status)}: ${await deleted.text()}`);
  }

  return 'deleted';
}

/** How long before the credentials a `--keep` deploy gave a Worker expire a later deploy warns of it. */
const KEEP_WARN_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/** The warning a deploy prints when the credentials an earlier `--keep` deploy gave the Worker run out within
 *  KEEP_WARN_DAYS, after which its pruning fails into its log alone; null otherwise. */
export function expiryWarning(name: string, health: Health | null, now = Date.now()): string | null {
  const until = health?.keepUntil === undefined ? NaN : Date.parse(health.keepUntil);

  if (!(until - now < KEEP_WARN_DAYS * DAY_MS)) return null;

  return `${name}'s registry credentials ${until < now ? 'expired' : 'expire'} at ${new Date(until).toISOString()}, and its environments are no longer pruned after that: deploy with --keep=N to renew them`;
}
