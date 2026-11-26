/**
 * Better Auth, built per request from the environment (proven in M3-00). Passing the D1 binding
 * as `database` makes Better Auth use its own D1 dialect with transactions off.
 */
import { isLastOwnerRefusal, scoped, startingOrg } from '@signforge/db';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { EmailSender } from '../email';
import type { ConsentLink } from './agent-grants';
import { grantStore } from './grant-store';
import { authOptions } from './options';

export { ROLES, type Role } from './roles';

/** Only for `wrangler dev` and tests. Every other environment must set the AUTH_SECRET secret. */
const DEV_SECRET = 'signforge-dev-secret-not-for-deployed-environments';

/** The server's signing secret: Better Auth's, and the device socket tickets' (src/device/ticket.ts). */
export function authSecret(env: Pick<Env, 'AUTH_SECRET' | 'ENVIRONMENT'>): string {
  const secret = env.AUTH_SECRET ?? (env.ENVIRONMENT === 'dev' ? DEV_SECRET : undefined);
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return secret;
}

/**
 * The D1 binding Better Auth runs on, with D1's refusal of a change that would leave an org with no
 * owner (#292, migration 0036) turned into Better Auth's own 400, so the CMS says
 * why. Better Auth checks the owner count itself first, but in separate statements: this is the
 * refusal a request gets when another owner's change landed in between. Better Auth runs every
 * query as `prepare(sql).bind(...).all()`.
 */
function sayingWhyAnOwnerStays(d1: D1Database): D1Database {
  const statement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        if (key === 'all') {
          return () =>
            target.all().catch((err: unknown) => {
              if (!isLastOwnerRefusal(err)) throw err;
              throw APIError.from(
                'BAD_REQUEST',
                { code: 'ORGANIZATION_NEEDS_AN_OWNER', message: 'The organization must keep at least one owner, and this change would leave it with none.' },
                { cause: err },
              );
            });
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(d1, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createAuth(env: Env, request: Request, email: EmailSender) {
  const origin = new URL(request.url).origin;
  const secret = authSecret(env);
  const appUrl = env.CMS_ORIGIN ?? origin;
  const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {};
  // Called only once a request runs, after `auth` exists.
  const consent: ConsentLink = { complete: (call) => auth.api.oauth2Consent(call) };
  const auth = betterAuth({
    ...authOptions({
      email,
      appUrl,
      audit: (orgId, entry) => scoped(env.DB, orgId).auditLog.append(entry),
      startingOrg: (userId) => startingOrg(env.DB, userId),
      // On the CMS's host, as the issuer is (`<appUrl>/api/auth`): /mcp is routed to this Worker there (src/mcp).
      mcpResource: `${appUrl}/mcp`,
      grants: grantStore(env.DB),
      consent,
    }),
    database: sayingWhyAnOwnerStays(env.DB),
    baseURL: origin,
    secret,
    trustedOrigins: env.CMS_ORIGIN ? [origin, env.CMS_ORIGIN] : [origin],
    socialProviders: github,
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
