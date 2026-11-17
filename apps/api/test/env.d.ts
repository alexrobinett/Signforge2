// Test-only bindings, added in vitest.config.ts rather than wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    /** JSON: every template in templates/, built by `buildTemplate` (vitest.config.ts). */
    TEMPLATE_BUILDS: string;
    /** JSON: the font catalogue's files, repo path to base64 bytes (vitest.config.ts). */
    FONT_FILES: string;
  }
}
