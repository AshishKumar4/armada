/**
 * Deleting a container snapshot. The Containers API has no delete; a snapshot is a tag in a repository of the
 * account's registry, and a set tag beside it.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Manifest = v.object({ annotations: v.optional(v.record(v.string(), v.string()), {}) });

const Catalog = v.object({ repositories: v.record(v.string(), v.nullable(v.array(v.string()))) });

const ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function deleteSnapshot(input: { readonly account: string; readonly token: string; readonly id: string }): Promise<'deleted' | 'absent'> {
  const minted = await fetch(`https://api.cloudflare.com/client/v4/accounts/${input.account}/containers/registries/registry.cloudflare.com/credentials`, {
    method: 'POST', headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiration_minutes: 5, permissions: ['pull', 'push'] }),
  });
  const answer = v.parse(Minted, await minted.json());

  if (!answer.success || answer.result == null) throw new Error(`minting registry credentials answered ${String(minted.status)}: ${answer.errors.map((error) => error.message).join('; ')}`);
  const authorization = `Basic ${btoa(`${answer.result.username}:${answer.result.password}`)}`;
  const snapshot = `rootfs-snapshot-${sha256(input.id)}`;
  const catalog = v.parse(Catalog, await (await fetch('https://registry.cloudflare.com/v2/_catalog?tags=true', { headers: { authorization } })).json());
  const repository = Object.entries(catalog.repositories).find(([, tags]) => tags?.includes(snapshot) === true)?.[0];

  if (repository === undefined) return 'absent';
  const manifest = (tag: string) => `https://registry.cloudflare.com/v2/${repository}/manifests/${tag}`;
  const read = await fetch(manifest(snapshot), { headers: { authorization, accept: ACCEPT } });

  if (read.status === 404) return 'absent';

  if (!read.ok) throw new Error(`reading ${snapshot} answered ${String(read.status)}: ${await read.text()}`);
  const set = v.parse(Manifest, await read.json()).annotations['io.cloudflare.cloudchamber.snapshot_set_id'];

  for (const tag of set === undefined ? [snapshot] : [snapshot, `rootfs-set-${sha256(set)}`]) {
    const deleted = await fetch(manifest(tag), { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

    if (!deleted.ok && deleted.status !== 404) throw new Error(`deleting ${tag} answered ${String(deleted.status)}: ${await deleted.text()}`);
  }

  return 'deleted';
}
