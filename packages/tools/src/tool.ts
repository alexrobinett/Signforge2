/**
 * What a tool is. A tool is one operation on an org's data with a stable name, a zod input, a zod
 * output, a description written for an agent, the scope and minimum role it needs, and a handler. The CMS,
 * the MCP server and WebMCP all call tools through `dispatch` (./dispatch.ts); none of them
 * reaches the database another way.
 */
import type { DeviceCommand, TableFeed, TemplateManifest, TemplateRuntimeReport } from '@signforge/contract';
import type { OrgScope, PlatformScope, Staged } from '@signforge/db';
import type { z } from 'zod';
import { type AgentCall, type AgentUsage, type AiProviderName, CMS_AGENT_CLIENT_ID, SCOPES, type ToolErrorCode } from './outputs';

export { CMS_AGENT_CLIENT_ID };
import type { UploadSigner } from './upload';

export { SCOPES };
export type Scope = (typeof SCOPES)[number];

/** The org roles, lowest first. A tool's `minRole` admits that role and every one after it. */
export const ROLES = ['viewer', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The most each role may do, whatever its grant says. Only owners have `org:manage` (the org's
 * settings). Whether editors keep `content:publish` is the org's choice (owner decision Q7,
 * `editorsPublish` in its settings; `effectiveScopes` in ./dispatch.ts applies it).
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: SCOPES,
  editor: ['content:read', 'content:draft', 'content:publish', 'screens:manage'],
  viewer: ['content:read'],
};

/** Who is acting. Recorded on every audited change. */
export interface Actor {
  kind: 'user' | 'agent' | 'device' | 'system';
  /** A user id, an agent grant id, a screen id, or a fixed name for the system (`sf-push`). */
  id: string;
  /** The app the actor acted through: `cms`, `sf-push`, an agent's OAuth client id. */
  clientId?: string;
}

/**
 * The data a tool reaches: an org's (`scoped(db, orgId)`), or for the platform registry the
 * platform's own (`platform(db)`: base templates). Each registry is dispatched with its own kind.
 */
export type DataScope = OrgScope | PlatformScope;

/**
 * Tells a screen, through its socket, about a change that concerns it (M3-06). Implemented by the
 * API with the screen's Durable Object; absent where no screen can be reached (tests, scripts).
 */
export interface ScreenNotifier {
  /** The screen's desired manifest is now `manifestId`. */
  manifest(screenId: string, manifestId: string): Promise<void>;
  /** A publish switched these screens: tell each (the API: through a queue, 50 screens a message). */
  manifests(changes: readonly { screenId: string; manifestId: string }[]): Promise<void>;
  /** The credential was revoked: close its sockets. */
  revoked(screenId: string, credentialId: string): Promise<void>;
  /** A command to act on now (a display override, identify, restart). A screen whose socket is down misses it. */
  command(screenId: string, command: DeviceCommand): Promise<void>;
}

/**
 * Seals a data source's feed URL for storage (`data_sources.url_encrypted`), bound to the source
 * it belongs to, so a sealed URL copied to another row does not open. Implemented by the API with
 * its key; only the poller unseals.
 */
export interface FeedUrlSealer {
  seal(source: { orgId: string; id: string }, url: string): Promise<string>;
}

/** A place a weather source can be made for: Open-Meteo's geocoding result, as the forecast URL needs it. */
export interface Place {
  /** The geocoder's own id for the place (a GeoNames id). */
  id: number;
  name: string;
  /** The first-level region (state, province), or `''`. */
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  /** IANA time zone: the forecast's daily values are for days there. */
  timezone: string;
}

/** Looks places up by name. Implemented by the API with Open-Meteo's geocoding; absent where none runs (most tests). */
export interface PlaceFinder {
  search(query: string): Promise<Place[]>;
}

/**
 * Reads a CSV or JSON table at a URL now (`read_table`), as the poller would: through its fetch
 * guards, converted by `@signforge/feeds`, within the snapshot limit. Implemented by the API. A
 * file that cannot be read is an `invalid_input` ToolError naming why in words.
 */
export interface TableReader {
  read(source: { url: string; format: 'csv' | 'json-table'; rowsPath?: string }): Promise<TableFeed>;
}

/**
 * Seals an alert channel's URL or signing secret for storage (`alert_channels`, #88), bound to the
 * org, the channel and the field, so a sealed value copied elsewhere does not open. Implemented by
 * the API with its key; only the delivery run unseals.
 */
