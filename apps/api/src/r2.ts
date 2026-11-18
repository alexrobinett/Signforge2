/** R2 keys, from docs/backend-plan.md#publishing. Defined in `@signforge/tools`, whose publish tool reads them too. */
export { baseBlobKey, manifestKey, orgBlobKey } from '@signforge/tools';

/**
 * Headers for a stored file served from an API origin (`/api/blobs`, `/v1/device/blobs`).
 *
 * Template HTML and SVG are org-supplied markup: served as-is on this origin, a link to one
 * would run its script with the CMS session. So no file here may run as a page: `nosniff`
 * keeps the stored type, the CSP sandbox gives any document an opaque origin and no script,
 * and markup types download instead of rendering. The player and the preview fetch the bytes
 * and never navigate to these URLs, so none of this changes what a screen shows.
 */
export function blobHeaders(sha: string, contentType: string, size: number): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(size),
    etag: `"${sha}"`,
    // private: the response needs a session or a credential, so no shared cache may keep it.
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  };
  if (MARKUP.test(contentType)) headers['content-disposition'] = 'attachment';
  return headers;
}

/** Types a browser renders as a document that can carry script. */
const MARKUP = /^\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i;
