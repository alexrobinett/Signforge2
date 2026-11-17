/**
 * Better Auth options that do not depend on the request or the environment. The Worker builds
 * its instance per request from these (`./index.ts`); the CLI's static config
 * (`auth.config.ts`) uses them too, so `auth generate` sees the same tables.
 */
import { newId } from '@signforge/db';
import type { BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { emailOTP, organization } from 'better-auth/plugins';
import type { EmailSender } from '../email';
import { ac, ROLES, roles } from './roles';

/** Session cookies are `sf.*` (`__Secure-sf.*` over https). */
export const COOKIE_PREFIX = 'sf';

/** Id prefixes for Better Auth's rows, so their ids look like ours (`newId`). */
const ID_PREFIX: Record<string, string> = {
  user: 'usr', session: 'ses', account: 'acc', verification: 'ver',
  organization: 'org', member: 'mem', invitation: 'inv', rateLimit: 'rl',
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
}

export function authOptions({ email, appUrl }: AuthDeps) {
  return {
    basePath: '/api/auth',
    // Password hashing does not fit the free plan's CPU limit; sign-in is passwordless.
    emailAndPassword: { enabled: false },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
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
    ],
  } satisfies BetterAuthOptions;
}
