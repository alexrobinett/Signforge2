// Test-only bindings, added in vitest.config.ts rather than wrangler.jsonc.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    /** JSON: every template in templates/, built by `buildTemplate` (vitest.config.ts). */
    TEMPLATE_BUILDS: string;
    /** JSON: the font catalogue's files, repo path to base64 bytes (vitest.config.ts). */
    FONT_FILES: string;
    /** JSON: each rate limit binding's `{ limit, period }` (seconds), by name, from wrangler.jsonc (vitest.config.ts). */
    RATE_LIMITS: string;
    /** JSON: each environment's Worker vars, by environment, from wrangler.jsonc (vitest.config.ts). */
    DEPLOYED_VARS: string;
    /** The agent eval's live model, key, runs per task and tasks (vitest.eval.config.ts); unset in CI, where the model is scripted. */
    EVAL_MODEL?: string;
    EVAL_KEY?: string;
    EVAL_RUNS?: string;
    EVAL_TASKS?: string;
  }
}
