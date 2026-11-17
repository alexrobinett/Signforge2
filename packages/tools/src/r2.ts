/**
 * R2 keys, from docs/backend-plan.md#publishing:
 *
 *   o/<org>/b/<sha256>                    assets and template bundles
 *   sys/b/<sha256>                        base templates
 *   o/<org>/m/<screen>/<manifestId>.json  manifests
 *   up/<org>/<asset>/<sha256>             asset uploads waiting for `finalize_asset`
 *
 * Uploads land outside `o/<org>/b/` so a client never writes a content-addressed key: what it PUTs
 * is moved there only once its hash, type and size are checked. One lifecycle rule on `up/` can
 * expire uploads that were never finalized.
 */
export const orgBlobKey = (orgId: string, sha256: string) => `o/${orgId}/b/${sha256}`;
export const baseBlobKey = (sha256: string) => `sys/b/${sha256}`;
export const manifestKey = (orgId: string, screenId: string, manifestId: string) => `o/${orgId}/m/${screenId}/${manifestId}.json`;
export const uploadKey = (orgId: string, assetId: string, sha256: string) => `up/${orgId}/${assetId}/${sha256}`;
