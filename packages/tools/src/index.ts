/**
 * `@signforge/tools`: one registry of operations that the CMS, the MCP server and WebMCP call.
 * See README.md for the route the CMS uses and how to add a tool.
 */
export {
  AGENT_LIMITS,
  CMS_AGENT_CLIENT_ID,
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
  type AgentCallLog,
  type AgentLimiter,
  type AgentLimitWindow,
  type AiKey,
  type AiProviders,
  type AiProviderTest,
  type AlertDeliverer,
  type AlertSecretSealer,
  type AnyTool,
  type Connectors,
  type CursorSealer,
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
export { type ClientRedirect, destinationOf, plainName, shownClient, shownClientName } from './agent-clients';
export { grantClient } from './agent-grants';
export {
  dispatch,
  refusedPress,
  describeTools,
  ListedInput,
  effectiveScopes,
  grantOf,
  overLimit,
  permits,
  redact,
  sha256Hex,
  type Caller,
  type DispatchResult,
  type Grant,
} from './dispatch';
export { setOutputChecks } from './output';
export { ALERT_RETRY_MS, type AlertEvent } from './alert-channels';
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './paging';
export { agentOutput, platformRegistry, PLATFORM_TOOLS, registry, TOOLS } from './registry';
export { describeInput, isReadType, READ_TOOLS, READ_TYPES, type ReadType, readDescription, readInput, readTypes, servedByRead, toolsOf } from './read';
export { baseBlobKey, manifestKey, orgBlobKey, uploadKey } from './r2';
export { r2Presigner, type R2PresignConfig, type UploadSigner } from './upload';
export { MAX_RENDITION_BYTES, UPLOAD_URL_SECONDS } from './assets';
export { IDENTIFY_SECONDS, liveOverride, OVERRIDE_LIMIT_MS } from './screens';
export { entryToDelete, entryView } from './schedule';
export { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from './pairing';
export { kitColors, type StoredColors } from './brand';
export type { StoredCheckReport } from './templates';
export { AI_PROVIDERS, AUDIENCE_ROLES } from './outputs';
export { approves } from './publish-requests';
export type {
  AgentCall,
  AgentUsage,
  AiProviderName,
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
  dryPublish,
  publishOrg,
  spotDraft,
  type DraftKind,
  type DraftPin,
  type SampleAck,
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
export { tally } from './rollout';
export { orgSettings } from './settings';
export { madeBySpotEditor, reachesScreens, saveDataSourceInput, sourceRefusal } from './data-sources';
