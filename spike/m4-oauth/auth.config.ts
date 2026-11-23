// Static config for the Better Auth CLI (`auth generate`): the same plugins as src/auth.ts, with an
// in-memory SQLite database to diff against.
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { authOptions } from './src/auth';

const origins = { cms: 'http://localhost:8787', mcp: 'http://127.0.0.1:8787' };
export const auth = betterAuth({ ...authOptions(origins, async () => {}), database: new DatabaseSync(':memory:') });
