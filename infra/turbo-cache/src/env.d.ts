// The bindings in wrangler.jsonc; the two tokens are secrets (`wrangler secret put`).
declare namespace Cloudflare {
  interface Env {
    ARTIFACTS: R2Bucket;
    TURBO_TOKEN: string;
    TURBO_READ_TOKEN: string;
  }
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
}
interface Env extends Cloudflare.Env {}
