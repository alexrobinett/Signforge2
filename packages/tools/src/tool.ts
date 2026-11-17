/**
 * What a tool is. A tool is one operation on an org's data with a stable name, a zod input, a
 * description written for an agent, the scope and minimum role it needs, and a handler. The CMS,
 * the MCP server and WebMCP all call tools through `dispatch` (./dispatch.ts); none of them
 * reaches the database another way.
 */
import type { OrgScope } from '@signforge/db';
import type { z } from 'zod';

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

/** What a handler gets. `org` is the only way it reaches tenant data. */
export interface ToolContext<I> {
  org: OrgScope;
  actor: Actor;
  input: I;
  /** The R2 bucket holding blobs and manifests (keys in ./r2.ts). */
  blobs: R2Bucket;
}

export type ToolErrorCode = 'unknown_tool' | 'forbidden' | 'invalid_input' | 'not_found' | 'conflict';

/** A refusal a handler means to return. Anything else a handler throws is a bug and propagates. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export const notFound = (what: string, id: string) => new ToolError('not_found', `${what} ${id} not found`);

export interface Tool<S extends z.ZodType = z.ZodType, O = unknown> {
  /** Stable: the CMS, agents and the audit log refer to it. snake_case, as MCP clients expect. */
  name: string;
  /** For an agent choosing a tool: what it does, when to use it, what it returns. */
  description: string;
  scope: Scope;
  minRole: Role;
  /** True if the tool changes data. Changes are audited; reads are not. */
  mutates: boolean;
  input: S;
  /** A valid input, shown to agents and used by the generated tests. Id fields name their kind (`screenId`, `groupIds`). */
  example: z.input<S>;
  /** What the change was made to, for the audit log. */
  target?: (input: z.output<S>, output: NoInfer<O>) => { kind: string; id: string };
  handler: (ctx: ToolContext<z.output<S>>) => Promise<O>;
}

/** Declare a tool, keeping its input and output types. */
export const defineTool = <S extends z.ZodType, O>(tool: Tool<S, O>): Tool<S, O> => tool;

/** Any registered tool. */
export type AnyTool = Tool<z.ZodType, any>;
