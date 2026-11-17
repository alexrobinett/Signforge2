/**
 * R2 keys, from docs/backend-plan.md#publishing:
 *
 *   o/<org>/b/<sha256>                    assets and template bundles
 *   sys/b/<sha256>                        base templates
 *   o/<org>/m/<screen>/<manifestId>.json  manifests
 */
export const orgBlobKey = (orgId: string, sha256: string) => `o/${orgId}/b/${sha256}`;
export const baseBlobKey = (sha256: string) => `sys/b/${sha256}`;
export const manifestKey = (orgId: string, screenId: string, manifestId: string) => `o/${orgId}/m/${screenId}/${manifestId}.json`;
