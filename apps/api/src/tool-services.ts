/**
 * The tool services (GLOSSARY.md; `ToolServices` in `@signforge/tools`) as this Worker provides
 * them: the one production constructor. The CMS's caller takes them all (`cmsCaller`, api/tools.ts);
 * `/admin`'s take only what their tools need. Each is cheap to build: none calls a binding or a
 * provider until a tool uses it.
 *
 * `/mcp` (M4-06, src/mcp) is the third adapter: it builds its services here, with the grant's org and
 * member as its `ServiceScope`. It gets no `members`, which needs a Better Auth that acts as the grant's
 * member and an audit hook that records the agent: only a session's request has one (`auth`).
 */
import type { RateLimitBucket, ToolServices } from '@signforge/tools';
import type { Context } from 'hono';
import { aiProviders } from './agent/provider';
import type { Auth } from './auth';
import { betterAuthMembers } from './auth/members';
import { CALLBACK_PATH, type ConnectorDeps, connectorDeps, connectorsFor, workerFetch } from './connectors';
import { alertSecretSealer, feedUrlSealer } from './data/cipher';
import { feedGuards } from './data/fetch';
import { openMeteoPlaces } from './data/places';
import { tableReader } from './data/tables';
import { deliverAlert } from './deliveries';
import { clientIp } from './device/pairing';
import { screenNotifier } from './device/screens';
import { emailSenderFor, type EmailSender } from './email';
import { templateCheckAllowed, templateChecker } from './template-check';
import { uploadSigner } from './uploads';

/** The Workers rate limit each per-person bucket counts against (wrangler.jsonc). */
const LIMITS: Record<Exclude<RateLimitBucket, 'template_check'>, (env: Env) => RateLimit> = {
  pairing_claim: (env) => env.PAIR_CLAIM_LIMIT,
  place_search: (env) => env.PLACE_SEARCH_LIMIT,
  table_read: (env) => env.TABLE_READ_LIMIT,
  page_read: (env) => env.PAGE_READ_LIMIT,
};

/** Who a call's services act for. */
export interface ServiceScope {
  /** The org the call acts in, or null for the platform's data (base templates), which has no alerts. */
  orgId: string | null;
  /** The member the per-person rate limits count, with the request's address. The system actor (`/admin`) is none. */
  member?: string;
  /** Sends test alerts by email. Tests pass a recorder; otherwise `emailSenderFor(env)`. */
  email?: EmailSender;
  /** Reaches providers. Tests pass a fake provider's; otherwise `connectorDeps(env)`. */
  connectors?: ConnectorDeps;
  /** The request's Better Auth, for the member tools, which act as its session's member. Only `/api` has one. */
  auth?: Auth;
}

/** Every service, each key present, so a service added to `ToolServices` is a type error here until it is built. */
type AllServices = { [K in keyof Required<ToolServices>]: ToolServices[K] };

export function toolServices<E extends { Bindings: Env }>(c: Context<E>, scope: ServiceScope): AllServices {
  const { env } = c;
  const { orgId, member } = scope;
  return {
    uploads: uploadSigner(env, c.req.url),
    feedUrls: feedUrlSealer(env),
    alertSecrets: alertSecretSealer(env),
    places: openMeteoPlaces(env),
    tables: tableReader(feedGuards(env, workerFetch)),
    templateCheck: templateChecker(env),
    connectors: connectorsFor(env, scope.connectors ?? connectorDeps(env), new URL(CALLBACK_PATH, c.req.url).href),
    aiProviders: aiProviders(env),
    members: scope.auth && orgId !== null ? betterAuthMembers(scope.auth, c.req.raw.headers, orgId) : undefined,
    rateLimit: async (bucket) => {
      // A template check counts against the org, whose one container it uses. The platform's templates are not checked here.
      if (bucket === 'template_check') return orgId !== null && templateCheckAllowed(env, orgId);
      // The system actor claims, searches and reads nothing; if it tried, it would be refused.
      if (member === undefined) return false;
      // The others count against the member and against the address, so many accounts on one address share a limit.
      const limit = LIMITS[bucket](env);
      const [user, ip] = await Promise.all([limit.limit({ key: `user:${member}` }), limit.limit({ key: `ip:${clientIp(c)}` })]);
      return user.success && ip.success;
    },
    notify: screenNotifier(env),
    deliverNow:
      orgId === null
        ? undefined
        : // After the response: a receiver's 5 seconds are not the caller's to wait for.
          (id) =>
            c.executionCtx.waitUntil(
              deliverAlert(env, scope.email ?? emailSenderFor(env), orgId, id).catch((err: unknown) => console.error('alert delivery failed', err)),
            ),
  };
}