export interface AlertSecretSealer {
  seal(channel: { orgId: string; kind: 'slack' | 'webhook' }, field: 'url' | 'secret', value: string): Promise<string>;
}

/**
 * Sends a queued alert delivery, in the caller's org, now rather than at the next delivery run (a
 * test send, a retry). Implemented by the API, which sends it after the response; absent in tests
 * and scripts, where it waits for the run.
 */
export type AlertDeliverer = (deliveryId: string) => void;

/**
 * Runs the runtime check on a built template: a headless render in a container with no network
 * (`apps/template-check`), the org's own, so one org's template never shares a browser with
 * another's. `orgId` is the scope's, never the input's. Implemented by the API with the check
 * Worker. Rejects when the check could not run; a template that fails it resolves with `ok: false`.
 */
export type TemplateChecker = (template: { orgId: string; manifest: TemplateManifest; html: string }) => Promise<TemplateRuntimeReport>;

/** A pending invitation, as `list_invitations` shows it. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: 'pending';
  expiresAt: string;
  inviterId: string;
  createdAt: string;
}

/**
 * Changes an org's members and invitations through Better Auth's organization endpoints, as the
 * caller, in the org the service was made for: Better Auth keeps its rules (one of our roles each),
 * D1 keeps an owner (#292), Better Auth sends the invitation, and its after hook writes the change's
 * audit row, so the member tools stage nothing. Its refusal is a `ToolError`. A tool checks the row is in its
 * org (`org.members`, `org.invitations`) before it asks.
 */
export interface Members {
  /** Invites the address with the role. Returns the invitation, as Better Auth made it. */
  invite(email: string, role: Role): Promise<Invitation>;
  cancelInvitation(invitationId: string): Promise<void>;
  updateRole(memberId: string, role: Role): Promise<void>;
  remove(memberId: string): Promise<void>;
}

/**
 * What the connection tools need from the API (apps/api/src/connectors): each provider's OAuth
 * and the CONNECTION_KEY that seals credentials. Tokens never leave it: a tool handles only
 * sealed values, the account's name and the scopes granted.
 */
export interface Connectors {
  /** The providers this deployment can connect. */
  providers: readonly string[];
  /**
   * The URL to send the person to for a new authorization: the provider's authorize endpoint
   * with `state` and a fresh PKCE challenge (S256). Also its code verifier, sealed for the
   * authorization (the org and the state's SHA-256), to store until it is finished.
   */
  begin(provider: string, authorization: { orgId: string; stateHash: string }, state: string): Promise<{ authorizeUrl: string; verifierSealed: string }>;
  /**
   * Exchange the provider's authorization code, with the authorization's verifier, for a grant,
   * sealed for `connection`. A provider's refusal is a `ToolError`.
   */
  finish(
    provider: string,
    authorization: { orgId: string; stateHash: string; verifierSealed: string },
    code: string,
    connection: { orgId: string; id: string },
  ): Promise<{ credentialsSealed: string; account: string; scopes: string[]; expiresAt: number | null }>;
  /** Revoke the sealed grant at the provider, where it can. A failure there is logged, not thrown: the credentials are deleted anyway. */
  revoke(provider: string, connection: { orgId: string; id: string }, credentialsSealed: string): Promise<void>;
}

/** What a test of an org's key came to: the models the provider offers it, or why it could not be reached, in a word. */
export type AiProviderTest = { ok: true; models: string[] } | { ok: false; problem: 'refused' | 'busy' | 'unreachable' | 'blocked' };

/** Which key a sealed value is: the org's, for a provider, and for an OpenAI-compatible endpoint the address it was saved for. */
export interface AiKey {
  orgId: string;
  provider: AiProviderName;
  /** An OpenAI-compatible endpoint's base address; null for Anthropic. A key opens only for the address it was sealed with. */
  baseUrl: string | null;
}

/**
 * What the AI provider tools need from the API (apps/api/src/agent): sealing an org's key, and
 * reaching the provider with it. The key is opened only there, to call the provider: no tool,
 * response, audit row or log line holds it.
 */
