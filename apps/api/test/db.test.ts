import { env } from 'cloudflare:workers';
import { scoped } from '@signforge/db';
import { seedTwoOrgs } from '@signforge/db/testing';
import { describe, expect, it } from 'vitest';

// The Worker's D1 binding carries packages/db's schema, and a scope sees only its own org.
describe('database', () => {
  it("is migrated, and org B's scope cannot see org A's screen", async () => {
    const { a, b } = await seedTwoOrgs(env.DB);
    expect(await scoped(env.DB, a.orgId).screens.get(a.screen)).toBeDefined();
    expect(await scoped(env.DB, b.orgId).screens.get(a.screen)).toBeUndefined();
  });
});
