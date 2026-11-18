// Static config for the Better Auth CLI (`pnpm exec auth generate --config auth.config.ts`). The
// Worker builds its instance per request (src/auth); this gives the CLI the same options and an
// in-memory SQLite database. The tables themselves live in packages/db/src/schema.ts, and
// test/auth-schema.test.ts checks Better Auth finds nothing missing in the migrated database.
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { authOptions } from './src/auth/options';

export const auth = betterAuth({
  ...authOptions({ email: { send: async () => {} }, appUrl: 'http://localhost', audit: async () => {} }),
  database: new DatabaseSync(':memory:'),
});
