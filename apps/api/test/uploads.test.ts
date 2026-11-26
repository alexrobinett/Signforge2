import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { uploadSigner } from '../src/uploads';

const sign = async (settings: Partial<Env>, requestUrl: string) => {
  const signer = uploadSigner({ ...env, ...settings }, requestUrl);
  const { url } = await signer!.presignPut('up/o/a/x', { contentType: 'image/jpeg', contentLength: 10, expiresInSeconds: 60 });
  return new URL(url);
};

describe('uploadSigner in dev', () => {
  it("signs for the request's own origin", async () => {
    const url = await sign({}, 'http://127.0.0.1:8787/api/tools/start_upload');
    expect(url.origin).toBe('http://127.0.0.1:8787');
    expect(url.pathname).toBe('/cdn-cgi/local/r2/s3/signforge-dev/up/o/a/x');
  });

  // The CMS hands /api/* over a service binding with its own origin, which does not serve the API's bucket.
  it('signs for LOCAL_S3_ORIGIN when set', async () => {
    const url = await sign({ LOCAL_S3_ORIGIN: 'http://127.0.0.1:8797' }, 'http://localhost:3997/api/tools/start_upload');
    expect(url.origin).toBe('http://127.0.0.1:8797');
    expect(url.pathname).toBe('/cdn-cgi/local/r2/s3/signforge-dev/up/o/a/x');
  });
});