export interface AiProviders {
  /** The key, sealed for the org, the provider and an endpoint's address (the connectors' vault, `ai-key:`). */
  seal(key: AiKey, apiKey: string): Promise<string>;
  /**
   * A minimal request with the sealed key: the provider's model list, which costs no tokens. An
   * endpoint's address goes through the fetch guards on every hop (`blocked` when it may not be reached).
   */
  test(key: AiKey, sealed: string): Promise<AiProviderTest>;
}

/**
 * The calls an org's agents made over /mcp (M4-08), read back. It reads one org's only: the API
 * builds it for the caller's org. Never a call's input, output or message: what was called, when,
 * and how it ended. `since` bounds every read, in ms since the epoch.
 */
export interface AgentCallLog {
  /** Each grant's counts since `since`; a grant with no calls may be left out. */
  usage(grantIds: readonly string[], since: number): Promise<AgentUsage[]>;
  /** The grant's latest calls since `since`, newest first, at most `limit`. */
  recent(grantId: string, since: number, limit: number): Promise<AgentCall[]>;
  /** The grant's latest refused call since `since`. */
  lastRefusal(grantId: string, since: number): Promise<AgentCall | null>;
}

/**
 * Tool services (GLOSSARY.md): what a tool may use beyond its input and the org's data. A caller
 * carries the ones it can provide; a tool names those it uses in `needs`, and dispatch refuses a
 * call that lacks one before the handler runs. The API's constructor (apps/api/src/tool-services.ts)
 * provides every one; a test passes fakes (test/services.ts).
 *
 * A new service is a field here, its words below, the API's constructor, its fake, and `needs` on
 * the tools that use it; the compiler asks for each but the last.
 */
export interface ToolServices {
  /** Signs direct uploads to `blobs` (./upload.ts). The API has none where uploads are not configured. */
  uploads?: UploadSigner;
  /** Seals feed URLs and provider resources (./data-sources.ts). */
  feedUrls?: FeedUrlSealer;
  /** Seals alert channels' URLs and secrets (./alert-channels.ts). */
  alertSecrets?: AlertSecretSealer;
  /** Looks places up (`find_places`). */
  places?: PlaceFinder;
  /** Reads a table at a URL now (`read_table`). */
  tables?: TableReader;
  /** The runtime check of an org's template (./templates.ts). */
  templateCheck?: TemplateChecker;
  /** Providers' OAuth (./connections.ts). */
  connectors?: Connectors;
  /** The org's own model provider: sealing its key, and testing it (./ai-providers.ts). */
  aiProviders?: AiProviders;
  /** Better Auth's member and invitation changes (./members.ts). */
  members?: Members;
  /** Counts attempts against the caller's rate limits: a tool that guards a guessable secret or a third party's allowance. */
  rateLimit?: RateLimiter;
  /** The calls the org's agents made over /mcp, as recorded (M4-08; the API: Analytics Engine). */
  agentCalls?: AgentCallLog;
  /**
   * Reaches screens' sockets. Dispatch's own, like `deliverNow`: it sends what a handler queued with
   * `ctx.notify` once the writes are committed. Without it, screens learn of a change at their next sync.
   */
  notify?: ScreenNotifier;
  /** Sends what a handler queued with `ctx.deliverNow` once the writes are committed. Without it, they go at the next delivery run. */
  deliverNow?: AlertDeliverer;
}

/** The services dispatch uses itself, after the commit. A tool queues for them on its context and never needs one. */
type AfterCommit = 'notify' | 'deliverNow';
/** A service a tool can need. */
export type ServiceName = Exclude<keyof ToolServices, AfterCommit>;

/** Each service in the refusal of a call that lacks it: `find_places needs a rate limit, and this caller has none`. */
export const SERVICE_WORDS: Record<ServiceName, string> = {
  uploads: 'direct uploads (R2 S3 credentials)',
  feedUrls: 'a feed URL sealer',
  alertSecrets: 'an alert secret sealer',
  places: 'a place finder',
  tables: 'a table reader',
  templateCheck: 'the runtime check',
  connectors: 'the connectors',
  aiProviders: 'the AI providers',
  members: 'member management',
  rateLimit: 'a rate limit',
  agentCalls: "the agents' call log",
};

