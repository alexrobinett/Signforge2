/**
 * `@signforge/tools`: one registry of operations that the CMS, the MCP server and WebMCP call.
 * See README.md for the route the CMS uses and how to add a tool.
 */
export {
  AGENT_LIMITS,
  SCOPES,
  ROLES,
  ROLE_SCOPES,
  ToolError,
  defineTool,
  defineSharedTool,
  notFound,
  type Actor,
  type AgentAllowance,
  type AgentLimit,
  type AgentLimiter,
  type AgentLimitWindow,
  type AlertDeliverer,
  type AlertSecretSealer,
  type AnyTool,
  type Connectors,
  type DataScope,
  type FeedUrlSealer,
  type Place,
  type PlaceFinder,
  type TableReader,
  type TemplateChecker,
  type Role,
  type Scope,
  type RateLimitBucket,
  type RateLimiter,
  type ScreenNotifier,
  type ServiceName,
  type Tool,
  type ToolContext,
  type ToolServices,
} from './tool';
export { dispatch, describeTools, effectiveScopes, grantOf, permits, redact, type Caller, type DispatchResult, type Grant } from './dispatch';
export { setOutputChecks } from './output';
export { ALERT_RETRY_MS, type AlertEvent } from './alert-channels';
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './paging';
export { platformRegistry, PLATFORM_TOOLS, registry, TOOLS } from './registry';
export { baseBlobKey, manifestKey, orgBlobKey, uploadKey } from './r2';
export { r2Presigner, type R2PresignConfig, type UploadSigner } from './upload';
export { MAX_RENDITION_BYTES, UPLOAD_URL_SECONDS } from './assets';
export { IDENTIFY_SECONDS, liveOverride, OVERRIDE_LIMIT_MS } from './screens';
export { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from './pairing';
export { kitColors, type StoredColors } from './brand';
export type { StoredCheckReport } from './templates';
export type {
  AssetView,
  Audience,
  BrandKitView,
  CredentialView,
  GroupView,
  RenditionView,
  ScreenView,
  SpotView,
  TemplateVersionView,
  TemplateView,
  ToolErrorCode,
} from './outputs';
export {
  compileInputFor,
  loadCompileInput,
  loadOrg,
  probeDrafts,
  promoteDrafts,
  previewInput,
  publishOrg,
  spotDraft,
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
export { orgSettings } from './settings';
export { madeBySpotEditor } from './data-sources';
