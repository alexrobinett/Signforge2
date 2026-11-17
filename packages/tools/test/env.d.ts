// Bindings from vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BLOBS: R2Bucket;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
