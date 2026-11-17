// Static config for the Better Auth CLI (`auth generate`). The Worker builds its instance per
// request in src/auth.ts; this file only gives the CLI the same plugins and an in-memory SQLite
// database to diff against.
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { authOptions } from './src/auth';

export const auth = betterAuth({ ...authOptions(new Map()), database: new DatabaseSync(':memory:') });
