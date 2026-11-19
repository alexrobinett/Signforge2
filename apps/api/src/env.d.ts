// worker-configuration.d.ts is generated from the `dev` environment (`pnpm types`); demo and prod
// have the same bindings, and ENVIRONMENT is typed as a string because it differs between them.
// Secrets and optional settings. `wrangler types` only sees wrangler.jsonc, so these are declared
// here; set them with `wrangler secret put` (see docs/tickets/M3-09-better-auth-and-organizations.md).
interface AuthSettings {
  /** Better Auth's signing secret, 32+ random bytes. Required outside dev. */
  AUTH_SECRET?: string;
  /** GitHub OAuth app. GitHub sign-in is offered only when both are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The CMS's origin, if it differs from the API's: trusted for auth, and where invitation links point. */
  CMS_ORIGIN?: string;
}
/** Direct uploads to R2 by presigned PUT (src/uploads.ts). Unset in dev, which uses the local bucket's S3 API. */
interface UploadSettings {
  /** `https://<account>.r2.cloudflarestorage.com` */
  R2_S3_ENDPOINT?: string;
  /** The name of the bucket bound as BLOBS. */
  R2_BUCKET_NAME?: string;
  /** An R2 API token's S3 credentials, with write access to that bucket only. Secrets. */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** Dev only: the origin the browser reaches this Worker's `wrangler dev` on, for the local bucket's S3 API. Default: the request's. */
  LOCAL_S3_ORIGIN?: string;
}
/** The data-source poller (src/data). */
interface DataSourceSettings {
  /** Encrypts feed URLs and alert channels' URLs and signing secrets at rest (src/data/cipher.ts), 32+ random bytes. Required outside dev; changing it loses every stored URL and secret. */
  DATA_SOURCE_KEY?: string;
  /** Dev only: where `find_places` searches instead of Open-Meteo's geocoding (src/data/places.ts). The CMS e2e points it at a stub. */
  GEOCODING_URL?: string;
}
/** Connected accounts (src/connectors). */
interface ConnectorSettings {
  /**
   * Encrypts connections' credentials (OAuth grants, API keys) and pending PKCE verifiers at rest
   * (src/connectors/vault.ts), 32+ random bytes, separate from DATA_SOURCE_KEY. Required outside dev;
   * changing it loses every connection's credentials (each then needs reconnecting).
   */
  CONNECTION_KEY?: string;
}
interface Env extends AuthSettings, UploadSettings, DataSourceSettings, ConnectorSettings {}
declare namespace Cloudflare {
  interface Env extends AuthSettings, UploadSettings, DataSourceSettings, ConnectorSettings {}
}
