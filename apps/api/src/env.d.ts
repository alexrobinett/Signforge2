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
interface Env extends AuthSettings {}
declare namespace Cloudflare {
  interface Env extends AuthSettings {}
}
