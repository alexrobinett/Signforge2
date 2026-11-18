/**
 * Direct uploads to R2: presigned PUT URLs over R2's S3 API, signed with AWS Signature V4 using
 * Web Crypto. The browser PUTs straight to R2, so the bytes never pass through a Worker.
 *
 * The URL signs `content-type` and `content-length`, so R2 refuses a PUT of another type or size
 * than the one the server agreed to. It does not bind the bytes: `finalize_asset` hashes what
 * landed before anything uses it.
 *
 * Local development: wrangler and Miniflare serve the local bucket's S3 API at
 * `<origin>/cdn-cgi/local/r2/s3/<bucket>/<key>` when the binding has local S3 credentials
 * (`local_dev.experimental_s3_credentials` in wrangler.jsonc), and check the same signatures.
 */

export interface UploadSigner {
  /** A URL that accepts one PUT of exactly this type and size to `key`, until it expires. */
  presignPut(key: string, options: { contentType: string; contentLength: number; expiresInSeconds: number }): Promise<{ url: string; expiresAt: number }>;
}

export interface R2PresignConfig {
  /** The S3 API endpoint: `https://<account>.r2.cloudflarestorage.com`, or the local one. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2's region is `auto`. */
  region?: string;
  now?: () => number;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
/** RFC 3986 encoding, as SigV4 wants: everything but unreserved characters. */
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function r2Presigner(config: R2PresignConfig): UploadSigner {
  const region = config.region ?? 'auto';
  const base = new URL(config.endpoint);
  const basePath = base.pathname.replace(/\/+$/, '');
  return {
    async presignPut(key, { contentType, contentLength, expiresInSeconds }) {
      const nowMs = config.now?.() ?? Date.now();
      const amzDate = new Date(nowMs)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
      const date = amzDate.slice(0, 8);
      const scope = `${date}/${region}/s3/aws4_request`;
      const path = `${basePath}/${uriEncode(config.bucket)}/${key.split('/').map(uriEncode).join('/')}`;
      const signedHeaders = 'content-length;content-type;host';
      const params: [string, string][] = [
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
        ['X-Amz-Date', amzDate],
        ['X-Amz-Expires', String(expiresInSeconds)],
        ['X-Amz-SignedHeaders', signedHeaders],
      ];
      const query = params
        .map(([k, v]) => [uriEncode(k), uriEncode(v)])
        .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const canonicalRequest = [
        'PUT',
        path,
        query,
        `content-length:${contentLength}\ncontent-type:${contentType.trim()}\nhost:${base.host}\n`,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join('\n');
      let k = await hmac(enc.encode(`AWS4${config.secretAccessKey}`), date);
      k = await hmac(k, region);
      k = await hmac(k, 's3');
      k = await hmac(k, 'aws4_request');
      const signature = hex(await hmac(k, stringToSign));
      return { url: `${base.protocol}//${base.host}${path}?${query}&X-Amz-Signature=${signature}`, expiresAt: nowMs + expiresInSeconds * 1000 };
    },
  };
}
