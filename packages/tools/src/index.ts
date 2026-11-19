/**
 * `@signforge/tools`: one registry of operations that the CMS, the MCP server and WebMCP call.
 * See README.md for the route the CMS uses and how to add a tool.
 */
export {
  SCOPES,
  ROLES,
  ROLE_SCOPES,
  ToolError,
  defineTool,
  defineSharedTool,
  notFound,
  type Actor,
  type AnyTool,
  type DataScope,
  type FeedUrlSealer,
  type TemplateChecker,
  type Role,
  type Scope,
  type RateLimitBucket,
  type RateLimiter,
  type ScreenNotifier,
  type Tool,
  type ToolContext,
  type ToolErrorCode,
} from './tool';
export { dispatch, describeTools, effectiveScopes, grantOf, permits, redact, type Caller, type DispatchResult, type Grant } from './dispatch';
export { setOutputChecks } from './output';
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './paging';
export { platformRegistry, PLATFORM_TOOLS, registry, TOOLS } from './registry';
export { baseBlobKey, manifestKey, orgBlobKey, uploadKey } from './r2';
export { r2Presigner, type R2PresignConfig, type UploadSigner } from './upload';
export { MAX_RENDITION_BYTES, UPLOAD_URL_SECONDS, type AssetView, type RenditionView } from './assets';
export { IDENTIFY_SECONDS, liveOverride, OVERRIDE_LIMIT_MS, type ScreenView, type CredentialView } from './screens';
export { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from './pairing';
export type { GroupView } from './groups';
export type { SpotView } from './spots';
export { kitColors, type BrandKitView, type StoredColors } from './brand';
export type { StoredCheckReport, TemplateVersionView, TemplateView } from './templates';
export {
  compileInputFor,
  loadCompileInput,
  loadOrg,
  promoteDrafts,
  previewInput,
  publishOrg,
  type DraftKind,
  type DraftReport,
  type OrgGraph,
  type PreviewInput,
  type ScreenPublish,
} from './publishing';
export { parseHeartbeat, type ScreenHeartbeat } from './heartbeat';
export {
  NEEDS_YOU_REASONS,
  screenState,
  shouldBeShowing,
  STATE_KINDS,
  UNREACHABLE_AFTER_MS,
  type NeedsYouReason,
  type ScreenState,
  type ShouldBeShowing,
  type StateInput,
  type StateKind,
} from './screen-state';
export { orgSettings, type Audience } from './settings';
