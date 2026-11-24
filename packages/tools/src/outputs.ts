/**
 * What every tool answers: its output schema, by tool name (`outputs`), and the codes it refuses
 * with. Each tool's `output` is its entry here (test/conventions.test.ts), so a caller that types
 * its calls from these types reads exactly what the tools return: the CMS does, from the browser
 * and from its server functions (`@signforge/tools/outputs`, types only).
 *
 * It imports zod, the contract, the compiler's types (`get_spot_preview`'s preview) and, through
 * ./screen-state's state names, player-core: no Workers types and nothing a handler needs, so the
 * CMS's DOM typecheck loads it, which it cannot do with the tool files. A schema a tool also takes
 * as input (a transition, a table mapping) lives here too, and the tool imports it.
 */
import { BRAND_SHAPES, SCREEN_KINDS, TABLE_ROWS_PATH, TEMPLATE_CHECKS, type DisplayHours, type TemplateManifest } from '@signforge/contract';
import type { CompileInput } from '@signforge/compiler';
import { z } from 'zod';
import { displayHours, draftOutput, orientation, version } from './fields';
import { NEEDS_YOU_REASONS, STATE_KINDS } from './screen-state';

/** What a caller's grant allows. Sessions get every scope their role allows; an agent's OAuth grant names its own (Milestone 4). */
export const SCOPES = ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage'] as const;

/** Why a tool refused: the `error` of its answer, next to `message` and, for some, `details`. */
export type ToolErrorCode = 'unknown_tool' | 'forbidden' | 'invalid_input' | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable' | 'sample_text';

/** The output field a list tool adds (./paging.ts). */
const nextOutput = z.string().nullable().describe('Pass as cursor to get the next page; null on the last page');

// ------------------------------------------------------------------ screens

const displayOverrideOutput = z.object({ state: z.enum(['on', 'off']), until: z.string().describe('ISO 8601; the override ends by itself then') });

