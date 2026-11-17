/**
 * `@signforge/tools`: one registry of operations that the CMS, the MCP server and WebMCP call.
 * See README.md for the route the CMS uses and how to add a tool.
 */
export { SCOPES, ROLES, ROLE_SCOPES, ToolError, defineTool, notFound, type Actor, type AnyTool, type Role, type Scope, type Tool, type ToolContext, type ToolErrorCode } from './tool';
export { dispatch, describeTools, effectiveScopes, permits, redact, type Caller, type DispatchResult } from './dispatch';
export { registry, TOOLS } from './registry';
export { baseBlobKey, manifestKey, orgBlobKey } from './r2';
export type { ScreenView, CredentialView } from './screens';
export type { GroupView } from './groups';
