/**
 * Better Auth, built per request from the environment (proven in M3-00). Passing the D1 binding
 * as `database` makes Better Auth use its own D1 dialect with transactions off.
 */
import { betterAuth } from 'better-auth';
import type { EmailSender } from '../email';
import { authOptions } from './options';

export { COOKIE_PREFIX } from './options';
export { roles, ROLES, type Role } from './roles';

/** Only for `wrangler dev` and tests. Every other environment must set the AUTH_SECRET secret. */
const DEV_SECRET = 'signforge-dev-secret-not-for-deployed-environments';

/** The server's signing secret: Better Auth's, and the device socket tickets' (src/device/ticket.ts). */
export function authSecret(env: Pick<Env, 'AUTH_SECRET' | 'ENVIRONMENT'>): string {
  const secret = env.AUTH_SECRET ?? (env.ENVIRONMENT === 'dev' ? DEV_SECRET : undefined);
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return secret;
}

export function createAuth(env: Env, request: Request, email: EmailSender) {
  const origin = new URL(request.url).origin;
  const secret = authSecret(env);
  const appUrl = env.CMS_ORIGIN ?? origin;
  const github = env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {};
  return betterAuth({
    ...authOptions({ email, appUrl }),
    database: env.DB,
    baseURL: origin,
    secret,
    trustedOrigins: env.CMS_ORIGIN ? [origin, env.CMS_ORIGIN] : [origin],
    socialProviders: github,
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
