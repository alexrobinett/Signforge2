/**
 * `GET /api/blobs/:sha256`: a file the session's org can see, for the editor preview (M3-36).
 *
 * The org comes from the session (`requireOrg`), never from the request, so a hash only ever
 * resolves under that org's own R2 prefix, or under the shared prefix when it is a base
 * template's HTML or a catalogue brand font (public OFL bytes every org may use). Responses are `private` and can never run as a page here (`blobHeaders`).
 */
import { isCatalogueFontFile } from '@signforge/compiler';
import type { Hono } from 'hono';
import { baseBlobKey, blobHeaders, orgBlobKey } from '../r2';
import type { ApiEnv } from '.';

const SHA256 = /^[0-9a-f]{64}$/;

export function mountBlobs(api: Hono<ApiEnv>): void {
  api.get('/blobs/:sha256', async (c) => {
    const sha = c.req.param('sha256');
    const notFound = () => c.json({ error: 'file not found' }, 404, { 'cache-control': 'no-store' });
    if (!SHA256.test(sha)) return notFound();
    let obj = await c.env.BLOBS.get(orgBlobKey(c.var.orgId, sha));
    if (!obj && (isCatalogueFontFile(sha) || (await c.var.org.templates.versions.baseBundle(sha)))) obj = await c.env.BLOBS.get(baseBlobKey(sha));
    if (!obj) return notFound();
    return new Response(obj.body, { headers: blobHeaders(sha, obj.httpMetadata?.contentType || 'application/octet-stream', obj.size) });
  });
}
