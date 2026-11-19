/** Callers for the tool tests: members of one seeded org, by role, acting through the CMS. */
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';
import type { Caller } from '../src';

export const member = (orgId: string, role: Caller['role']): Caller => ({
  org: scoped(env.DB, orgId),
  role,
  actor: { kind: 'user', id: `user-${role}`, clientId: 'cms' },
  blobs: env.BLOBS,
});

/** Seeds the org `name` before the file's tests: `o` is filled in then, and `as(role)` is one of its members. */
export function seededMembers(name: string) {
  const o = {} as SeededOrg;
  beforeAll(async () => {
    Object.assign(o, await seedOrg(env.DB, name));
  });
  return { o, as: (role: Caller['role']) => member(o.orgId, role) };
}