/** A screen as tools return it. Times are milliseconds since the epoch. */
export const screenOutput = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  locale: z.string().nullable(),
  orientation,
  kind: z.enum(SCREEN_KINDS).describe('device, or browser: a test screen in a browser tab, which has no panel to power'),
  displayHours: displayHours.nullable().describe('Null means always on'),
  labels: z.record(z.string(), z.string()).describe('Its key=value labels, values as typed; set them with update_screen_labels'),
  systemLabels: z
    .record(z.string(), z.string())
    .describe('Labels from its settings, read-only: orientation, kind, timezone and locale (absent with no locale). Selectors match them as labels'),
  status: z.enum(['active', 'revoked']).describe('Revoked once every credential the screen had is revoked'),
  desiredManifestId: z.string().nullable().describe('The manifest the screen should play'),
  previousManifestId: z.string().nullable().describe('The one before it, kept while the screen switches'),
  reportedManifestId: z.string().nullable().describe('The manifest the screen last said it is playing'),
  lastSeenAt: z.number().nullable(),
  playerVersion: z.string().nullable(),
  displayOverride: displayOverrideOutput.nullable().describe('A wake now or sleep now in force, set with set_display_override'),
  state: z
    .object({
      kind: z.enum(STATE_KINDS),
      reason: z
        .enum(NEEDS_YOU_REASONS)
        .nullable()
        .describe('Why it needs a person: behind on a publish, revoked, nothing published, or fallen back from a manifest that played nothing'),
      wakesAt: z.string().nullable().describe('Asleep: when it wakes'),
      filesMissing: z.number().nullable().describe('Updating: files still to fetch'),
    })
    .describe('What the screen is doing, as a fact. Unreachable while on the latest version is calm: the screen keeps playing it from its cache'),
  heartbeat: z
    .object({
      at: z.number(),
      playerVersion: z.string(),
      activeManifestId: z.string().nullable(),
      filesMissing: z.number(),
      fallbackFrom: z.string().nullable().describe('A newer manifest that played nothing, so the screen went back to its last good one'),
      displayOn: z.boolean(),
      clockTrusted: z.boolean(),
      driftMs: z.number(),
    })
    .nullable()
    .describe("The screen's last sync; null until it first syncs"),
  showing: z
    .object({
      asleep: z.boolean(),
      wakesAt: z.string().nullable(),
      playlist: z.object({ id: z.string(), name: z.string() }).nullable(),
      takeover: z.boolean().describe('Whether a takeover plays that playlist'),
      spot: z
        .object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(['template', 'image', 'video', 'url']),
          template: z.string().nullable(),
          templateName: z.string().nullable().describe("The template's name, as people see it; null for a spot that is not a template"),
          image: z.string().nullable().describe('SHA-256 of an image the spot shows, for a thumbnail (GET /api/blobs/v2/:sha256)'),
        })
        .nullable()
        .describe("The playlist's first spot"),
      spots: z.number(),
    })
    .nullable()
    .describe('What the screen should be showing now, worked out from its desired manifest as the player does; null when nothing is published'),
  version: version.describe('Moves on when its name or settings change (not with heartbeats or publishes); pass it as ifVersion to update only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ScreenView = z.infer<typeof screenOutput>;

/** What the fleet poll returns of a screen: what it is doing, without its settings or what it should be showing. */
const screenStatusOutput = screenOutput.pick({ id: true, state: true, lastSeenAt: true, desiredManifestId: true, reportedManifestId: true });

/** A credential, without its hash. */
const credentialOutput = z.object({ id: z.string(), createdAt: z.number(), lastUsedAt: z.number().nullable(), revokedAt: z.number().nullable() });
export type CredentialView = z.infer<typeof credentialOutput>;

// ------------------------------------------------------------------ groups

const groupOutput = z.object({
  id: z.string(),
  name: z.string(),
  screenIds: z.array(z.string()).describe('The screens in the group, ordered by id'),
  version: version.describe('Moves on when the name or the screens change; pass it as ifVersion to update only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GroupView = z.infer<typeof groupOutput>;
const groupResult = z.object({ group: groupOutput });

// ------------------------------------------------------------------ publishes

export const DRAFT_KINDS = ['spot', 'playlist', 'schedule_entry'] as const;
export const draftRef = z.object({ kind: z.enum(DRAFT_KINDS), id: z.string() });

const madeOutput = z
  .object({
    id: z.string(),
    revision: z.number().int().describe('The publish number people see, v1, v2, …: the org has one sequence'),
    screens: z.number().int().describe('Screens it switched'),
    previousId: z.string().nullable().describe('The publish before it: roll back to it (roll_back_publish) to undo this one; null for the first'),
  })
  .nullable()
  .describe('The publish made, or null when nothing changed: then nothing was written and no screen was touched');

const publishResult = z.object({
  publish: madeOutput,
  promoted: z.array(draftRef).describe('Drafts this publish made live'),
  held: z.array(draftRef.extend({ problems: z.array(z.string()) })).describe('Drafts that failed their checks and keep their published version'),
  removed: z.array(draftRef).describe('Schedule entries deleted with this publish: deletions it applied, and takeovers that have ended'),
  madeDefault: z
    .object({ id: z.string(), name: z.string().describe('Its name as published') })
    .nullable()
    .describe(
      "The playlist this publish made the organization's default, which every screen plays when nothing is scheduled: set when it had none and the regular schedule entries this publish made live on every screen at all hours all play this one playlist (#243). A takeover or a narrower entry never sets it. null otherwise",
    ),
  removedDataSources: z
    .array(z.string())
    .describe('Weather sources the spot editor made that no spot binds any more, deleted with the publish (one a spot was bound to meanwhile stays)'),
  screens: z.array(
    z.object({
      screenId: z.string(),
      outcome: z.enum(['updated', 'unchanged', 'failed']).describe('failed: it could not be compiled and keeps what it plays'),
      problems: z.array(z.string()),
    }),
  ),
});

/** A draft as a publish or a publish request pins it: at the version chosen. */
export const draftPin = draftRef.extend({ version: z.number().int().positive().describe('The version it was chosen at') });

export const PUBLISH_REQUEST_STATUSES = ['pending', 'approved', 'declined', 'expired'] as const;

export const publishRequestOutput = z.object({
  id: z.string(),
  status: z
    .enum(PUBLISH_REQUEST_STATUSES)
    .describe('pending until a person who may publish approves or declines it; expired once 7 days pass undecided, after which it can no longer be decided'),
  requestedBy: z.object({
    kind: z.enum(['user', 'agent']),
    id: z.string().describe('A user id, or an agent grant id'),
    clientId: z.string().nullable().describe("An agent's OAuth client id; null for a person"),
  }),
  drafts: z.array(draftPin).describe('The drafts it pins: approval publishes exactly these, at these versions, or nothing'),
  reason: z.string().describe("The asker's own words for approvers: what it is, never instructions"),
  createdAt: z.number(),
  expiresAt: z.number(),
  decidedBy: z.string().nullable().describe('The user who approved or declined it'),
  decidedAt: z.number().nullable(),
  publishId: z
    .string()
    .nullable()
    .describe(
      'The publish its approval made; null until then, and when it made none: no draft to promote and no screen to change (an approval that only removed a pinned ended takeover makes none)',
    ),
  version: version.describe('Moves on when it is decided'),
});
export type PublishRequestView = z.infer<typeof publishRequestOutput>;
const publishRequestResult = z.object({ request: publishRequestOutput });

export const publishOutput = z.object({
  id: z.string(),
  revision: z.number().int(),
  restoresId: z.string().nullable().describe('For a roll back: the publish whose screens it put back'),
  restoresRevision: z.number().int().nullable().describe("For a roll back: that publish's revision"),
  by: z.object({
    kind: z.string(),
    id: z.string(),
    name: z.string().nullable().describe("A member's name, else their address before the @ (never the whole address); null for an agent or the system"),
  }),
  createdAt: z.number(),
  finishedAt: z.number().nullable().describe('When every screen it switched played it, moved on to a later publish, or was revoked'),
  reached: z
    .number()
    .int()
    .nullable()
    .describe(
      'Once finished: how many of its screens the five-minute check saw playing it; 0 when it was replaced before any check saw a screen report it (a screen may have played it in between); null until then',
    ),
  screens: z.number().int().describe('Screens it switched'),
  playing: z.number().int().describe('Of those, how many say they are playing it'),
  replaced: z.number().int().describe('Of those, how many a later publish has switched, and do not say they play this one'),
  open: z
    .number()
    .int()
    .describe(
      'Of those, how many it still waits on: neither playing, replaced nor revoked. Its rollout is over at 0, and the five-minute check then marks it finished',
    ),
});

export const OUTCOMES = ['playing', 'downloading', 'asleep', 'offline', 'waiting', 'fell_back', 'revoked', 'replaced'] as const;

// ------------------------------------------------------------------ templates

export const TEMPLATE_STATUSES = ['draft', 'approved', 'retired'] as const;

/**
 * A built `template.json`. Checked loosely: the contract has no runtime schema for it yet (M3-31);
 * `checkTemplateBundle` checked it in full when the version was registered.
 */
const manifestOutput = z
  .custom<TemplateManifest>(
    (v) =>
      z
        .looseObject({ id: z.string(), version: z.string(), name: z.string(), fields: z.record(z.string(), z.unknown()), orientations: z.array(z.string()) })
        .safeParse(v).success,
    'not a template manifest',
  )
  .describe("The template's template.json, as built: id, version, name, fields, duration, orientations, uses, background");

/** What is stored on a version: the contract's report, plus when it ran and on which sources. */
const checkReportOutput = z.object({
  ok: z.boolean(),
  bundleBytes: z.number(),
  checks: z.array(z.object({ check: z.enum(TEMPLATE_CHECKS), ok: z.boolean(), problems: z.array(z.string()) })),
  warnings: z.array(z.string()).optional().describe('Findings that do not stop the version: colour literals outside a var(--sf-*) fallback'),
  runtime: z
    .object({
      ok: z.boolean(),
      problems: z.array(z.string()),
      runner: z.object({ image: z.string(), browser: z.string() }),
      renders: z.array(
        z.object({
          orientation: z.enum(['landscape', 'portrait']),
          viewport: z.object({ width: z.number(), height: z.number() }),
          readyMs: z.number().nullable(),
          frames: z.object({ count: z.number(), longestMs: z.number() }).nullable(),
        }),
      ),
      cost: z.object({ startMs: z.number(), checkMs: z.number() }),
    })
    .optional()
    .describe(
      "The runtime check: the bundle rendered headless in the player's sandbox, with no network, in each orientation; ms to ready and the first second's frames per render. Org versions only",
    ),
  checkedAt: z.number(),
  sourcesSha256: z.string(),
});

export const versionOutput = z.object({
  id: z.string(),
  templateId: z.string(),
  key: z.string().describe('How manifests and spots name it: <owner>/<id>@<version>'),
  version: z.string(),
  status: z.enum(TEMPLATE_STATUSES),
  manifest: manifestOutput,
  bundleSha256: z.string(),
  checkReport: checkReportOutput.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TemplateVersionView = z.infer<typeof versionOutput>;

const templateOutput = z.object({
  id: z.string(),
  owner: z.enum(['base', 'org']).describe("base for the platform's templates, every org's to use; org for the org's own"),
  key: z.string().describe('The id in its template.json, such as menu-board'),
  name: z.string(),
  versions: z.array(versionOutput).describe('Oldest first'),
});
export type TemplateView = z.infer<typeof templateOutput>;

// ------------------------------------------------------------------ assets

export const ORIENTATIONS = ['landscape', 'portrait'] as const;
export const ASSET_STATUSES = ['pending', 'verified', 'rejected'] as const;

const renditionOutput = z.object({
  orientation: z.enum(ORIENTATIONS),
  sha256: z.string(),
  type: z.string(),
  size: z.number(),
  width: z.number().nullable().describe('Null for SVG'),
  height: z.number().nullable().describe('Null for SVG'),
  sample: z
    .object({ sha256: z.string(), size: z.number() })
    .nullable()
    .describe('Its sample, a PNG of its darkest and lightest pixel per 16 px cell; null for SVG, an image with transparency, or one uploaded before samples'),
});
export type RenditionView = z.infer<typeof renditionOutput>;

export const assetOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['image', 'video']),
  status: z.enum(ASSET_STATUSES).describe('pending until finalize_asset checks the upload; only verified assets may be used'),
  sha256: z.string().describe("The landscape rendition's, as are type, size, width and height"),
  type: z.string(),
  size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable().describe("A video's length; null for an image"),
  renditions: z.array(renditionOutput),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AssetView = z.infer<typeof assetOutput>;

const uploadOutput = z.object({
  asset: assetOutput,
  uploads: z
    .array(z.object({ sha256: z.string(), method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.number() }))
    .describe('One per file the server does not already hold'),
});

// ------------------------------------------------------------------ videos

export const VIDEO_TYPES = ['video/mp4'] as const;

const partOutput = z.object({ partNumber: z.number(), method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), size: z.number() });

// ------------------------------------------------------------------ brand kits

export const brandShape = z.enum(BRAND_SHAPES).describe('Corner radius scale');

const fontOutput = z.object({
  id: z.string(),
  family: z.string(),
  roles: z.array(z.enum(['display', 'body'])).describe('What it suits: headlines, running text, or both'),
  weights: z.array(z.number()),
  licence: z.object({ spdx: z.literal('OFL-1.1'), copyright: z.string(), source: z.string() }),
  available: z.boolean().describe('False until its files are added: a kit may choose it, and screens draw with the template font until then'),
});

const fontRef = z.object({ id: z.string(), family: z.string() }).nullable();

export const brandKitOutput = z.object({
  id: z.string(),
  name: z.string(),
  colors: z.object({
    primary: z.string(),
    onPrimary: z.string(),
    accent: z.string(),
    onAccent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
  }),
  derived: z.array(z.enum(['onPrimary', 'onAccent'])).describe('On-colours derived for contrast rather than set by hand'),
  shape: brandShape,
  displayFont: fontRef,
  bodyFont: fontRef,
  logo: z.object({ onDarkAssetId: z.string(), onLightAssetId: z.string().nullable() }).nullable(),
  isDefault: z.boolean(),
  groupIds: z.array(z.string()).describe('Groups that chose this kit'),
  screenIds: z.array(z.string()).describe('Screens that chose this kit themselves'),
  reach: z.array(z.string()).describe('Screens that get this kit at the next publish: where an edit to it will show'),
  conflicts: z
    .array(z.object({ screenId: z.string(), problem: z.string() }))
    .describe('Screens whose groups choose this kit and another, with no choice of their own: they cannot publish until one is chosen'),
  warnings: z.array(z.string()).describe('Colour pairs below 4.5:1 contrast. Warnings only'),
  version,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type BrandKitView = z.infer<typeof brandKitOutput>;
const kitResult = z.object({ brandKit: brandKitOutput });

// ------------------------------------------------------------------ data sources

export const TABLE_FORMATS = ['csv', 'json-table'] as const;
export const sourceFormat = z
  .enum(['json', 'ical', 'rss', ...TABLE_FORMATS, 'provider'])
  .describe(
    "json passes through; ical becomes a CalendarFeed, rss (RSS 2.0 or Atom) a NewsFeed, csv (with a header row) and json-table (a list of objects) a TableFeed; provider reads a resource through a connection, shaped by the connection's provider",
  );

export const dataSourceOutput = z.object({
  id: z.string(),
  name: z.string(),
  format: sourceFormat,
  connectionId: z.string().nullable().describe('A provider source: the connection it reads through'),
  refreshS: z.number(),
  horizonDays: z.number().nullable(),
  rowsPath: z.string().nullable().describe('A json-table source: the path to its list of objects; null for the whole document'),
  photos: z.boolean().describe("An rss source: whether screens get its stories' photos. Ignored for other formats"),
  nextPollAt: z.number(),
  failures: z.number().describe('Polls in a row that failed; the poller backs off, up to 6 hours'),
  lastError: z
    .string()
    .nullable()
    .describe('Why the last poll failed, as a category (timeout, http-status, private-address, ...; for a provider source needs-reconnect or disconnected)'),
  version: version.describe('Moves on when the source is changed (not with polls); pass it as ifVersion to update only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const dataSourceResult = z.object({ dataSource: dataSourceOutput });

const listedSourceOutput = dataSourceOutput.extend({
  lastCheckedAt: z.number().nullable().describe('When a poll last found the feed still saying it: its last good check'),
  spots: z.array(z.object({ id: z.string(), name: z.string() })).describe('The spots that bind it, as drafted or as published'),
});

const snapshotOutput = z
  .object({ id: z.string(), version: z.number(), fetchedAt: z.string(), checkedAt: z.string(), data: z.unknown() })
  .describe('The latest snapshot, as screens get it; null until a poll succeeds');

const placeOutput = z.object({
  id: z.number().describe("The geocoder's id for the place"),
  name: z.string(),
  region: z.string().describe("State or province, or ''"),
  country: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().describe('IANA time zone'),
});

// ------------------------------------------------------------------ connections

const connectionStatus = z
  .enum(['active', 'needs_reconnect', 'disconnected'])
  .describe(
    'needs_reconnect: the provider refused the grant (revoked or expired), so its sources fail until a person reconnects it; disconnected: its credentials are deleted',
  );

export const connectionOutput = z.object({
  id: z.string(),
  provider: z.string(),
  account: z.string().describe('The account, as the provider names it'),
  scopes: z.array(z.string()).describe('What the provider granted'),
  status: connectionStatus,
  expiresAt: z.number().nullable().describe('When the current access token runs out (the poller refreshes it before); null for one that does not'),
  lastError: z.string().nullable().describe('Why the provider last refused, as a category (invalid_grant, ...)'),
  createdBy: z.string().describe('The user who first connected it'),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ------------------------------------------------------------------ settings

/**
 * The alerts there are, each sent by email, to Slack and to the webhook as its rule says:
 * `screen_offline` and `publish_finished` by the API's checks, `agent_refused` by `/mcp` (M4-08),
 * `publish_requested` by `request_publish` (M4-09), its email only to members who may approve.
 */
export const ALERT_KINDS = ['screen_offline', 'publish_finished', 'agent_refused', 'publish_requested'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Who gets an alert: owners, owners and editors, or every member. */
export const AUDIENCES = ['owners', 'editors', 'everyone'] as const;
export type Audience = (typeof AUDIENCES)[number];
/** The roles each audience is. */
export const AUDIENCE_ROLES: Record<Audience, readonly ('owner' | 'editor' | 'viewer')[]> = {
  owners: ['owner'],
  editors: ['owner', 'editor'],
  everyone: ['owner', 'editor', 'viewer'],
};

/** Who gets the email, and which channels get it: `who` is for email only, as Slack and the webhook post to one place (#88). */
export const rule = z.object({
  who: z.enum(AUDIENCES).describe('Who gets it by email'),
  email: z.boolean().describe('Send it by email'),
  slack: z.boolean().describe("Post it to the org's Slack channel, if one is set (set_slack_alert_channel)"),
  webhook: z.boolean().describe("Send it to the org's webhook, if one is set (set_webhook_alert_channel)"),
});
export type AlertRule = z.output<typeof rule>;

export const editorsPublish = z.boolean().describe('Whether editors may publish to screens; when false, only owners publish');

/**
 * At least a month, so an owner cannot clear the record of what was just done; at most ten years,
 * so the log D1 holds stays bounded.
 */
export const auditRetentionDays = z
  .number()
  .int()
  .min(30)
  .max(3650)
  .describe('Days audit rows are kept before the daily job deletes them, 30 to 3650; 365 by default');

const settingsView = z.object({
  timezone: z.string().nullable().describe('Default time zone for new screens; null for none set'),
  locale: z.string().nullable().describe('Default locale for new screens; null for the player default'),
  displayHours: z.custom<DisplayHours>().nullable().describe('Default display hours for new screens; null for always on'),
  updateWindow: z.object({ from: z.string(), to: z.string() }),
  unreachableAfterMinutes: z.number(),
  editorsPublish,
  auditRetentionDays,
  alerts: z.object({ screen_offline: rule, publish_finished: rule, agent_refused: rule, publish_requested: rule }),
  version: version.describe('1 until first set, then moves on with every change; pass it as ifVersion to update only what you read'),
  updatedAt: z.number().nullable(),
});
export type SettingsView = z.output<typeof settingsView>;

// ------------------------------------------------------------------ alert channels

export const ALERT_CHANNEL_KINDS = ['slack', 'webhook'] as const;
export const ALERT_CHANNELS = ['email', ...ALERT_CHANNEL_KINDS] as const;

export const channelView = z.object({
  kind: z.enum(ALERT_CHANNEL_KINDS),
  host: z.string().describe('The host it posts to; the rest of the URL is sealed and never shown'),
  connectedBy: z.string().describe('Who set it last: a user id, or an agent grant id'),
  secretSetAt: z.number().nullable().describe('The webhook: when its signing secret was last set. Null for Slack'),
  version: version.describe('Moves on with every change; pass it as ifVersion to change only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ------------------------------------------------------------------ AI providers

/** The client id of the agent built into the CMS, which acts as the signed-in member (docs/proposals/cms-agent.md). */
export const CMS_AGENT_CLIENT_ID = 'cms-agent';
/** Its type, for the CMS, which imports only types from here: a constant of this type cannot drift from it. */
export type CmsAgentClientId = typeof CMS_AGENT_CLIENT_ID;

/** The model providers an org can bring its own key for: Anthropic (#261), and any OpenAI-compatible endpoint (#262). */
export const AI_PROVIDERS = ['anthropic', 'openai-compatible'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const aiProviderView = z.object({
  provider: z.enum(AI_PROVIDERS),
  baseUrl: z.string().nullable().describe("An OpenAI-compatible endpoint's base address; null for Anthropic"),
  supports: z
    .object({ images: z.boolean(), jsonSchema: z.boolean() })
    .describe(
      'Whether the provider takes images and returns output to a JSON schema, both of which Fill from a flyer needs: Anthropic does both; an endpoint, as its owner said',
    ),
  keyLast4: z.string().describe("The key's last four characters; the key itself is sealed and never shown"),
  keySavedBy: z.string().describe('The user who saved the key'),
  keySavedAt: z.number(),
  verifiedAt: z.number().nullable().describe('When a test last reached the provider with this key; null until one does'),
  fastModel: z.string().nullable().describe('The exact model id for fills from a flyer, photo or link'),
  capableModel: z.string().nullable().describe("The exact model id for the agent's drawer"),
  dailyTurnCeiling: z.number().nullable().describe('Agent turns a day across the org; null for no ceiling'),
  version: version.describe('Moves on with every change; pass it as ifVersion to change only what you read'),
});

export const deliveryView = z.object({
  id: z.string(),
  channel: z.enum(ALERT_CHANNELS),
  eventType: z.string().describe('screen.offline, screen.back, or test'),
  eventId: z.string().describe("The event's id, the same on every channel it went to"),
  status: z.enum(['pending', 'delivered', 'failed']).describe('failed: given up on, after 24 hours of retries (a test, after one try)'),
  attempts: z.number(),
  lastAttemptAt: z.number().nullable(),
  lastHttpStatus: z.number().nullable().describe("The receiver's HTTP status on the last attempt; null for no answer, or for email"),
  lastError: z.string().nullable().describe('Why the last attempt failed, as a category (http-status, timeout, private-address, ...)'),
  nextAttemptAt: z.number().nullable().describe('When it is tried next, while pending'),
  createdAt: z.number(),
});

// ------------------------------------------------------------------ spots

export const SPOT_KINDS = ['template', 'image', 'video', 'url'] as const;
export const SPOT_FITS = ['cover', 'contain'] as const;

const column = z.string().min(1).max(200);
export const tableMapping = z
  .object({
    columns: z.record(z.string(), column).describe('Item property to the column that fills it, such as { "name": "Item", "price": "Price" }'),
    filter: z
      .object({ column, equals: z.string().max(200) })
      .optional()
      .describe('Only rows whose cell in column is equals, ignoring case'),
    sort: z.object({ column, descending: z.boolean().optional() }).optional().describe("Rows in the order of a column; absent, the file's order"),
  })
  .describe(
    `A list field filled from a csv or json-table source's rows (path ${TABLE_ROWS_PATH}): each row an item, at most the field's maxItems. Properties left out take their defaults`,
  );

const spotOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(SPOT_KINDS),
  durationMs: z.number(),
  templateVersionId: z.string().nullable().describe('Template spots: the template version it plays'),
  data: z.record(z.string(), z.unknown()).nullable().describe('Template spots: field values by field name'),
  assets: z.record(z.string(), z.string()).nullable().describe('Template spots: image fields to asset ids'),
  bindings: z
    .record(z.string(), z.object({ dataSourceId: z.string(), path: z.string(), table: tableMapping.optional() }))
    .nullable()
    .describe('Template spots: fields bound to a data source, as update_spot takes them'),
  assetId: z.string().nullable().describe('Image and video spots'),
  fit: z.enum(SPOT_FITS).nullable().describe('Image and video spots'),
  url: z.string().nullable().describe('URL spots'),
  sampleFields: z
    .object({ texts: z.array(z.string()), lists: z.record(z.string(), z.array(z.array(z.string()))) })
    .nullable()
    .describe(
      "Template spots: the draft's fields still holding the template's sample copy that create_spot's sample started it with: texts by name, and each list's rows, the cells not edited yet. A saved edit of a field, or binding it, takes it out. publish refuses a spot with any (sample_text) unless a person allows it. null for none",
    ),
  version: version.describe('Moves on with every edit of the draft; pass it as ifVersion to update only what you read'),
  ...draftOutput,
});
export type SpotView = z.infer<typeof spotOutput>;
const spotResult = z.object({ spot: spotOutput });

// ------------------------------------------------------------------ playlists

const ms = z.number().int().min(1).max(10_000).describe('How long the transition takes, in ms');
export const transition = z
  .discriminatedUnion('type', [z.object({ type: z.literal('cut') }), z.object({ type: z.literal('fade'), ms }), z.object({ type: z.literal('crossfade'), ms })])
  .describe(
    'How one spot gives way to the next. cut: instant. fade: out to black, then in, one spot on screen at a time. crossfade: both spots on screen while one fades over the other, which doubles the GPU work for its length (about 10% dropped frames on a Raspberry Pi 4)',
  );

const playlistOutput = z.object({
  id: z.string(),
  name: z.string(),
  transition,
  spotIds: z.array(z.string()).describe('The spots in play order'),
  version: version.describe('Moves on with every edit of the draft, its spots too; pass it as ifVersion to update only what you read'),
  isDefault: z.boolean().describe('Whether it is the default playlist: what every screen plays when no schedule entry says otherwise'),
  ...draftOutput,
});
export type PlaylistView = z.infer<typeof playlistOutput>;
const playlistResult = z.object({ playlist: playlistOutput });

/** A Reject or its Undo (#116): the draft as it is now, and whether an agent's draft is set aside beside it. */
const rejected = z.boolean().describe("true: an agent's draft is set aside, and the same call again puts it back (its Undo); false: it was put back");

const agentDraftOutput = z.object({
  kind: z.enum(['spot', 'playlist']),
  id: z.string(),
  version: version.describe("The draft's version: Reject and Keep take it as ifVersion"),
  proposed: z.boolean().describe("The draft is an agent's proposal: an agent wrote it over the person's draft, kept beside it"),
  by: z
    .object({
      kind: z.enum(['mcp', 'drawer']).describe("An agent over /mcp, or the CMS's agent drawer"),
      id: z.string().describe('The agent grant, or for the drawer the member who saved it'),
      clientId: z.string().nullable(),
      name: z.string().nullable().describe("The agent's client name as a page shows it, or the member's; null when not to be shown"),
      at: z.number().describe('When it last wrote the draft'),
    })
    .nullable()
    .describe("Who proposed it, from the audit log's newest row of an agent writing it; null when not proposed, or the log no longer has it"),
  rejected: z.boolean().describe("A Reject set an agent's draft aside: the same revert call puts it back"),
  publishedVersion: z.number().nullable().describe('The version screens have; null if never published'),
  changes: z
    .array(
      z.object({
        field: z.string(),
        in: z.enum(['data', 'assets', 'bindings']).nullable().describe("A template spot's field, by where it is; null for the spot's or playlist's own (name, durationMs, url, transition, items…)"),
        was: z.unknown().describe('As published'),
        now: z.unknown().describe('As drafted'),
      }),
    )
    .describe('What the draft changes against its published version; empty if never published'),
});

// ------------------------------------------------------------------ schedule

export const scheduleTarget = z
  .enum(['org', 'group', 'screen'])
  .describe('Whom it is aimed at: org (every screen), group (groupId), screen (screenId). Of equal priority, the more specific wins');

export const fieldsOutput = z.object({
  playlistId: z.string(),
  target: scheduleTarget,
  groupId: z.string().nullable(),
  screenId: z.string().nullable(),
  priority: z.number().int(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  days: z.array(z.number().int()).nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  startsAt: z.string().nullable().describe("A takeover's start, ISO 8601"),
  endsAt: z.string().nullable().describe("A takeover's end, ISO 8601"),
  takeover: z.boolean().describe('Whether it is a takeover (start_takeover)'),
});
export const entryOutput = z.object({
  id: z.string(),
  ...fieldsOutput.shape,
  deleted: z.boolean().describe('Deleted, waiting for a publish to take it off screens: they keep the published version until then'),
  live: fieldsOutput.nullable().describe('The published version, what screens play; null if it was never published'),
  version: version.describe('Moves on with every edit of the draft; pass it as ifVersion to update only what you read'),
  ...draftOutput,
});
const entryResult = z.object({ entry: entryOutput });

// ------------------------------------------------------------------ audit

export const ACTOR_KINDS = ['user', 'agent', 'device', 'system'] as const;

const auditEntryOutput = z.object({
  at: z.number().describe('When, in ms since the epoch'),
  actor: z.object({
    kind: z.enum(ACTOR_KINDS).describe('user is a member, agent an agent grant, device a screen, system SignForge itself or sf push'),
    id: z.string().describe("The member's user id, the grant's id, the screen's id, or the system's name"),
    clientId: z.string().nullable().describe('The app it acted through: cms, sf-push, or an agent’s OAuth client'),
  }),
  action: z.string().describe('The tool called, or the membership change (invite_member, ...), or rate_limited for an agent over its limits'),
  target: z.object({ kind: z.string(), id: z.string() }).nullable().describe('What was changed; null when nothing one thing was'),
  detail: z
    .record(z.string(), z.unknown())
    .describe('What was recorded: for a tool, { input } with secrets redacted, and { refused } when it was refused but changed something'),
});

// ------------------------------------------------------------------ every tool's output

/**
 * A member's role: `ROLES` in ./tool.ts, written out because this file reaches no module that
 * imports `@signforge/db` (the CMS types its calls by it). test/members.test.ts holds the two equal.
 */
const roleOutput = z.enum(['viewer', 'editor', 'owner']);
const memberOutput = z.object({
  id: z.string().describe("The membership's id: pass it as memberId"),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleOutput,
  createdAt: z.string().describe('ISO 8601'),
});
const invitationOutput = z.object({
  id: z.string(),
  email: z.string(),
  role: roleOutput,
  status: z.literal('pending'),
  expiresAt: z.string().describe('ISO 8601; after it the invitation can no longer be accepted'),
  inviterId: z.string().describe("The inviting member's user id"),
  createdAt: z.string().describe('ISO 8601'),
});

// ------------------------------------------------------------------ agent grants (M4-07)

/** An agent's OAuth client as a page may name it (`shownClient`, ./agent-clients.ts). */
const agentClientOutput = z.object({
  id: z.string().describe('Its OAuth client id'),
  name: z
    .string()
    .nullable()
    .describe(
      "Its name as it registered it, a claim of its own; null when a page may not show it (not plain ASCII, or it reads as SignForge's): name it an unverified app at its redirect",
    ),
  verified: z.boolean().describe("SignForge's own app (the sf CLI); every other client named itself"),
  redirect: z.union([
    z.object({ kind: z.literal('web'), host: z.string().describe('The host its code goes to') }),
    z.object({
      kind: z.literal('app'),
      target: z.string().nullable().describe("An app's own scheme (com.example.app:); null when it is not plain, as for a name"),
    }),
  ]),
});

/** An agent grant as the grant tools return it. Times are milliseconds since the epoch. */
const agentGrantOutput = z.object({
  id: z.string().describe('The grant id: the agent actor id in the audit log'),
  client: agentClientOutput,
  scopes: z.array(z.enum(SCOPES)).describe('What it may do, as granted; each call is capped again by the role of the member it acts as'),
  grantedBy: z.string().describe('The user id of the member who granted it: the agent acts as them, in this organization only'),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable().describe('When it last called /mcp, to within the hour (written at most hourly); null if never'),
  expiresAt: z.number().describe('Unused until then, it stops working: 90 days from its last use'),
  version,
});
export type AgentGrantView = z.infer<typeof agentGrantOutput>;

/** One call an agent made over /mcp (M4-08), as recorded: what was called and how it ended, never its input, output or message. */
export const agentCallOutput = z.object({
  at: z.number().describe('When, in ms since the epoch'),
  tool: z.string().describe('The tool called, as the agent named it; tools/list for a listing'),
  result: z
    .string()
    .describe("'ok', a refusal's code (forbidden, invalid_input, not_found, conflict, rate_limited, unavailable, unknown_tool), or 'error' for a fault"),
  change: z.boolean().describe('Whether the tool changes data (its changes are in the audit log)'),
  needs: z.string().nullable().describe('The scope the tool needs; null for a name that is no tool, or tools/list'),
  target: z.object({ kind: z.string(), id: z.string() }).nullable().describe("A change's target: the audit log's rows for it are under this"),
});
export type AgentCall = z.infer<typeof agentCallOutput>;

/** A grant's calls over a period (M4-08). */
export const agentUsageOutput = z.object({
  grantId: z.string(),
  calls: z.number().int().describe('Every call, tools/list and refusals included'),
  changes: z.number().int().describe('Calls that changed data'),
  drafts: z.number().int().describe('Changes to drafts: calls under content:draft that changed data'),
  refusals: z.number().int().describe('Calls refused, for any reason'),
});
export type AgentUsage = z.infer<typeof agentUsageOutput>;

export const outputs = {
  list_screens: z.object({ screens: z.array(screenOutput), next: nextOutput }),
  list_screen_status: z.object({ screens: z.array(screenStatusOutput), next: nextOutput }),
  get_screen: z.object({
    screen: screenOutput,
    groupIds: z.array(z.string()),
    credentials: z.array(credentialOutput),
    events: z.array(
      z.object({
        at: z.number(),
        action: z.string().describe('The tool that made the change'),
        actor: z.object({ kind: z.string(), id: z.string() }),
        input: z.record(z.string(), z.unknown()).describe('What the tool was given, secrets redacted'),
      }),
    ),
  }),
  rename_screen: z.object({ screen: screenOutput }),
  update_screen_settings: z.object({ screen: screenOutput }),
  set_display_override: z.object({ screen: screenOutput }),
  identify_screen: z.object({ screenId: z.string(), seconds: z.number() }),
  restart_screen: z.object({ screenId: z.string() }),
  revoke_screen_credential: z.object({ credential: credentialOutput }),
  claim_screen: z.object({ screen: screenOutput }),
  update_screen_labels: z.object({
    screens: z.array(z.object({ id: z.string(), labels: z.record(z.string(), z.string()).describe('Its labels after the change') })),
  }),
  list_label_keys: z.object({
    keys: z.array(
      z.object({
        key: z.string(),
        system: z.boolean().describe("A system label, from each screen's settings: read-only"),
        screens: z.number().int().describe('Screens with the key'),
        values: z.array(z.object({ value: z.string().describe('As most screens spell it'), screens: z.number().int() })),
      }),
    ),
    next: nextOutput,
  }),
  list_groups: z.object({ groups: z.array(groupOutput), next: nextOutput }),
  create_group: groupResult,
  rename_group: groupResult,
  delete_group: z.object({ deleted: z.string().describe("The deleted group's id") }),
  set_group_members: groupResult,
  add_group_members: groupResult,
  remove_group_members: groupResult,
  publish_manifest_to_screen: z.object({
    screenId: z.string(),
    manifestId: z.string(),
    changed: z.boolean().describe('False if it was already the desired manifest'),
  }),
  publish: publishResult,
  end_takeover: publishResult,
  publish_takeover: publishResult.extend({ entry: entryOutput.describe('The takeover, as published') }),
  request_publish: publishRequestResult,
  list_publish_requests: z.object({ requests: z.array(publishRequestOutput), next: nextOutput }),
  get_publish_request: publishRequestResult,
  approve_publish_request: z.object({ request: publishRequestOutput, published: publishResult.describe('What the approval published, as publish returns it') }),
  decline_publish_request: publishRequestResult,
  roll_back_publish: z.object({ publish: madeOutput }),
  list_publishes: z.object({ publishes: z.array(publishOutput), next: nextOutput }),
  count_drafts: z.object({ spots: z.number(), playlists: z.number(), scheduleEntries: z.number() }),
  get_publish: z.object({
    publish: publishOutput.nullable(),
    screens: z.array(
      z.object({
        screenId: z.string(),
        name: z.string(),
        manifestId: z.string().describe('The manifest this publish gave it'),
        outcome: z.enum(OUTCOMES),
        filesMissing: z.number().nullable().describe('downloading: files it has still to fetch'),
        wakesAt: z.string().nullable().describe('asleep: when it wakes'),
        lastSeenAt: z.number().nullable(),
      }),
    ),
  }),
  list_templates: z.object({ templates: z.array(templateOutput), next: nextOutput }),
  get_template: z.object({ template: templateOutput }),
  register_template_version: z.object({ template: templateOutput, version: versionOutput, changed: z.boolean() }),
  set_template_version_status: z.object({ version: versionOutput, changed: z.boolean() }),
  list_assets: z.object({ assets: z.array(assetOutput.extend({ usageCount: z.number().describe('How many spots use it') })), next: nextOutput }),
  get_asset: z.object({ asset: assetOutput, spotIds: z.array(z.string()) }),
  create_asset_upload: uploadOutput,
  renew_asset_upload: uploadOutput,
  finalize_asset: z.object({ asset: assetOutput, changed: z.boolean() }),
  delete_asset: z.object({ deleted: z.string().describe("The deleted asset's id") }),
  create_video_upload: z.object({
    asset: assetOutput,
    upload: z
      .object({ uploadId: z.string(), partBytes: z.number(), parts: z.array(partOutput), expiresAt: z.number() })
      .nullable()
      .describe('Null when the org already holds the file'),
  }),
  finalize_video_upload: z.object({ asset: assetOutput, changed: z.boolean() }),
  list_fonts: z.object({ fonts: z.array(fontOutput), next: nextOutput }),
  list_brand_kits: z.object({ brandKits: z.array(brandKitOutput), next: nextOutput }),
  get_brand_kit: kitResult,
  create_brand_kit: kitResult,
  update_brand_kit: kitResult,
  set_default_brand_kit: kitResult,
  assign_brand_kit: z.object({ brandKit: brandKitOutput.nullable() }),
  list_data_sources: z.object({ dataSources: z.array(listedSourceOutput), next: nextOutput }),
  get_data_source: z.object({ dataSource: dataSourceOutput, snapshot: snapshotOutput.nullable() }),
  create_data_source: dataSourceResult,
  update_data_source: dataSourceResult,
  delete_data_source: z.object({ deleted: z.string().describe("The deleted data source's id") }),
  find_places: z.object({ places: z.array(placeOutput) }),
  read_table: z.object({
    table: z
      .object({ columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))) })
      .describe('The TableFeed a snapshot would hold'),
  }),
  list_connections: z.object({
    connections: z.array(connectionOutput),
    providers: z.array(z.string()).describe('The providers start_connection takes here'),
    next: nextOutput,
  }),
  start_connection: z.object({
    authorizationId: z.string(),
    authorizeUrl: z.string().describe("The provider's sign-in and consent page, for this authorization only"),
    expiresAt: z.number(),
  }),
  finish_connection: z.object({ connection: connectionOutput }),
  disconnect: z.object({
    deleted: z.boolean().describe('Whether the connection is gone; false while data sources read through it'),
    dataSourceIds: z.array(z.string()).describe('The data sources that read through it, which now fail as disconnected'),
  }),
  get_org_settings: z.object({ settings: settingsView }),
  update_org_settings: z.object({ settings: settingsView }),
  get_alert_channels: z.object({ slack: channelView.nullable(), webhook: channelView.nullable() }),
  set_slack_alert_channel: z.object({ channel: channelView }),
  set_webhook_alert_channel: z.object({ channel: channelView }),
  remove_alert_channel: z.object({ removed: z.boolean() }),
  get_ai_provider: z.object({ provider: aiProviderView.nullable().describe("Null while the org uses SignForge's demo model") }),
  save_ai_provider: z.object({ provider: aiProviderView }),
  test_ai_provider: z.object({
    ok: z.boolean(),
    models: z.array(z.string()).describe('The exact model ids the provider offers this key, to choose from; empty when it could not be reached'),
    problem: z
      .enum(['refused', 'busy', 'unreachable', 'blocked'])
      .nullable()
      .describe(
        'Why not: the provider refused the key, was busy, did not answer, or is at an address SignForge may not reach (not public https, or a redirect elsewhere)',
      ),
    provider: aiProviderView,
  }),
  remove_ai_provider: z.object({
    removed: z.boolean(),
    provider: z.enum(AI_PROVIDERS).nullable().describe('The provider whose key was removed; null if none was saved'),
  }),
  test_alert_channel: z.object({ delivery: deliveryView }),
  list_alert_deliveries: z.object({ deliveries: z.array(deliveryView), next: nextOutput }),
  retry_alert_delivery: z.object({ delivery: deliveryView }),
  list_spots: z.object({ spots: z.array(spotOutput), next: nextOutput, total: z.number().describe('How many match the filters, over every page') }),
  get_spot: spotResult,
  create_spot: spotResult,
  delete_spot: z.object({ deleted: z.string().describe("The deleted spot's id") }),
  update_spot: spotResult,
  revert_spot_draft: spotResult.extend({ rejected }),
  keep_spot_draft: spotResult,
  get_spot_preview: z.object({
    preview: z
      .looseObject({
        // The compiler's input types, not checked: an agent sees any JSON in them.
        templates: z.record(z.string(), z.custom<CompileInput['templates'][string]>()),
        files: z.record(z.string(), z.object({ size: z.number(), type: z.string() })),
        dataSources: z.array(z.custom<CompileInput['dataSources'][number]>()),
        brand: z.custom<NonNullable<CompileInput['brand']>>().optional(),
      })
      .describe("A compiler input without its screen and content: templates, files, dataSources and brand (the chosen kit as the screen's)"),
    brandKitId: z.string().nullable().describe('The kit the preview wears, or null for none'),
    problems: z.array(z.string()),
    timezone: z.string().nullable().describe("The organization's time zone for new screens, or null for none set: the probe screen's"),
  }),
  list_playlists: z.object({ playlists: z.array(playlistOutput), next: nextOutput, total: z.number().describe('How many match the filters, over every page') }),
  get_playlist: playlistResult,
  create_playlist: playlistResult,
  update_playlist: playlistResult,
  revert_playlist_draft: playlistResult.extend({ rejected }),
  keep_playlist_draft: playlistResult,
  get_agent_draft: agentDraftOutput,
  delete_playlist: z.object({ deleted: z.string().describe("The deleted playlist's id") }),
  set_default_playlist: playlistResult,
  list_schedule_entries: z.object({
    entries: z.array(entryOutput),
    next: nextOutput,
    total: z.number().describe('How many match the filters, over every page'),
  }),
  create_schedule_entry: entryResult,
  start_takeover: entryResult,
  update_schedule_entry: entryResult,
  delete_schedule_entry: z.object({
    deleted: z.string().describe("The deleted entry's id"),
    version: version.nullable().describe("The deletion's version, to pin in a publish; null when it was never published and went at once"),
  }),
  list_audit_log: z.object({ entries: z.array(auditEntryOutput), next: nextOutput }),
  list_members: z.object({ members: z.array(memberOutput), next: nextOutput }),
  list_agent_grants: z.object({ grants: z.array(agentGrantOutput), next: nextOutput }),
  get_agent_grant: z.object({ grant: agentGrantOutput }),
  update_agent_grant_scopes: z.object({ grant: agentGrantOutput }),
  revoke_agent_grant: z.object({ revoked: z.string().describe("The revoked grant's id") }),
  get_agent_grant_usage: z.object({
    since: z.number().describe('The start of the period counted, in ms since the epoch: the last 7 days'),
    grants: z.array(agentUsageOutput).describe('Each grant asked about, or each the caller may see'),
    recent: z.array(agentCallOutput).describe('With grantId: its latest calls, newest first, reads and refusals included'),
    lastRefusal: agentCallOutput.nullable().describe('With grantId: its latest refused call in the period, if any'),
  }),
  list_invitations: z.object({ invitations: z.array(invitationOutput), next: nextOutput }),
  invite_member: z.object({ invitation: invitationOutput }),
  cancel_invitation: z.object({ canceled: z.string().describe("The canceled invitation's id") }),
  update_member_role: z.object({ member: memberOutput }),
  remove_member: z.object({ removed: z.string().describe("The removed membership's id") }),
};

/** A tool's name. */
export type ToolName = keyof typeof outputs;
/** What the tool named `N` returns. */
export type ToolOutput<N extends ToolName> = z.output<(typeof outputs)[N]>;
