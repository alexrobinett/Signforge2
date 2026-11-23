/**
 * Better Auth with email OTP, organizations and the OAuth provider plugin, built per request from
 * the environment, as apps/api builds it. The issuer lives on the CMS origin under `/api/auth`
 * (where the session cookie is); the MCP resource is `<MCP_ORIGIN>/mcp`.
 *
 * The org a person picks on the consent page reaches the grant through the consent's reference id:
 * the instance that handles the consent POST is built with `consentReference` returning the id of
 * the grant row written just before, so the plugin stores that id on the consent, the code, and
 * every access and refresh token issued from them. Every other instance returns no reference, so
 * no stored consent is ever found and the consent page is shown on every authorization.
 */
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { emailOTP, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access';

export const ac = createAccessControl({ ...defaultStatements, content: ['read', 'draft', 'publish'] });
export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, content: ['read', 'draft', 'publish'] }),
  editor: ac.newRole({ content: ['read', 'draft', 'publish'] }),
  viewer: ac.newRole({ content: ['read'] }),
};
export type Role = keyof typeof roles;

/** packages/tools' scopes, and what each role may hold (`ROLE_SCOPES`). */
export const TOOL_SCOPES = ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage'] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];
export const ROLE_SCOPES: Record<Role, readonly ToolScope[]> = {
  owner: TOOL_SCOPES,
  editor: ['content:read', 'content:draft', 'content:publish', 'screens:manage'],
  viewer: ['content:read'],
};
/** What a client may ask for: the tool scopes, and `offline_access` for a refresh token. */
export const OAUTH_SCOPES = [...TOOL_SCOPES, 'offline_access'] as const;

export interface Origins {
  /** The CMS origin: the issuer's host, where the session cookie lives. */
  cms: string;
  /** The API host serving `/mcp`. May equal `cms`. */
  mcp: string;
}
export const issuerOf = (o: Origins) => `${o.cms}/api/auth`;
export const resourceOf = (o: Origins) => `${o.mcp}/mcp`;

export type SendOtp = (email: string, otp: string) => Promise<void>;

export function authOptions(origins: Origins, sendOtp: SendOtp, consentReference?: () => string) {
  return {
    basePath: '/api/auth',
    emailAndPassword: { enabled: false },
    session: { cookieCache: { enabled: true, maxAge: 300 } },
    plugins: [
      emailOTP({ storeOTP: 'hashed', sendVerificationOTP: ({ email, otp }) => sendOtp(email, otp) }),
      organization({ ac, roles, creatorRole: 'owner' }),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: [...OAUTH_SCOPES],
        // Opaque access tokens, stored hashed, looked up in D1 on each call: revocation is immediate
        // and no signing key or JWKS is needed.
        disableJwtPlugin: true,
        storeTokens: 'hashed',
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Native MCP clients (Claude Code, Cursor) register loopback callbacks without application_type.
        clientRegistrationDefaultApplicationType: 'infer',
        resources: [resourceOf(origins)],
        clientRegistrationDefaultResources: [resourceOf(origins)],
        accessTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        postLogin: {
          page: '/consent',
          shouldRedirect: () => false,
          consentReferenceId: () => consentReference?.(),
        },
      }),
    ],
  };
}

export function createAuth(env: Pick<Env, 'DB' | 'CMS_ORIGIN' | 'MCP_ORIGIN'>, sendOtp: SendOtp, consentReference?: () => string) {
  const origins = { cms: env.CMS_ORIGIN, mcp: env.MCP_ORIGIN };
  return betterAuth({
    ...authOptions(origins, sendOtp, consentReference),
    database: env.DB,
    baseURL: origins.cms,
    trustedOrigins: [origins.cms],
    secret: 'sf-spike-not-a-secret-0123456789abcdef',
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    // On by default since 1.7: it introspects every table (about 19 D1 statements) once per
    // instance, and the instance is built per request. The migrations own the schema.
    advanced: { database: { validateSchema: false } },
  });
}
export type Auth = ReturnType<typeof createAuth>;