/** What a handler gets. `org` is the only way it reaches data: an org's scope, or the platform's for a platform tool. */
export interface ToolContext<I, D extends DataScope = OrgScope, N extends ServiceName = never> {
  org: D;
  actor: Actor;
  /** The caller's role in the org, for what a read may show it (an invitee's email, to owners only). */
  role: Role;
  /** The scopes the caller holds, as its org has them: for a change that needs more on some rows than the tool's own scope (deleting what screens play). */
  scopes: readonly Scope[];
  input: I;
  /** The R2 bucket holding blobs and manifests (keys in ./r2.ts). */
  blobs: R2Bucket;
  /** The caller's services, as it passed them: the tool sees those it `needs`, each there. */
  services: Pick<Required<ToolServices>, N>;
  /**
   * Add a staged change (a repository's `stage.*`) to this call's writes, and get its row back.
   * A tool never writes to D1 itself: the dispatcher runs the writes and the audit row in one
   * atomic batch after the handler returns. Only a tool with `mutates` may call it.
   */
  write: <T>(change: Staged<T>) => T;
  /**
   * Tell screens about this call's change. Queued: the dispatcher sends the notices, through the
   * caller's `notify`, only once the writes are committed, so a screen never hears of a change that
   * was rolled back.
   */
  notify: (send: (screens: ScreenNotifier) => Promise<void>) => void;
  /** Send a delivery this call queues as soon as its writes are committed, through the caller's `deliverNow`. */
  deliverNow: (deliveryId: string) => void;
  /**
   * Undo, if this call does not succeed, something the handler did outside the batch (a grant a
   * provider issued). Run after the refusal or failure, its own failure logged: best effort.
   */
  onDiscard: (undo: () => Promise<void>) => void;
}

/**
 * What the adapter counts against a rate limit, keyed by what it knows of the caller (the API: the
 * member and the address). `pairing_claim`: every claim of a pairing code, right or wrong.
 * `place_search`: every `find_places`, each a request to a third party's free service.
 * `table_read`: every `read_table`, each a fetch of a URL the caller typed.
 * `chat_turn`: every turn of the agent's drawer (#267), each one to several model requests, counted
 * apart from the org's daily turns so one person cannot spend them all in a minute.
 * `page_read`: every link the agent's fill reads (#263, #314), a fetch of a URL the caller pasted, which
 * costs no turn when the page cannot be read.
 * `template_check`: every runtime check of an org's template, keyed by the org, whose container it uses.
 */
export type RateLimitBucket = 'pairing_claim' | 'place_search' | 'table_read' | 'page_read' | 'chat_turn' | 'template_check';
/** Counts one attempt in `bucket`; false once the caller is over its limit. */
export type RateLimiter = (bucket: RateLimitBucket) => Promise<boolean>;

/**
 * What an agent grant may do (owner decision on #39): enough for an agent working through a task,
 * while a runaway loop is stopped within a minute and changes at most 2,000 things a day.
 * Constants, not settings: no org has asked for its own. A person is never counted.
 * A write is a call to a tool that `mutates`, counted when it is made, whether or not it changes anything.
 */
export const AGENT_LIMITS = { calls_per_minute: 120, writes_per_minute: 30, writes_per_day: 2000 } as const;
export type AgentLimit = keyof typeof AGENT_LIMITS;

/**
 * A window of an agent grant's limits, the minute or the UTC day, by when it started. Each window
 * gets one audit row for all the calls refused in it, whichever of its limits refused them.
 */
export interface AgentLimitWindow {
  window: 'minute' | 'day';
  start: number;
}

/**
 * Whether an agent grant's call is within its limits. Over one, `retryAfterSeconds` is when its
 * window ends, and `audit` names the window while it has no audit row yet: the dispatcher writes
 * it (once, however many calls race), then says so with `audited`.
 */
export type AgentAllowance = { ok: true } | { ok: false; limit: AgentLimit; retryAfterSeconds: number; audit?: AgentLimitWindow };

/**
 * Counts an agent grant's calls against `AGENT_LIMITS`, one counter per grant wherever the call
 * lands (the API: a Durable Object per grant). Every call within the call limit counts as a call,
 * one refused by a write limit included; only an admitted write counts as a write.
 */
export interface AgentLimiter {
  take(grantId: string, write: boolean): Promise<AgentAllowance>;
  /** The window's audit row is written: stop asking for it. */
  audited(grantId: string, window: AgentLimitWindow): Promise<void>;
}

