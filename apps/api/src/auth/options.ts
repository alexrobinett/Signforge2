/**
 * Better Auth options that do not depend on the request or the environment. The Worker builds
 * its instance per request from these (`./index.ts`); the CLI's static config
 * (`auth.config.ts`) uses them too, so `auth generate` sees the same tables.
 */
import { newId, type OrgScope } from '@signforge/db';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { emailOTP, organization } from 'better-auth/plugins';
import type { EmailSender } from '../email';
import { ac, ROLES, roles } from './roles';

/** Session cookies are `sf.*` (`__Secure-sf.*` over https). */
export const COOKIE_PREFIX = 'sf';

/** Id prefixes for Better Auth's rows, so their ids look like ours (`newId`). */
const ID_PREFIX: Record<string, string> = {
  user: 'usr',
  session: 'ses',
  account: 'acc',
  verification: 'ver',
  organization: 'org',
  member: 'mem',
  invitation: 'inv',
  rateLimit: 'rl',
};

/**
 * Creating an org and accepting an invitation make that org active in the database but, in
 * 1.7.25, do not reissue the session cache cookie, so for up to its max age the server would
 * still see the old active org. Reissue it, as `organization/set-active` does.
 */
const ORG_SWITCHING_PATHS = new Set(['/organization/create', '/organization/accept-invitation']);
const refreshCacheAfterOrgChange = createAuthMiddleware(async (ctx) => {
  if (!ORG_SWITCHING_PATHS.has(ctx.path) || ctx.context.returned instanceof Error) return;
  const token = (await getSessionFromCtx(ctx))?.session.token;
  const fresh = token ? await ctx.context.internalAdapter.findSession(token) : null;
  if (fresh) await setSessionCookie(ctx, fresh);
});

type Row = Record<string, unknown>;
const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null;

/**
 * Membership changes go through Better Auth's organization endpoints, not the tool registry, so
 * this writes their audit rows (F9): the endpoint's name as the action, as a tool's would be, the
 * session user as the actor, and the changed row as the target, from what the endpoint returned.
 * The detail holds only the fields named here, never the request or the whole row: an org's
 * `metadata` is any JSON its owners set and comes back on every rename, so it may hold a secret.
 * The row is written after the change, not with it: Better Auth runs on D1 without transactions.
 */
const MEMBERSHIP_CHANGES: Record<
  string,
  {
    action: string;
    targetKind: 'invitation' | 'member' | 'organization';
    /** The changed row in the response, when it is not the response itself. */
    row?: (returned: Row) => unknown;
    detail: (row: Row, returned: Row, body: unknown) => Row;
  }
> = {
  // The creator's owner membership, made with the org: its only member grant that goes through no invitation.
  '/organization/create': {
    action: 'create_organization',
    targetKind: 'member',
    row: (r) => (Array.isArray(r.members) ? r.members[0] : undefined),
    detail: (m, org) => ({ userId: m.userId, role: m.role, name: org.name, slug: org.slug }),
  },
  '/organization/invite-member': { action: 'invite_member', targetKind: 'invitation', detail: (r) => ({ email: r.email, role: r.role }) },
  '/organization/cancel-invitation': { action: 'cancel_invitation', targetKind: 'invitation', detail: (r) => ({ email: r.email }) },
  '/organization/reject-invitation': { action: 'reject_invitation', targetKind: 'invitation', row: (r) => r.invitation, detail: (r) => ({ email: r.email }) },
  '/organization/accept-invitation': {
    action: 'accept_invitation',
    targetKind: 'member',
    row: (r) => r.member,
    detail: (r) => ({ userId: r.userId, role: r.role }),
  },
  '/organization/update-member-role': { action: 'update_member_role', targetKind: 'member', detail: (r) => ({ userId: r.userId, role: r.role }) },
  '/organization/remove-member': { action: 'remove_member', targetKind: 'member', row: (r) => r.member, detail: (r) => ({ userId: r.userId, role: r.role }) },
  '/organization/leave': { action: 'leave_organization', targetKind: 'member', detail: (r) => ({ userId: r.userId, role: r.role }) },
  // Which fields changed, and the new name and slug; never the values of the others.
  '/organization/update': {
    action: 'update_organization',
    targetKind: 'organization',
    detail: (r, _, body) => ({ name: r.name, slug: r.slug, changed: isRecord(body) && isRecord(body.data) ? Object.keys(body.data) : [] }),
  },
};

/** The CMS is the only client with a session; agents come through `/mcp` (Milestone 4). */
const CMS_CLIENT_ID = 'cms';

