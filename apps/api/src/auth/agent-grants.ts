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
import { SCOPES, type Scope } from '@signforge/tools';
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
          return ctx.json(await link.complete({ headers: ctx.headers, body: { accept: true, oauth_query: ctx.body.oauth_query, scope } }));
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