/**
 * A refusal a handler means to return. Anything else a handler throws is a bug and propagates.
 * Either way nothing the handler staged is written, unless the refusal sets `changed`: then what
 * it staged before refusing (`finalize_asset` marks a bad upload rejected) is committed and
 * audited with the refusal.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: unknown,
    readonly changed = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolError';
  }
}

export const notFound = (what: string, id: string) => new ToolError('not_found', `${what} ${id} not found`);

/** An agent is calling: a Milestone 4 grant, or the in-CMS agent acting as its member. A tool only a person may run refuses both. */
export const isAgent = (actor: Actor) => actor.kind === 'agent' || actor.clientId === CMS_AGENT_CLIENT_ID;

export interface Tool<S extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType, D extends DataScope = OrgScope, N extends ServiceName = never> {
  /** Stable: the CMS, agents and the audit log refer to it. snake_case, as MCP clients expect. */
  name: string;
  /** For an agent choosing a tool: what it does, when to use it, what it returns. */
  description: string;
  scope: Scope;
  minRole: Role;
  /** True if the tool changes data. It stages its changes with `ctx.write`; they are audited, reads are not. */
  mutates: boolean;
  /**
   * True for a tool that creates something. Its input then has an optional `idempotencyKey`
   * (`fields.ts`), and the dispatcher makes a retry with the same key return the first result.
   */
  idempotent?: boolean;
  /**
   * True for a tool whose effect is on a screen, not in the database (identify, restart): it is
   * audited, and its notices are sent, though it stages no write.
   */
  alwaysAudited?: boolean;
  /**
   * True for a tool that publishes: the dispatcher runs it one call at a time per org and, when
   * its commit loses to another publish or an edit (`StaleVersionError`), runs it again from a
   * fresh read (./dispatch.ts, step 6). Its handler must be safe to run again.
   */
  publishes?: boolean;
  /**
   * True for a tool only a person may run (the agent grant tools, `delete_spot`): dispatch refuses an agent, a
   * grant's or the in-CMS one (`isAgent`), with `forbidden` before anything is read, and `/mcp` does
   * not list it.
   */
  people?: boolean;
  /** The services the handler uses. Dispatch refuses a call whose caller lacks one, with `forbidden`, before the handler runs. */
  needs?: readonly N[];
  input: S;
  /**
   * What the tool returns. Shown to agents as JSON Schema, and checked against every output in
   * tests (./output.ts); production trusts the handler. A list tool pages (./paging.ts).
   */
  output: R;
  /** A valid input, shown to agents and used by the generated tests. Id fields name their kind (`screenId`, `groupIds`). */
  example: z.input<S>;
  /**
   * What the change was made to, for the audit log. A refusal that changed something (`ToolError`'s
   * `changed`) has no output: a tool that refuses so either names its target from the input, or
   * takes the output as possibly undefined and returns undefined for no target.
   */
  target?: (input: z.output<S>, output: NoInfer<z.output<R>>) => { kind: string; id: string } | undefined;
  /**
   * What the call's audit row records beyond its input: a change its input does not name
   * (`publish`'s new default). Recorded under `detail`, redacted as the input is.
   */
  auditDetail?: (output: NoInfer<z.output<R>>) => Record<string, unknown> | undefined;
  handler: (ctx: ToolContext<z.output<S>, D, N>) => Promise<NoInfer<z.output<R>>>;
  /**
   * For a tool whose writes carry a guard (a statement that fails the batch when what the handler
   * checked changed before the commit): called when the commit fails, it says whether the guard
   * refused, as a `ToolError`. Undefined means a real failure, which is thrown. Nothing was written.
   */
  refuseFailedCommit?: (ctx: { org: D; input: z.output<S>; actor: Actor }) => Promise<ToolError | undefined>;
}

/** Declare a tool, keeping its input and output types. */
export const defineTool = <S extends z.ZodType, R extends z.ZodType, N extends ServiceName = never>(tool: Tool<S, R, OrgScope, N>): Tool<S, R, OrgScope, N> =>
  tool;

/** Declare a tool that works on an org's scope and on the platform's alike (templates). */
export const defineSharedTool = <S extends z.ZodType, R extends z.ZodType, N extends ServiceName = never>(
  tool: Tool<S, R, DataScope, N>,
): Tool<S, R, DataScope, N> => tool;

/** Any registered tool. */
export type AnyTool<D extends DataScope = OrgScope> = Tool<z.ZodType, any, D, ServiceName>;
