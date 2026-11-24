/**
 * Agent grants (M4-04, #109): what an OAuth client may do in one org, as one member, until revoked.
 * spike/m4-oauth/RESULTS.md has the why of each piece.
 *
 * - **Consent** is `POST /api/auth/agent-grants/consent`, under Better Auth's tree, so `/api` keeps
 *   one writer besides the tool route (test/routes.test.ts). The body is the provider's signed
 *   query (the plugin's before hook refuses a forged or stale one before this runs), Allow or
 *   Cancel, the org and the scopes the person chose. Allow writes the grant row and its audit row
 *   first, in one batch: the org, the member, the client, and the chosen scopes narrowed to those
 *   the client asked for and capped by the member's role as the org has it now. Then it completes
 *   the provider's consent with the grant's id as the consent's reference id, which the provider
 *   copies onto the code and every token. A token whose grant row is missing is not live
 *   (`agentGrantForToken` in packages/db), so a failure between the two leaves nothing usable.
 * - **Removal.** A member removed from an org, or leaving it, loses their grants there: revoked,
 *   with the provider's tokens and consents for them, after Better Auth's change.
 */
import { type Role, SCOPES, type Scope, shownClient } from '@signforge/tools';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';

/** What a client may ask for: the tool scopes, and `offline_access` for a refresh token. */
export const OAUTH_SCOPES = [...SCOPES, 'offline_access'] as const;

export interface GrantDeps {
  /**
   * Writes a grant and its audit row, as the member, with `scopes` capped by their role in the
   * org now, and returns the scopes it holds. Writes nothing for a user who is not a member of the
   * org, or when no scope is left once capped.
   */
  create(grant: {
    orgId: string;
    userId: string;
    clientId: string;
    clientName: string | null;
    scopes: Scope[];
  }): Promise<{ ok: true; grantId: string; scopes: Scope[] } | { ok: false; refused: 'not_a_member' | 'no_scopes' }>;
  /** Revokes the user's grants in the org, and their tokens, audited as `by`. */
  revokeMember(orgId: string, userId: string, by: string): Promise<void>;
  /** Revokes one grant the provider issued no code for, audited as `by`. */
  revokeUnissued(orgId: string, grantId: string, by: string): Promise<void>;
  /** The user's orgs, each with their role and which of `requested` a grant there may hold now (for the consent page). */
  offers(userId: string, requested: Scope[]): Promise<{ orgId: string; name: string; role: Role; scopes: Scope[] }[]>;
}

type ConsentBody = { accept: boolean; oauth_query: string; scope?: string };

/**
 * The consent endpoint's link to the provider in the same instance: the grant id the provider's
 * `consentReferenceId` returns while this request completes its consent, and the provider's own
 * consent (`auth.api.oauth2Consent`, which `createAuth` passes; its route is disabled).
 */
export interface ConsentLink {
  grantId?: string;
  complete: (call: { headers: Headers; body: ConsentBody }) => Promise<{ redirect: boolean; url: string }>;
}

const consentBody = z.object({
  oauth_query: z.string().min(1),
  accept: z.boolean(),
  organizationId: z.string().min(1).optional(),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length).optional(),
});

