/**
 * `@signforge/tools`: one registry of operations that the CMS, the MCP server and WebMCP call.
 * See README.md for the route the CMS uses and how to add a tool.
 */
export { SCOPES, ROLES, ROLE_SCOPES, ToolError, defineTool, defineSharedTool, notFound, type Actor, type AnyTool, type DataScope, type Role, type Scope, type Tool, type ToolContext, type ToolErrorCode } from './tool';
export { dispatch, describeTools, effectiveScopes, permits, redact, type Caller, type DispatchResult } from './dispatch';
export { platformRegistry, PLATFORM_TOOLS, registry, TOOLS } from './registry';
export { baseBlobKey, manifestKey, orgBlobKey, uploadKey } from './r2';
export { r2Presigner, type R2PresignConfig, type UploadSigner } from './upload';
export { MAX_RENDITION_BYTES, UPLOAD_URL_SECONDS, type AssetView, type RenditionView } from './assets';
export type { ScreenView, CredentialView } from './screens';
export type { GroupView } from './groups';
export type { StoredCheckReport, TemplateVersionView, TemplateView } from './templates';
