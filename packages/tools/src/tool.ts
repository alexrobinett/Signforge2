/**
 * What a tool is. A tool is one operation on an org's data with a stable name, a zod input, a zod
 * output, a description written for an agent, the scope and minimum role it needs, and a handler. The CMS,
 * the MCP server and WebMCP all call tools through `dispatch` (./dispatch.ts); none of them
 * reaches the database another way.
 */
import type { DeviceCommand } from '@signforge/contract';
import type { OrgScope, PlatformScope, Staged } from '@signforge/db';
import type { z } from 'zod';
import type { UploadSigner } from './upload';

/** What a caller's grant allows. Sessions get every scope their role allows; an agent's OAuth grant names its own (Milestone 4). */
export const SCOPES = ['content:read', 'content:draft', 'content:publish', 'screens:manage'] as const;
export type Scope = (typeof SCOPES)[number];

/** The org roles, lowest first. A tool's `minRole` admits that role and every one after it. */
export const ROLES = ['viewer', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The most each role may do, whatever its grant says. Owner decision Q7 is open; the default is
 * that owners and editors publish and viewers read.
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: SCOPES,
  editor: SCOPES,
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
  /** The credential was revoked: close its sockets. */
  revoked(screenId: string, credentialId: string): Promise<void>;
  /** A command to act on now (a display override, identify, restart). A screen whose socket is down misses it. */
  command(screenId: string, command: DeviceCommand): Promise<void>;
}

/** What a handler gets. `org` is the only way it reaches data: an org's scope, or the platform's for a platform tool. */
export interface ToolContext<I, D extends DataScope = OrgScope> {
  org: D;
  actor: Actor;
  input: I;
  /** The R2 bucket holding blobs and manifests (keys in ./r2.ts). */
  blobs: R2Bucket;
  /** Signs direct uploads to that bucket (./upload.ts). Undefined where uploads are not configured. */
  uploads?: UploadSigner;
  /**
   * Add a staged change (a repository's `stage.*`) to this call's writes, and get its row back.
   * A tool never writes to D1 itself: the dispatcher runs the writes and the audit row in one
   * atomic batch after the handler returns. Only a tool with `mutates` may call it.
   */
  write: <T>(change: Staged<T>) => T;
  /**
   * Tell screens about this call's change. Queued: the dispatcher sends the notices only once the
   * writes are committed, so a screen never hears of a change that was rolled back.
   */
  notify: (send: (screens: ScreenNotifier) => Promise<void>) => void;
  /** The caller's rate limits. A tool that guards a guessable secret refuses without it. */
  rateLimit?: RateLimiter;
}

export type ToolErrorCode = 'unknown_tool' | 'forbidden' | 'invalid_input' | 'not_found' | 'conflict' | 'rate_limited';

/**
 * What the adapter counts against a rate limit, keyed by what it knows of the caller (the API: the
 * member and the address). `pairing_claim`: every claim of a pairing code, right or wrong.
 */
export type RateLimitBucket = 'pairing_claim';
/** Counts one attempt in `bucket`; false once the caller is over its limit. */
export type RateLimiter = (bucket: RateLimitBucket) => Promise<boolean>;

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
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export const notFound = (what: string, id: string) => new ToolError('not_found', `${what} ${id} not found`);

export interface Tool<S extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType, D extends DataScope = OrgScope> {
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
  input: S;
  /**
   * What the tool returns. Shown to agents as JSON Schema, and checked against every output in
   * tests (./output.ts); production trusts the handler. A list tool pages (./paging.ts).
   */
  output: R;
  /** A valid input, shown to agents and used by the generated tests. Id fields name their kind (`screenId`, `groupIds`). */
  example: z.input<S>;
  /** What the change was made to, for the audit log. */
  target?: (input: z.output<S>, output: NoInfer<z.output<R>>) => { kind: string; id: string };
  handler: (ctx: ToolContext<z.output<S>, D>) => Promise<NoInfer<z.output<R>>>;
  /**
   * For a tool whose writes carry a guard (a statement that fails the batch when what the handler
   * checked changed before the commit): called when the commit fails, it says whether the guard
   * refused, as a `ToolError`. Undefined means a real failure, which is thrown. Nothing was written.
   */
  refuseFailedCommit?: (ctx: { org: D; input: z.output<S> }) => Promise<ToolError | undefined>;
}

/** Declare a tool, keeping its input and output types. */
export const defineTool = <S extends z.ZodType, R extends z.ZodType>(tool: Tool<S, R>): Tool<S, R> => tool;

/** Declare a tool that works on an org's scope and on the platform's alike (templates). */
export const defineSharedTool = <S extends z.ZodType, R extends z.ZodType>(tool: Tool<S, R, DataScope>): Tool<S, R, DataScope> => tool;

/** Any registered tool. */
export type AnyTool<D extends DataScope = OrgScope> = Tool<z.ZodType, any, D>;
