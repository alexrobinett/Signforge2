/** A caller for the tool tests: a member of one org, with a role, acting through the CMS. */
import { scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import type { Caller } from '../src';

export const member = (orgId: string, role: Caller['role']): Caller => ({
  org: scoped(env.DB, orgId),
  role,
  actor: { kind: 'user', id: `user-${role}`, clientId: 'cms' },
  blobs: env.BLOBS,
});
