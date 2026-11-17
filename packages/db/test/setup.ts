import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// The migrations wrangler applies, applied to this test run's local D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
