/**
 * Deleting a container snapshot. The Containers API has no delete; a snapshot is a manifest in a repository of the
 * account's registry, named by a snapshot tag and a set tag beside it. The CLI (`armada prune`) and the Worker
 * (`armada deploy --keep`) both delete through the registry, the Worker with credentials the deploy minted.
 *
 * Measured on 2026-10-09: deleting the tags leaves the manifest and its layers in the repository, listed under their
 * digest, and a DELETE of a manifest a tag still names answers 204 and keeps it. So a delete takes the tags, then the
 * manifest by digest. The catalog pages its names 1000 at a time across every repository, tags and digests alike.
 */
import * as v from 'valibot';
import type { Health } from './protocol';

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Manifest = v.pipe(v.string(), v.parseJson(), v.object({ annotations: v.optional(v.record(v.string(), v.string()), {}) }));

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

/** What a delete did. `left` is the manifest's digest once its tags are gone and its own delete failed: delete that next. */
export type Deletion = { readonly kind: 'deleted' | 'absent' } | { readonly kind: 'left'; readonly digest: string; readonly reason: string };

const CATALOG = 'https://registry.cloudflare.com/v2/_catalog?tags=true';

/** A bound on the catalog's pages, past any account's: 100,000 names. */
const CATALOG_PAGES = 100;

/** The repository whose catalog entry lists `name`, a tag or a digest. The registry's link names the next page's cursor
 *  as `last`, without the angle brackets RFC 8288 gives a link. */
async function repositoryOf(authorization: string, name: string): Promise<string | undefined> {
  let cursor: string | undefined;

  for (let page = 0; page < CATALOG_PAGES; page += 1) {
    const listed = await fetch(cursor === undefined ? CATALOG : `${CATALOG}&last=${cursor}`, { headers: { authorization } });
    const catalog = v.parse(Catalog, await listed.json());
    const found = Object.entries(catalog.repositories).find(([, names]) => names?.includes(name) === true)?.[0];
    const next = /[?&]last=([^&;>\s]+)/u.exec(listed.headers.get('link') ?? '')?.[1];

    if (found !== undefined || next === undefined || next === cursor) return found;
    cursor = next;
  }

  throw new Error(`the registry's catalog ran past ${String(CATALOG_PAGES)} pages`);
}

/** Deletes the snapshot `ref` with the registry `credentials` (`user:password`): a snapshot id, or the digest an earlier
 *  delete left. The snapshot tag goes last of the tags, so a failure before it leaves the snapshot findable by its id. */
export async function deleteSnapshotWith(credentials: string, ref: string): Promise<Deletion> {
  const authorization = `Basic ${btoa(credentials)}`;
  const name = ref.startsWith('sha256:') ? ref : `rootfs-snapshot-${await sha256(ref)}`;
  const repository = await repositoryOf(authorization, name);

  if (repository === undefined) return { kind: 'absent' };
  const manifest = (tag: string) => `https://registry.cloudflare.com/v2/${repository}/manifests/${tag}`;

  const remove = async (tag: string): Promise<string | null> => {
    const deleted = await fetch(manifest(tag), { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

    return deleted.ok || deleted.status === 404 ? null : `deleting ${tag} answered ${String(deleted.status)}: ${await deleted.text()}`;
  };

  if (name === ref) {
    const refused = await remove(ref);

    if (refused !== null) throw new Error(refused);

    return { kind: 'deleted' };
  }

  const read = await fetch(manifest(name), { headers: { authorization, accept: ACCEPT } });

  if (read.status === 404) return { kind: 'absent' };

  if (!read.ok) throw new Error(`reading ${name} answered ${String(read.status)}: ${await read.text()}`);
  const body = await read.text();
  const digest = read.headers.get('docker-content-digest') ?? `sha256:${await sha256(body)}`;
  const parsed = v.safeParse(Manifest, body);
  const set = parsed.success ? parsed.output.annotations['io.cloudflare.cloudchamber.snapshot_set_id'] : undefined;

  for (const tag of set === undefined ? [name] : [`rootfs-set-${await sha256(set)}`, name]) {
    const refused = await remove(tag);

    if (refused !== null) throw new Error(refused);
  }

  const refused = await remove(digest);

  return refused === null ? { kind: 'deleted' } : { kind: 'left', digest, reason: refused };
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
