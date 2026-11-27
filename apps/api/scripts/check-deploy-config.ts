/**
 * Refuses an environment whose wrangler.jsonc still has a placeholder database id, before a deploy of it:
 *
 *   pnpm --filter @signforge/api check:deploy prod
 *
 * Only the environment named is read, so dev, which keeps the placeholder on purpose, and tests are untouched.
 */
import { unstable_readConfig } from 'wrangler';
import { placeholderDatabases } from './deploy-config';

const env = process.argv[2];
if (!env) throw new Error('usage: check:deploy <environment>');
const config = unstable_readConfig({ config: new URL('../wrangler.jsonc', import.meta.url).pathname, env }, { hideWarnings: true });
const placeholders = placeholderDatabases(config);
if (placeholders.length) {
  console.error(
    `wrangler.jsonc, environment "${env}": D1 ${placeholders.join(', ')} still has the placeholder database_id. Create the database (wrangler d1 create) and put its id there first.`,
  );
  process.exit(1);
}
