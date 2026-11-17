import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @signforge/db generate` writes a new migration after a schema change.
// Wrangler applies them: `wrangler d1 migrations apply` in apps/api, whose config points here.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
