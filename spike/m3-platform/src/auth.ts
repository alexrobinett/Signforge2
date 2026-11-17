/**
 * Better Auth with the organization and email-OTP plugins, built per request from the
 * environment. Better Auth recognises a D1 binding passed as `database` and runs it through its
 * own D1 Kysely dialect with transactions turned off.
 */
import { betterAuth } from 'better-auth';
import { emailOTP, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access';

// The plan's roles: owner, editor, viewer.
export const ac = createAccessControl({ ...defaultStatements, content: ['read', 'draft', 'publish'] });
export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, content: ['read', 'draft', 'publish'] }),
  editor: ac.newRole({ content: ['read', 'draft', 'publish'] }),
  viewer: ac.newRole({ content: ['read'] }),
};

export type Mailbox = Map<string, string>;

/** Options shared by the per-request instance and the CLI's static config. */
export function authOptions(mailbox: Mailbox) {
  return {
    emailAndPassword: { enabled: false },
    plugins: [
      emailOTP({
        async sendVerificationOTP({ email, otp }) {
          mailbox.set(email, otp);
        },
      }),
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        async sendInvitationEmail(data) {
          mailbox.set(`invite:${data.email}`, data.id);
        },
      }),
    ],
    session: { cookieCache: { enabled: true, maxAge: 300 } },
  };
}

export function createAuth(env: { DB: D1Database }, baseURL: string, mailbox: Mailbox) {
  return betterAuth({
    ...authOptions(mailbox),
    database: env.DB,
    baseURL,
    secret: 'sf-spike-not-a-secret-0123456789abcdef',
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
  });
}
