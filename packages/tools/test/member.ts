/** Callers for the tool tests: members of an org, by role, acting through the CMS. */
import { scoped, type OrgScope } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll } from 'vitest';
import type { Caller, ToolServices } from '../src';
import { fakeServices } from './services';

/** A member of `org` acting through the CMS, with the fake services and `services` put over them. */
export const memberOf = (org: OrgScope, role: Caller['role'], services: ToolServices = {}, userId = 'user-1'): Caller => ({
  org,
  role,
  actor: { kind: 'user', id: userId, clientId: 'cms' },
  blobs: env.BLOBS,
  services: { ...fakeServices, ...services },
});

export const member = (orgId: string, role: Caller['role']): Caller => memberOf(scoped(env.DB, orgId), role, {}, `user-${role}`);

/** Seeds the org `name` before the file's tests: `o` is filled in then, and `as(role)` is one of its members. */
export function seededMembers(name: string) {
  const o = {} as SeededOrg;
  beforeAll(async () => {
    Object.assign(o, await seedOrg(env.DB, name));
  });
  return { o, as: (role: Caller['role']) => member(o.orgId, role) };
}
