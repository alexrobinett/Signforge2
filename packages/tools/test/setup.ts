import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
import { setOutputChecks } from '../src';

// Every tool output in these tests is checked against the tool's output schema.
setOutputChecks(true);
