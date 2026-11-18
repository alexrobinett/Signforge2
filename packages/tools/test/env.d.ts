// Bindings from vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BLOBS: R2Bucket;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    /** JSON: media-check fixture clips, base64 by file name. */
    VIDEO_CLIPS: string;
  }
}
