/**
 * The member tools' `Members` service (#108): Better Auth's organization endpoints, called on the
 * request's own Better Auth instance with its headers, so the caller is the session's member and
 * Better Auth's rules and after hooks run as they do for the CMS's own calls. `membershipAudit`
 * writes each change's audit row. The org is named on every call, the one the service was made for.
 * Better Auth's refusals become tool refusals: a 400 (already a member, already invited, the last
 * owner) is `conflict`, a 401 or 403 `forbidden`, a 404 `not_found`.
 */
import { type Invitation, type Members, ROLES, type Role, ToolError } from '@signforge/tools';
import { APIError } from 'better-auth/api';
import type { Auth } from './index';

const isRole = (r: string | null | undefined): r is Role => (ROLES as readonly (string | null | undefined)[]).includes(r);

const REFUSALS: Record<number, ToolError['code']> = { 400: 'conflict', 401: 'forbidden', 403: 'forbidden', 404: 'not_found' };

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const code = err instanceof APIError ? REFUSALS[err.statusCode] : undefined;
    if (!code || !(err instanceof APIError)) throw err;
    throw new ToolError(code, err.body?.message ?? err.message);
  }
}

export function betterAuthMembers(auth: Auth, headers: Headers, organizationId: string): Members {
  return {
    invite: (email, role) =>
      refusing(async (): Promise<Invitation> => {
        const i = await auth.api.createInvitation({ headers, body: { email, role, organizationId } });
        if (!isRole(i.role) || i.status !== 'pending') throw new Error(`Better Auth made a ${i.status} invitation with role ${i.role}`);
        return {
          id: i.id,
          email: i.email,
          role: i.role,
          status: i.status,
          expiresAt: new Date(i.expiresAt).toISOString(),
          inviterId: i.inviterId,
          createdAt: new Date(i.createdAt).toISOString(),
        };
      }),
    cancelInvitation: (invitationId) => refusing(async () => void (await auth.api.cancelInvitation({ headers, body: { invitationId } }))),
    updateRole: (memberId, role) => refusing(async () => void (await auth.api.updateMemberRole({ headers, body: { memberId, role, organizationId } }))),
    remove: (memberId) => refusing(async () => void (await auth.api.removeMember({ headers, body: { memberIdOrEmail: memberId, organizationId } }))),
  };
}
