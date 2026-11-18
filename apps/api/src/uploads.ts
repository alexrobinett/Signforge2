/**
 * The presigner for direct asset uploads (`create_asset_upload`), from the Worker's settings.
 *
 * Deployed: R2's S3 API, `R2_S3_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`) and
 * `R2_BUCKET_NAME`, signed with an R2 API token's `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
 * (secrets). The bucket needs a CORS rule allowing PUT with `content-type` from the CMS origin.
 *
 * `wrangler dev` (ENVIRONMENT `dev`, no endpoint set): the local bucket's S3 API, which wrangler
 * serves on the Worker's own origin at `/cdn-cgi/local/r2/s3` and checks against the credentials
 * in wrangler.jsonc's `local_dev.experimental_s3_credentials`. They are the constants below and
 * open nothing but local storage. A request the CMS hands over its service binding carries the
 * CMS's origin, which does not serve this bucket, so `LOCAL_S3_ORIGIN` names the API's own (the
 * dev script and the CMS e2e set it); the local S3 API allows cross-origin PUTs.
 */
import { r2Presigner, type UploadSigner } from '@signforge/tools';

const LOCAL_S3 = { bucket: 'signforge-dev', accessKeyId: 'signforge-local', secretAccessKey: 'signforge-local-only' } as const;

export function uploadSigner(env: Env, requestUrl: string): UploadSigner | undefined {
  if (env.R2_S3_ENDPOINT && env.R2_BUCKET_NAME && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    return r2Presigner({
      endpoint: env.R2_S3_ENDPOINT,
      bucket: env.R2_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
  }
  if (env.ENVIRONMENT === 'dev') {
    return r2Presigner({ endpoint: `${env.LOCAL_S3_ORIGIN ?? new URL(requestUrl).origin}/cdn-cgi/local/r2/s3`, ...LOCAL_S3 });
  }
  return undefined;
}