/** A plugin only for its after-hook: a plugin's hooks run beside the options' own (`refreshCacheAfterOrgChange`). */
function membershipAudit(audit: AuthDeps['audit']) {
  return {
    id: 'membership-audit',
    hooks: {
      after: [
        {
          matcher: (ctx: { path?: string }) => Boolean(ctx.path && MEMBERSHIP_CHANGES[ctx.path]),
          handler: createAuthMiddleware(async (ctx) => {
            const change = MEMBERSHIP_CHANGES[ctx.path];
            const returned = ctx.context.returned;
            if (!change || returned instanceof Error) return;
            // Better Auth's response, read once here: a changed shape after an upgrade fails loudly.
            const row = isRecord(returned) && change.row ? change.row(returned) : returned;
            const orgId = isRecord(row) && (change.targetKind === 'organization' ? row.id : row.organizationId);
            const actor = (await getSessionFromCtx(ctx))?.user.id;
            if (!isRecord(returned) || !isRecord(row) || typeof row.id !== 'string' || typeof orgId !== 'string' || !actor) {
              throw new Error(`${ctx.path} returned no ${change.targetKind} to audit`);
            }
            await audit(orgId, {
              actorKind: 'user',
              actorId: actor,
              clientId: CMS_CLIENT_ID,
              action: change.action,
              targetKind: change.targetKind,
              targetId: row.id,
              detailJson: JSON.stringify(change.detail(row, returned, ctx.body)),
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/**
 * Better Auth always accepts its built-in `admin` and `member` names and comma-joined roles.
 * SignForge has exactly one of owner, editor or viewer per member.
 */
async function oneOfOurRoles(role: string) {
  if (!(ROLES as string[]).includes(role)) throw new APIError('BAD_REQUEST', { message: `role must be one of ${ROLES.join(', ')}` });
}

export interface AuthDeps {
  email: EmailSender;
  /** Where invitation links point: the CMS. */
  appUrl: string;
  /** Appends a row to an org's audit log (`scoped(db, orgId).auditLog.append`). */
  audit: (orgId: string, entry: Parameters<OrgScope['auditLog']['append']>[0]) => Promise<unknown>;
  /** The org a new session starts in, or null to let the member choose (`startingOrg`). */
  startingOrg: (userId: string) => Promise<string | null>;
  /** Records the org a session made active, for `startingOrg` (`rememberActiveOrg`). */
  rememberActiveOrg: (userId: string, orgId: string) => Promise<unknown>;
}

export function authOptions({ email, appUrl, audit, startingOrg, rememberActiveOrg }: AuthDeps) {
  return {
    basePath: '/api/auth',
    // Password hashing does not fit the free plan's CPU limit; sign-in is passwordless.
    emailAndPassword: { enabled: false },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    user: { additionalFields: { lastActiveOrganizationId: { type: 'string', required: false, input: false, returned: false } } },
    // A session starts in the member's only org, or the one they last made active (#182), so only a
    // member of several orgs who never chose one is asked. Set at creation, so the cookie cache the
    // sign-in sets carries it, and the tab check (#129) sees it from the first request.
    databaseHooks: {
      session: {
        create: {
          before: async ({ userId }) => ({ data: { activeOrganizationId: await startingOrg(userId) } }),
        },
        update: {
          after: async ({ userId, activeOrganizationId }) => {
            if (typeof activeOrganizationId === 'string') await rememberActiveOrg(userId, activeOrganizationId);
          },
        },
      },
    },
    // Stored in D1, so limits hold across isolates and restarts. Per IP and path; Better Auth's
    // defaults are 100 per 10 s, 3 per 10 s for sign-in, and 3 per minute for sending a code.
    rateLimit: { enabled: true, storage: 'database' as const },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      database: { generateId: ({ model }: { model: string }) => newId(ID_PREFIX[model] ?? model.slice(0, 3).toLowerCase()) },
    },
    telemetry: { enabled: false },
    hooks: { after: refreshCacheAfterOrgChange },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email: to, otp }) {
          await email.send({
            to,
            subject: `Your SignForge code: ${otp}`,
            text: `Your SignForge sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you did not ask for it, ignore this email.`,
          });
        },
      }),
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        // Tenant rows reference the org and are not cascaded; deleting an org needs its content
        // removed first, which nothing does yet. Without transactions a refused delete could
        // leave the org with its members gone, so deletion is off until a ticket handles it.
        disableOrganizationDeletion: true,
        organizationHooks: {
          beforeCreateInvitation: ({ invitation }) => oneOfOurRoles(invitation.role),
          beforeAddMember: ({ member }) => oneOfOurRoles(member.role),
          beforeUpdateMemberRole: ({ newRole }) => oneOfOurRoles(newRole),
        },
        async sendInvitationEmail({ id, email: to, role, organization: org, inviter }) {
          const link = `${appUrl}/accept-invitation/${id}`;
          await email.send({
            to,
            subject: `Join ${org.name} on SignForge`,
            text: `${inviter.user.email} invited you to ${org.name} as ${role}.\n\nAccept: ${link}\n\nInvitation id: ${id}`,
          });
        },
      }),
      membershipAudit(audit),
    ],
  } satisfies BetterAuthOptions;
}
