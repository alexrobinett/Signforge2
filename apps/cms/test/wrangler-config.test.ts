// The CMS has no default Wrangler environment, as apps/api has none (M3-37): every environment
// is explicit, so a build or deploy that names none gets no Worker name, vars or API binding,
// and fails, instead of shipping dev settings under the dev name.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const config = join(import.meta.dirname, '../wrangler.jsonc');
const read = (env?: string) => unstable_readConfig({ config, env }, { hideWarnings: true });

describe('wrangler.jsonc', () => {
  it('has nothing to build or deploy without an environment', () => {
    const bare = read();
    expect(bare.name).toBeUndefined();
    expect(bare.main).toBeUndefined();
    expect(bare.vars).toEqual({});
    expect(bare.services ?? []).toEqual([]);
  });

  it('names each environment, its API and its ENVIRONMENT', () => {
    for (const [env, name, api] of [
      ['dev', 'signforge-cms', 'signforge-api'],
      ['demo', 'signforge-cms-demo', 'signforge-api-demo'],
      ['prod', 'signforge-cms-prod', 'signforge-api-prod'],
    ] as const) {
      const c = read(env);
      expect(c.name, env).toBe(name);
      expect(c.main, env).toMatch(/@tanstack\/react-start\/server-entry$/);
      expect(c.vars, env).toEqual({ ENVIRONMENT: env });
      expect(c.services, env).toEqual([{ binding: 'API', service: api }]);
    }
  });
});