/** Membership changes after which the member's grants in the org end. */
const ENDS_MEMBERSHIP: Record<string, (returned: Record<string, unknown>) => unknown> = {
  '/organization/remove-member': (r) => r.member,
  '/organization/leave': (r) => r,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function agentGrants(grants: GrantDeps, link: ConsentLink) {
  return {
    id: 'agent-grants',
    endpoints: {
      /**
       * What the consent page shows (`/connect` in the CMS): the client, where its code goes, the
       * person, and each of their orgs with the scopes a grant there may hold (asked for, and capped by
       * the role as the org has it now). A read: it writes nothing. The signed query is checked here,
       * as the provider's hook checks it on the consent POST.
       */
      agentGrantRequest: createAuthEndpoint(
        '/agent-grants/request',
        { method: 'GET', query: z.object({ oauth_query: z.string().min(1) }), requireHeaders: true, use: [sessionMiddleware] },
        async (ctx) => {
          if (!(await verifyOAuthQueryParams(ctx.query.oauth_query, ctx.context.secret))) {
            throw new APIError('BAD_REQUEST', { message: 'this request has expired or is not valid: connect again from the app' });
          }
          const query = new URLSearchParams(ctx.query.oauth_query);
          const clientId = query.get('client_id') ?? '';
          const client = await ctx.context.adapter.findOne<{ name: string | null }>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
          if (!client) throw new APIError('BAD_REQUEST', { message: 'no such client' });
          const asked = (query.get('scope') ?? '').split(' ');
          const requested = SCOPES.filter((s) => asked.includes(s));
          const { user } = ctx.context.session;
          return ctx.json({
            // An unverified client's name only when it is plain (`shownClient`); otherwise none reaches the page.
            client: shownClient(clientId, client.name, query.get('redirect_uri') ?? ''),
            user: { name: user.name, email: user.email },
            orgs: await grants.offers(user.id, requested),
          });
        },
      ),
      agentGrantConsent: createAuthEndpoint(
        '/agent-grants/consent',
        { method: 'POST', body: consentBody, requireHeaders: true, use: [sessionMiddleware] },
        async (ctx) => {
          const { session } = ctx.context;
          const query = new URLSearchParams(ctx.body.oauth_query);
          const clientId = query.get('client_id');
          if (!clientId) throw new APIError('BAD_REQUEST', { message: 'the query names no client' });
          if (!ctx.body.accept) {
            return ctx.json(await link.complete({ headers: ctx.headers, body: { accept: false, oauth_query: ctx.body.oauth_query } }));
          }
          if (!ctx.body.organizationId) throw new APIError('BAD_REQUEST', { message: 'choose the organization the connection works in' });
          const requested = (query.get('scope') ?? '').split(' ');
          const chosen = (ctx.body.scopes ?? []).filter((s) => requested.includes(s));
          const client = await ctx.context.adapter.findOne<{ name: string | null }>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
          if (!client) throw new APIError('BAD_REQUEST', { message: 'no such client' });
          const made = await grants.create({ orgId: ctx.body.organizationId, userId: session.user.id, clientId, clientName: client.name, scopes: chosen });
          if (!made.ok && made.refused === 'not_a_member') throw new APIError('FORBIDDEN', { message: 'you are not a member of that organization' });
          if (!made.ok) throw new APIError('BAD_REQUEST', { message: 'choose at least one scope this client asked for and your role allows' });
          link.grantId = made.grantId;
          // Always the grant's own scopes: the provider would otherwise keep every scope the client asked
          // for. offline_access, for a refresh token, when it asked.
          const scope = [...made.scopes, ...(requested.includes('offline_access') ? ['offline_access'] : [])].join(' ');
          const answer = await link.complete({ headers: ctx.headers, body: { accept: true, oauth_query: ctx.body.oauth_query, scope } });
          // The provider can answer with no code (prompt=login with a session older than the query sends the
          // person to sign in first): the grant would hold nothing, so it ends now, and the next consent makes one.
          if (!new URL(answer.url, ctx.context.baseURL).searchParams.has('code')) {
            await grants.revokeUnissued(ctx.body.organizationId, made.grantId, session.user.id);
          }
          return ctx.json(answer);
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: (ctx: { path?: string }) => Boolean(ctx.path && ENDS_MEMBERSHIP[ctx.path]),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            const rowOf = ENDS_MEMBERSHIP[ctx.path];
            if (!rowOf || returned instanceof Error || !isRecord(returned)) return;
            const row = rowOf(returned);
            const by = (await getSessionFromCtx(ctx))?.user.id;
            if (!isRecord(row) || typeof row.organizationId !== 'string' || typeof row.userId !== 'string' || !by) {
              throw new Error(`${ctx.path} returned no membership to end grants for`);
            }
            await grants.revokeMember(row.organizationId, row.userId, by);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
