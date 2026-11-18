/**
 * The plan's roles: owner, editor, viewer. Better Auth's organization statements cover the org
 * itself (members, invitations); `content` is ours. What each role may do with tools is
 * `ROLE_SCOPES` in packages/tools, which the dispatcher checks.
 */
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access';

export const ac = createAccessControl({ ...defaultStatements, content: ['read', 'draft', 'publish'] } as const);

export const roles = {
  /** Everything, including members, invitations and org settings. */
  owner: ac.newRole({ ...ownerAc.statements, content: ['read', 'draft', 'publish'] }),
  /** Makes content, and publishes it unless the org says only owners do (Q7, checked by the tool dispatcher); cannot manage the org. */
  editor: ac.newRole({ content: ['read', 'draft', 'publish'] }),
  /** Reads only. */
  viewer: ac.newRole({ content: ['read'] }),
};

export type Role = keyof typeof roles;
export const ROLES = Object.keys(roles) as Role[];
