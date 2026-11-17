/**
 * The plan's roles: owner, editor, viewer. Better Auth's organization statements cover the org
 * itself (members, invitations); `content` is ours, checked by the tool registry (M3-12).
 */
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access';

export const ac = createAccessControl({ ...defaultStatements, content: ['read', 'draft', 'publish'] } as const);

export const roles = {
  /** Everything, including members, invitations and org settings. */
  owner: ac.newRole({ ...ownerAc.statements, content: ['read', 'draft', 'publish'] }),
  /** Makes and publishes content; cannot manage the org. */
  editor: ac.newRole({ content: ['read', 'draft', 'publish'] }),
  /** Reads only. */
  viewer: ac.newRole({ content: ['read'] }),
};

export type Role = keyof typeof roles;
export const ROLES = Object.keys(roles) as Role[];
