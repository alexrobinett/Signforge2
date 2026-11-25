/**
 * R2 keys, from docs/backend-plan.md#publishing:
 *
 *   o/<org>/b/<sha256>                    assets, template bundles and `/admin` manifest files
 *   o/<org>/f/<sha256>                    feed photos (owned by `apps/api/src/data/feed-photos.ts`, #195, #329)
 *   sys/b/<sha256>                        base templates
 *   o/<org>/m/<screen>/<manifestId>.json  manifests
 *   up/<org>/<asset>/<sha256>             asset uploads waiting for `finalize_asset`
 *
 * Uploads land outside `o/<org>/b/` so a client never writes a content-addressed key: what it PUTs
 * is moved there only once its hash, type and size are checked. The storage sweep (#235) deletes the
 * uploads of an asset left pending for 90 days, and a deleted asset's files in `o/<org>/b/` 90 days
 * after, once nothing names them; a lifecycle rule on `up/` can expire uploads sooner.
 *
 * Feed photos live under `o/<org>/f/` rather than `o/<org>/b/` so daily feed-photo cleanup can
 * never delete an uploaded asset, template bundle or `/admin`-published manifest file that happens
 * to share the same content hash.
 */
export const orgBlobKey = (orgId: string, sha256: string) => `o/${orgId}/b/${sha256}`;
export const baseBlobKey = (sha256: string) => `sys/b/${sha256}`;
export const manifestKey = (orgId: string, screenId: string, manifestId: string) => `o/${orgId}/m/${screenId}/${manifestId}.json`;
export const uploadKey = (orgId: string, assetId: string, sha256: string) => `up/${orgId}/${assetId}/${sha256}`;
