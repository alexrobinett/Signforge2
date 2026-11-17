// Test-only bindings, added in vitest.config.ts rather than wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
