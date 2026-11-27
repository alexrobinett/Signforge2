/**
 * What every tool takes: its input schema, by tool name (`inputs`). Each tool's `input` is its entry here
 * (test/conventions.test.ts), as its output is its entry in ./outputs.ts, so a caller types its calls from
 * these types: the CMS does, from the browser and from its server functions (`@signforge/tools/inputs`,
 * types only). It imports what ./outputs.ts may, and no tool file, for the CMS's DOM typecheck loads it.
 */
import { fontById, HEX_COLOR } from '@signforge/compiler';
import { BINDING_PATH, ID_PATTERN, imageSizeProblem, SCREEN_BOX, safeUrl, TABLE_ROWS_PATH, VIDEO_SPEC } from '@signforge/contract';
import { FEED_URL_PROBLEMS, type FeedUrlProblem, feedUrlProblem } from '@signforge/feeds';
import { RENDITION_TYPES } from '@signforge/media/image-info';
import { z } from 'zod';
import {
  DEFAULT_PAGE_LIMIT,
  displayHours,
  id,
  idempotencyKey,
  ifVersion,
  labelKey,
  labels,
  locale,
  MAX_PAGE_LIMIT,
  name,
  orientation,
  pageInput,
  rule,
  selector,
  timezone,
} from './fields';
import {
  ACTOR_KINDS,
  AI_PROVIDERS,
  ALERT_CHANNEL_KINDS,
  ALERT_CHANNELS,
  rule as alertRule,
  ASSET_STATUSES,
  auditRetentionDays,
  brandShape,
  draftPin,
  draftRef,
  editorsPublish,
  ORIENTATIONS,
  SCOPES,
  scheduleTarget,
  SPOT_FITS,
  SPOT_KINDS,
  sourceFormat,
  TABLE_FORMATS,
  tableMapping,
  TEMPLATE_STATUSES,
  type ToolName,
  transition,
  VIDEO_TYPES,
} from './outputs';

/** What `read` reads, in the order it lists them: ./read.ts's `READ_TYPES` says what each is. */
export const READ_TYPE_NAMES = [
  'screen',
  'screen_status',
  'group',
  'label_key',
  'publish',
  'publish_request',
  'draft_count',
  'template',
  'asset',
  'font',
  'brand_kit',
  'data_source',
  'spot',
  'agent_draft',
  'playlist',
  'schedule_entry',
  'audit_entry',
  'member',
  'org',
  'connection',
  'alert_delivery',
  'alert_channels',
  'invitation',
] as const;
export type ReadType = (typeof READ_TYPE_NAMES)[number];

export const MIN_REFRESH_S = 300;

/** A news feed polls hourly unless a person chooses faster (owner decision on #339): stories turn over in hours, and each poll can queue photos. */
export const RSS_REFRESH_S = 3600;

const MAX_REFRESH_S = 86_400;

const feedUrl = z
  .string()
  .max(2048)
  .superRefine((url, ctx) => {
    const problem = feedUrlProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', message: FEED_URL_PROBLEMS[problem] });
  })
  .describe('The feed: https, on the default port, naming a public host. Stored encrypted and never shown again');

const refreshS = z
  .number()
  .int()
  .min(MIN_REFRESH_S, `refresh no faster than every ${MIN_REFRESH_S} seconds`)
  .max(MAX_REFRESH_S)
  .describe(`How often to poll the feed, in seconds, ${MIN_REFRESH_S} to ${MAX_REFRESH_S}`);

const horizonDays = z
  .number()
  .int()
  .min(1)
  .max(366)
  .describe('Calendars only: how many days ahead events reach (default 30). A holiday board wants months, a meeting room days');

export const photos = z
  .boolean()
  .describe("rss only: whether screens get the stories' photos, which the server fetches, checks and stores (default true). False: headlines only");

const resource = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe('Provider sources only: what to read at the provider, such as a calendar id or a sheet range. Stored encrypted and never shown again');

/** Slack's incoming-webhook URL (docs.slack.dev, Sending messages using incoming webhooks, read 2026-11-18). */
const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/;

const WEBHOOK_URL_PROBLEMS: Record<FeedUrlProblem, string> = {
  'bad-url': 'not a URL',
  'not-https': 'webhooks must be https',
  port: 'webhooks must use the default https port',
  'ip-literal': 'webhooks must name a host, not an IP address',
  'private-address': 'the host is a local name',
};

const ENDPOINT_URL_PROBLEMS: Record<FeedUrlProblem, string> = {
  'bad-url': 'not a URL',
  'not-https': 'the endpoint must be https',
  port: 'the endpoint must use the default https port',
  'ip-literal': 'the endpoint must name a host, not an IP address',
  'private-address': 'the host is a local name',
};

const hex = z
  .string()
  .regex(HEX_COLOR, 'a hex colour, #rgb or #rrggbb')
  .transform((v) => v.toLowerCase())
  .describe('A hex colour, #rrggbb');

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 00:00 to 23:59');

/** The most one rendition may weigh. A 3413x1920 PNG, the largest a cover-scaled 4K image gets, is well under it. */
export const MAX_RENDITION_BYTES = 20 * 1024 * 1024;

const pixels = z.number().int().positive().max(65_535);

const bytes = z
  .number()
  .int()
  .positive()
  .max(MAX_RENDITION_BYTES, `a rendition may be at most ${MAX_RENDITION_BYTES / 1024 / 1024} MB`);

/** Codes are 6 of these 32 letters (about a billion codes): no 0/O, 1/I, so a code read off a screen types cleanly. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const PAIRING_CODE_LENGTH = 6;

const CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

export const code = z
  .string()
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .refine((v) => CODE.test(v), `a pairing code is ${PAIRING_CODE_LENGTH} letters and digits, as the screen shows it`)
  .describe('The code the screen shows, such as K7M-2QX; case, spaces and dashes do not matter');

const typeField = (types: readonly ReadType[]) => z.enum(types).describe('What to read; describe(type) says its filters and fields');

/** `read`'s input, its type one of `types`: a key it does not take is refused, saying where it goes. */
export const readInput = (types: readonly ReadType[]) =>
  z.strictObject(
    {
      type: typeField(types),
      ids: z.array(id('record')).min(1).optional().describe("Read these by id, at most as many as describe's maxIds (publish takes 'latest'); omit to list"),
      filter: z.record(z.string(), z.unknown()).optional().describe("The type's filters, as describe lists them; with ids, only its idOptions"),
      query: z.string().min(1).max(100).optional().describe('Words in the name, where the type can search (asset, audit_entry)'),
      detail: z.enum(['summary', 'full']).optional().describe('summary (the default): the fields most tasks need; full: every field'),
      fields: z.array(z.string()).min(1).max(40).optional().describe('Only these top-level fields of each row'),
      // A list's page: the list's own default when omitted, and none with ids.
      limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe(`How many to list, 1 to ${MAX_PAGE_LIMIT}; default ${DEFAULT_PAGE_LIMIT}`),
      cursor: z.string().max(2000).optional().describe("The previous page's next, to list the page after it"),
    },
    { error: (issue) => (issue.code === 'unrecognized_keys' ? `read takes no ${issue.keys.join(', ')}: put a type's filters under filter` : undefined) },
  );

/** `describe`'s input, its type one of `types`. */
export const describeInput = (types: readonly ReadType[]) => z.object({ type: typeField(types) });

const isoTime = z.iso.datetime({ offset: true });

/**
 * The earliest time a filter takes, 2000-01-01: no log goes back further, and a number below it is seconds since the
 * epoch, which as ms would mean January 1970 (#543). An ISO time before it is refused alike, never a negative ms.
 */
const EARLIEST = Date.UTC(2000, 0, 1);

/**
 * A time an agent gives as it reads one, ISO 8601, or as the CMS does, ms since the epoch (#345): ms to the handler.
 * Checked by refine, so its schema says date-time rather than carry zod's regex (#543).
 */
const instant = z
  .union(
    [
      z.number().int().min(EARLIEST, 'ms since the epoch, from 2000 on: a number this small is seconds, so multiply it by 1000'),
      z
        .string()
        .refine((t) => isoTime.safeParse(t).success)
        .meta({ format: 'date-time' })
        .transform((t) => Date.parse(t)),
    ],
    { error: 'Expected an ISO 8601 time with its offset, such as 2026-11-26T09:00:00Z, or ms since the epoch' },
  )
  // Only an ISO time reaches this below the floor: a number is refused above, as seconds.
  .refine((ms) => ms >= EARLIEST, 'a time from 2000 on');

const aim = {
  target: scheduleTarget,
  groupId: id('group').optional().describe('For a group entry: the group'),
  screenId: id('screen').optional().describe('For a screen entry: the screen'),
};

const aimed = (v: { target?: string; groupId?: string; screenId?: string }) =>
  v.target === undefined
    ? v.groupId === undefined && v.screenId === undefined
    : (v.target === 'group') === (v.groupId !== undefined) && (v.target === 'screen') === (v.screenId !== undefined);

const AIMED = 'give groupId for a group entry and screenId for a screen entry, nothing for org';

const priority = z.number().int().min(0).max(99).describe('Higher wins where entries overlap; 0 to 99, default 0. Takeovers are above all of them');

const date = (what: string) => z.string().describe(`${what}, YYYY-MM-DD in each screen's time zone`);

const time = (what: string) => z.string().describe(`${what}, HH:MM in each screen's time zone`);

const when = {
  startDate: date('First date, inclusive').nullable().optional(),
  endDate: date('Last date, inclusive').nullable().optional(),
  days: z.array(z.number().int()).min(1).max(7).nullable().optional().describe('Weekdays it plays, 0 = Sunday; omit for every day'),
  from: time('Daily start, inclusive').nullable().optional(),
  to: time('Daily end, exclusive; at or before from, the window crosses midnight').nullable().optional(),
};

const isoInstant = (what: string) => z.string().describe(`${what}, an ISO 8601 time`);

/** A takeover's fields as its tools take them: the playlist, whom it plays on, and when (`start_takeover`, `takeover`). */
export const takeoverFields = {
  playlistId: id('playlist'),
  ...aim,
  startsAt: isoInstant('When it starts; default now').optional(),
  endsAt: isoInstant('When it ends, at most 24 hours after it starts'),
};

/** Reject's and Keep's: the draft's version as the person was shown it. */
const shownVersion = z
  .number()
  .int()
  .positive()
  .describe('The version you were shown. If the draft has changed since, nothing is written: conflict, details { id, version }');

const durationMs = z
  .number()
  .int()
  .min(1000)
  .max(24 * 3600_000)
  .describe('How long the spot stays on screen, in ms');

export const data = z.record(z.string(), z.unknown()).describe("The template's field values by name, the whole set; one left out takes its default");

export const assets = z.record(z.string(), id('asset')).describe('Image fields to verified asset ids, by name, the whole set');

export const url = z.string().refine(safeUrl, 'must be an https URL').describe('An https page on another origin');

const binding = z.object({
  dataSourceId: id('data source'),
  path: z
    .string()
    .max(200)
    .regex(BINDING_PATH, 'must be a dot path such as current.temperature_2m')
    .describe(`A dot path into the source's snapshot; numbers index arrays: daily.temperature_2m_max.0, items. With table, ${TABLE_ROWS_PATH}`),
  table: tableMapping.optional(),
});

export const bindings = z
  .record(z.string(), binding)
  .describe(
    "Template fields bound to the organization's data sources, by field name: the whole set, replacing the draft's ({} unbinds every field). describe(spot) says how binding works",
  );

/** The fields that belong to one kind of spot (KIND_FIELDS), as save_spot takes them. */
const kindInput = {
  data: data.optional(),
  assets: assets.optional(),
  bindings: bindings.optional(),
  assetId: id('asset').optional(),
  fit: z.enum(SPOT_FITS).optional(),
  url: url.optional(),
};

/** Reject's and Keep's input: the spot, at the version shown. */
const decideSpotInput = z.object({ spotId: id('spot'), ifVersion: shownVersion });

const spotIds = z
  .array(id('spot'))
  .max(500)
  .describe("The spots in play order: the whole list, replacing the draft's. A spot may appear more than once");

/** Reject's and Keep's input: the playlist, at the version shown. */
const decidePlaylistInput = z.object({ playlistId: id('playlist'), ifVersion: shownVersion });

/** `allowSample`'s input: the spots a `sample_text` refusal named, as it named them. */
export const sampleAcks = z
  .array(
    z.object({
      spotId: id('spot'),
      version: z.number().int().positive().describe('The version the refusal named'),
      fields: z.array(z.string().max(100)).max(200).describe('The fields the refusal named'),
    }),
  )
  .max(500);

/** What `takeover` takes to publish a new one, refused with `end`. */
const PUBLISH_ONLY = ['playlistId', 'target', 'groupId', 'screenId', 'startsAt', 'endsAt', 'with', 'ifReach', 'ifPlays'] as const;

/** A takeover's input as agents are listed it. */
export const takeoverInput = {
  action: z.enum(['publish', 'end']).describe('publish: make one and publish it; end: end one'),
  scheduleEntryId: id('schedule entry').optional().describe('end: the takeover'),
  playlistId: takeoverFields.playlistId.optional(),
  target: takeoverFields.target.optional(),
  groupId: takeoverFields.groupId,
  screenId: takeoverFields.screenId,
  startsAt: takeoverFields.startsAt,
  endsAt: takeoverFields.endsAt.optional(),
  with: z
    .array(draftRef.extend({ version: z.number().int().positive() }))
    .max(500)
    .optional()
    .describe('publish: drafts published with it, each at the version chosen: its playlist and spots, if never published'),
};

/**
 * What the agent drawer's card holds a takeover to, each checked against the org as the publish reads it and held to its
 * commit (#408). Only the card sends them, so they are not listed: `input` takes them from any caller.
 */
const cardGuards = {
  ifVersion: z.number().int().positive().optional().describe('end: the version read; refused with a conflict if it changed since'),
  ifReach: z.array(id('screen')).max(5000).optional().describe('publish: the screens it plays on, by id; refused with a conflict unless still exactly these'),
  ifPlays: z
    .strictObject({ playlist: z.number().int().nullable(), spots: z.record(z.string(), z.number().int().nullable()) })
    .optional()
    .describe("publish: its playlist's and each of its spots' published version (null: never); refused with a conflict if one moved since"),
};

const takeoverShape = z.strictObject({ ...takeoverInput, ...cardGuards });

/** What each action needs and refuses, on the tool's input and on the one it is listed. */
export function takeoverRules(v: Partial<z.output<typeof takeoverShape>>, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.action === 'end') {
    if (v.scheduleEntryId === undefined) issue('scheduleEntryId', 'end needs the takeover: scheduleEntryId');
    for (const k of PUBLISH_ONLY) if (v[k] !== undefined) issue(k, `${k} is for publish: end takes scheduleEntryId alone`);
    return;
  }
  if (v.scheduleEntryId !== undefined) issue('scheduleEntryId', 'publish makes a new takeover: scheduleEntryId is for end');
  if (v.ifVersion !== undefined) issue('ifVersion', 'publish makes a new takeover: ifVersion is for end');
  for (const k of ['playlistId', 'target', 'endsAt'] as const) if (v[k] === undefined) issue(k, `publish needs ${k}`);
  if (!aimed(v)) issue('target', AIMED);
}

const SHA256 = /^[0-9a-f]{64}$/;

const sha = (what: string) => z.string().regex(SHA256, `not a ${what} hash (64 lowercase hex characters)`);

/** A video's file as an upload claims it (`start_upload`, ./uploading.ts). */
const videoFileInput = {
  sha256: z.string().regex(SHA256, 'not a SHA-256 (64 lowercase hex characters)'),
  type: z.enum(VIDEO_TYPES),
  size: z
    .number()
    .int()
    .positive()
    .max(VIDEO_SPEC.maxBytes, `a video may be at most ${VIDEO_SPEC.maxBytes / 1e6} MB`),
};

/** A multipart upload's parts, each with the ETag its PUT returned (`finalize_upload`). */
export const videoParts = z
  .array(
    z.object({
      partNumber: z.number().int().min(1).max(10_000),
      // As the S3 API's response header gives it, in quotes; R2's binding takes it bare.
      etag: z
        .string()
        .min(1)
        .max(256)
        .transform((e) => e.replace(/^"(.*)"$/, '$1')),
    }),
  )
  .max(10_000);

const VIDEO_ONLY = ['sha256', 'type', 'size'] as const;

const apiKey = z
  .string()
  .trim()
  .min(20, 'that is too short to be an API key')
  .max(512, 'that is too long to be an API key')
  .regex(/^\S+$/, 'an API key has no spaces')
  .describe("The provider's API key. Stored encrypted and never shown again");

const modelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, 'not a model id')
  .nullable()
  .describe("An exact model id from the provider's list (test_ai_provider), never an alias; null to unset");

/** An endpoint's base address: printable ASCII, the fetch-safety rules of feed URLs, no user name or password, no query or fragment, kept as parsed without a trailing slash. */
const baseUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((url, ctx) => {
    const problem = feedUrlProblem(url);
    // Only printable ASCII, so what the page shows is where the key goes: a look-alike such as the fraction
    // slash in `https://api.openai.com⁄v1.evil.example` reads as OpenAI and resolves to another host.
    if (/[^\x21-\x7e]/.test(url))
      ctx.addIssue({ code: 'custom', message: "the endpoint's address is plain ASCII: write an international host in its xn-- form" });
    else if (problem) ctx.addIssue({ code: 'custom', message: ENDPOINT_URL_PROBLEMS[problem] });
    // A user name makes `https://api.openai.com@evil.example/v1` read as one host and go to another, and a
    // password would be kept in clear, shown to every member and in the audit log.
    else if (new URL(url).username || new URL(url).password) ctx.addIssue({ code: 'custom', message: "the endpoint's address has no user name or password" });
    else if (/[?#]/.test(url)) ctx.addIssue({ code: 'custom', message: 'the endpoint is a base address, with no query or fragment' });
  })
  // Kept as the URL parser writes it (`https://@host` becomes `https://host`), so the stored address is the one fetched.
  .transform((url) => new URL(url).href.replace(/\/+$/, ''))
  .describe(
    "An OpenAI-compatible endpoint's base address, such as https://api.openai.com/v1 or https://generativelanguage.googleapis.com/v1beta/openai: https, the default port, a public host. Its models are at <base>/models",
  );

const slackWebhookUrl = z
  .string()
  .max(2048)
  .regex(SLACK_WEBHOOK, 'a Slack incoming-webhook URL, https://hooks.slack.com/services/T…/B…/…')
  .describe("The incoming webhook's URL from Slack, https://hooks.slack.com/services/T…/B…/…. Stored encrypted and never shown again");

/** The fetch-safety rules of feed URLs (`@signforge/feeds`); the delivery run checks the address it resolves to as well. */
const outgoingUrl = z
  .string()
  .max(2048)
  .superRefine((url, ctx) => {
    const problem = feedUrlProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', message: WEBHOOK_URL_PROBLEMS[problem] });
  })
  .describe('Where to POST alerts: https, on the default port, naming a public host. Stored encrypted and never shown again');

const signingSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, '32 to 128 characters of A-Z, a-z, 0-9, _ and -')
  .describe(
    'The secret each POST is signed with, which you make and keep: 32 to 128 random characters of A-Z, a-z, 0-9, _ and -, such as whsec_ and 32 random bytes in base64url. Stored encrypted and never shown again',
  );

const fontId = (role: string) =>
  z
    .string()
    .refine((v) => fontById(v) !== undefined, 'not a font in the catalogue; see list_fonts')
    .describe(`The ${role} font's catalogue id, such as base/inter. See list_fonts`);

const colorsPatch = z
  .object({
    primary: hex.optional().describe('Filled buttons and badges'),
    accent: hex.optional().describe('Highlights, tags, the crawl label'),
    background: hex.optional().describe('The page'),
    surface: hex.optional().describe('Cards and rows on the page'),
    text: hex.optional().describe('Body text'),
    muted: hex.optional().describe('Secondary text'),
    onPrimary: hex.nullable().optional().describe('Text on primary. Leave out, or null, to derive it for 4.5:1 contrast'),
    onAccent: hex.nullable().optional().describe('Text on accent. Leave out, or null, to derive it for 4.5:1 contrast'),
  })
  .describe("The kit colours: a new kit's six, or those to change, the rest staying");

const logoFields = {
  logoOnDarkAssetId: id('asset').describe('The logo for dark backgrounds: an SVG or PNG image asset'),
  logoOnLightAssetId: id('asset').describe('The logo for light backgrounds, if it differs'),
};

const rowsPath = z
  .string()
  .max(200)
  .regex(BINDING_PATH, 'must be a dot path such as data.items')
  .describe('json-table only: the dot path to the list of objects, such as data.items. Absent: the document is the list');

export const ROWS_PATH_ONLY_JSON_TABLE = 'rowsPath is for json-table sources only';

export const jsonTableOnly = (f: string, path: string | null | undefined) => path == null || f === 'json-table';

// Strict, as every save is: a field it does not take is refused by name, not dropped (review of #499).
export const saveDataSourceInput = z.strictObject({
  dataSourceId: id('data source').optional().describe('The source to change; omit to add one'),
  id: id('data source').optional().describe('A new source: the id spots bind with, such as weather; made for you if absent'),
  name: name('data source').optional(),
  format: sourceFormat.optional().describe("A new source's format; fixed once made"),
  feedUrl: feedUrl.optional().describe('Feeds: the URL, https, on the default port, naming a public host. Stored encrypted and never shown again'),
  connectionId: id('connection').optional().describe('A new provider source: the connection to read through'),
  resource: resource.optional(),
  refreshS: refreshS
    .optional()
    .describe(
      `How often to poll the feed, in seconds, ${MIN_REFRESH_S} to ${MAX_REFRESH_S}; for a new source default ${RSS_REFRESH_S} for rss, ${MIN_REFRESH_S} for the rest`,
    ),
  horizonDays: horizonDays.nullable().optional(),
  rowsPath: rowsPath.nullable().optional(),
  photos: photos.optional(),
  ifVersion,
  idempotencyKey,
});

export const change = z
  .object({
    screenIds: z.array(id('screen')).min(1).max(1000).describe('The screens to change, up to 1000'),
    set: labels.default({}).describe('Labels to set, by key: a key a screen has takes the new value'),
    remove: z.array(labelKey).default([]).describe('Keys to remove; a key a screen does not have is ignored'),
  })
  .refine((v) => Object.keys(v.set).length > 0 || v.remove.length > 0, 'give labels to set or keys to remove')
  .refine((v) => !v.remove.some((k) => Object.hasOwn(v.set, k)), 'a key cannot be both set and removed');

const updateWindow = z
  .object({ from: clockTime, to: clockTime })
  .refine((w) => w.from !== w.to, 'the window must not start and end at the same time')
  .describe("When player and system updates may run, in each screen's local time; a window whose end is before its start crosses midnight");

/** A screen syncs every 5 minutes, so less than that would alert on a sync that is merely due. */
const unreachableAfterMinutes = z.number().int().min(5).max(1440).describe('Minutes without a heartbeat before a screen alerts, 5 to 1440');

/** What `screen_command` sends: a display override (on, off, or back to the display hours), identify, or restart. */
const SCREEN_COMMANDS = ['identify', 'restart', 'display_on', 'display_off', 'display_auto'] as const;

/** Controls, format and bidi characters, line and paragraph breaks, and invisible code points: as a client's name refuses them. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export const grantId = id('agent grant');

const sha256 = z.string().regex(SHA256, 'not a SHA-256 (64 lowercase hex characters)');

const renditionInput = z.object({
  sha256,
  type: z.enum(RENDITION_TYPES),
  size: bytes,
  width: pixels.nullable().describe('Pixels, as displayed; null for SVG'),
  height: pixels.nullable().describe('Pixels, as displayed; null for SVG'),
  sample: z.object({ sha256, size: bytes }).optional().describe('Its sample PNG from @signforge/media; none for SVG or transparency'),
});

/** An image's two renditions as an upload claims them (`start_upload`, ./uploading.ts): both raster or the same SVG, each fitting its screen box. */
export const renditionsInput = z.object({ landscape: renditionInput, portrait: renditionInput }).superRefine((renditions, ctx) => {
  for (const o of ORIENTATIONS) {
    const r = renditions[o];
    const path = [o];
    if (r.type === 'image/svg+xml') {
      if (r.width !== null || r.height !== null) ctx.addIssue({ code: 'custom', path, message: 'an SVG has no pixel size: send width and height as null' });
      if (r.sample) ctx.addIssue({ code: 'custom', path, message: 'an SVG has no sample' });
    } else if (r.width === null || r.height === null) {
      ctx.addIssue({ code: 'custom', path, message: 'a raster rendition needs its width and height' });
    } else {
      const message = imageSizeProblem(r.width, r.height, SCREEN_BOX[o]);
      if (message) ctx.addIssue({ code: 'custom', path, message });
    }
  }
  const { landscape: l, portrait: p } = renditions;
  if ((l.type === 'image/svg+xml') !== (p.type === 'image/svg+xml')) ctx.addIssue({ code: 'custom', message: 'an SVG is sent as it is for both orientations' });
  // Renditions and samples alike: a file is stored and checked once, by its hash.
  const files = [l, p].flatMap((r) => [r, ...(r.sample ? [{ ...r.sample, type: 'image/png' }] : [])]);
  if (files.some((f) => files.some((g) => f.sha256 === g.sha256 && (f.type !== g.type || f.size !== g.size))))
    ctx.addIssue({ code: 'custom', message: 'the same file cannot have two types or sizes' });
});

export const inputs = {
  // ------------------------------------------------------------ agent drafts
  get_agent_draft: z
    .object({ spotId: id('spot').optional(), playlistId: id('playlist').optional() })
    .refine((v) => (v.spotId === undefined) !== (v.playlistId === undefined), 'give spotId or playlistId, one of them'),
  // ------------------------------------------------------------ agent grants
  list_agent_grants: z.object({ ...pageInput }),
  get_agent_grant: z.object({ grantId }),
  update_agent_grant_scopes: z.object({
    grantId,
    scopes: z
      .array(z.enum(SCOPES))
      .min(1)
      .max(SCOPES.length)
      .describe('Every scope it should hold, content:read among them: the whole set, replacing the grant’s'),
    // Required (#328): a set made from a stale read would put back a scope another person took away meanwhile.
    ifVersion: z
      .number()
      .int()
      .positive()
      .describe(
        'The version you read. If the grant has changed since, nothing is written and the call is refused with conflict, details { id, version }: read it again and redo the change',
      ),
  }),
  revoke_agent_grant: z.object({ grantId }),
  get_agent_grant_usage: z.object({ grantId: grantId.optional() }),
  // ------------------------------------------------------------ ai providers
  get_ai_provider: z.object({}),
  save_ai_provider: z.object({
    provider: z.enum(AI_PROVIDERS),
    apiKey: apiKey.optional(),
    fastModel: modelId.optional(),
    capableModel: modelId.optional(),
    dailyTurnCeiling: z.number().int().min(1).max(100_000).nullable().optional().describe('Agent turns a day across the org; null for none'),
    baseUrl: baseUrl.optional(),
    acceptsImages: z.boolean().optional().describe('An endpoint: whether its models take images (Fill from a flyer needs it)'),
    jsonSchemaOutput: z.boolean().optional().describe('An endpoint: whether it returns output to a JSON schema (response_format json_schema; Fill needs it)'),
    ifVersion,
  }),
  test_ai_provider: z.object({}),
  remove_ai_provider: z.object({}),
  // ------------------------------------------------------------ alert channels
  get_alert_channels: z.object({}),
  set_alert_channel: z
    .strictObject({
      kind: z.enum(ALERT_CHANNEL_KINDS),
      webhookUrl: z.string().max(2048).optional().describe("slack: the incoming webhook's URL; webhook: the URL alerts are POSTed to"),
      signingSecret: signingSecret.optional(),
      ifVersion,
    })
    .superRefine((v, ctx) => {
      if (v.kind === 'slack' && v.signingSecret !== undefined)
        ctx.addIssue({ code: 'custom', path: ['signingSecret'], message: 'a Slack channel takes no signing secret' });
      if (v.kind === 'slack' && v.webhookUrl === undefined)
        ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: 'a Slack channel needs its webhookUrl' });
      if (v.kind === 'webhook' && v.webhookUrl === undefined && v.signingSecret === undefined) ctx.addIssue({ code: 'custom', message: 'nothing to change' });
      if (v.webhookUrl === undefined) return;
      // Each kind's own rules for its URL: Slack's host, or a public https address.
      const checked = (v.kind === 'slack' ? slackWebhookUrl : outgoingUrl).safeParse(v.webhookUrl);
      for (const issue of checked.error?.issues ?? []) ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: issue.message });
    }),
  remove_alert_channel: z.object({ channel: z.enum(ALERT_CHANNEL_KINDS) }),
  test_alert_channel: z.object({ channel: z.enum(ALERT_CHANNELS).describe('email goes to the member who asks') }),
  list_alert_deliveries: z.object({ ...pageInput }),
  retry_alert_delivery: z.object({ alertDeliveryId: id('alert delivery') }),
  // ------------------------------------------------------------ assets
  list_assets: z.object({
    query: z.string().trim().max(100).optional().describe('Part of the name, any case'),
    status: z.enum(ASSET_STATUSES).optional(),
    ...pageInput,
  }),
  get_asset: z.object({ assetId: id('asset') }),
  // ------------------------------------------------------------ audit
  list_audit_log: z.object({
    ...pageInput,
    actor: z
      .object({ kind: z.enum(ACTOR_KINDS).optional(), id: z.string().min(1).max(200).optional().describe('One actor, as an entry names it') })
      .optional()
      .describe('Only what this kind of actor, or this one actor, did'),
    action: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Only this action, such as update_screen. A replaced tool also finds the rows of the tool that does its job now: create_spot and update_spot find save_spot without and with spotId, delete_playlist finds delete of a playlist, identify_screen finds screen_command identify, and so on',
      ),
    target: z
      .object({ kind: z.string().min(1).max(40).describe('Such as screen or spot'), id: z.string().min(1).max(200).optional() })
      .optional()
      .describe('Only what was done to this kind of thing, or this one thing, even one since deleted'),
    from: instant.optional().describe('Only entries at or after this time, from 2000 on: ISO 8601, or ms since the epoch'),
    to: instant.optional().describe('Only entries before this time, from 2000 on: ISO 8601, or ms since the epoch'),
    query: z.string().trim().min(1).max(100).optional().describe('Only entries whose action, actor, target or recorded input contains this text'),
  }),
  // ------------------------------------------------------------ brand
  list_fonts: z.object({ ...pageInput }),
  list_brand_kits: z.object({ ...pageInput }),
  get_brand_kit: z.object({ brandKitId: id('brand kit') }),
  save_brand_kit: z.strictObject({
    brandKitId: id('brand kit').optional().describe('The kit to change; omit to create one'),
    name: name('brand kit').optional(),
    colors: colorsPatch.optional(),
    shape: brandShape.optional(),
    displayFontId: fontId('display').nullable().optional(),
    bodyFontId: fontId('body').nullable().optional(),
    logoOnDarkAssetId: logoFields.logoOnDarkAssetId.nullable().optional(),
    logoOnLightAssetId: logoFields.logoOnLightAssetId.nullable().optional(),
    makeDefault: z.boolean().optional().describe("True makes it the organization's default kit"),
    ifVersion,
    idempotencyKey,
  }),
  assign_brand_kit: z
    .object({
      brandKitId: id('brand kit').nullable().describe('The kit to use, or null to remove the choice'),
      screenId: id('screen').optional(),
      groupId: id('group').optional(),
    })
    .refine((v) => (v.screenId === undefined) !== (v.groupId === undefined), 'give exactly one of screenId and groupId'),
  // ------------------------------------------------------------ connections
  list_connections: z.object({ ...pageInput }),
  start_connection: z.object({
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/, 'not a provider name')
      .describe('The provider, such as google'),
    connectionId: id('connection').optional().describe('A connection to authorize again in place, keeping its id and its data sources'),
  }),
  finish_connection: z.object({
    oauthState: z.string().min(16).max(256).describe('The state the provider sent back'),
    code: z.string().min(1).max(2048).describe("The provider's authorization code"),
  }),
  disconnect: z.object({ connectionId: id('connection') }),
  // ------------------------------------------------------------ data sources
  list_data_sources: z.object({ ...pageInput }),
  get_data_source: z.object({ dataSourceId: id('data source') }),
  save_data_source: saveDataSourceInput,
  find_places: z.object({ query: z.string().trim().min(2, 'type at least 2 letters of the place').max(100).describe('A place name, such as Atlanta') }),
  read_table: z
    .object({
      feedUrl,
      format: z.enum(TABLE_FORMATS).describe('csv: a header row, then a row per item; json-table: a list of objects'),
      rowsPath: rowsPath.optional(),
    })
    .refine((v) => jsonTableOnly(v.format, v.rowsPath), { message: ROWS_PATH_ONLY_JSON_TABLE, path: ['rowsPath'] }),
  // ------------------------------------------------------------ delete
  delete: z
    .strictObject({
      type: z.enum(['asset', 'data_source', 'playlist', 'schedule_entry']),
      id: z.string().regex(ID_PATTERN, 'not a valid id').describe("The thing's id"),
      ifVersion: ifVersion.describe('playlist or schedule_entry: the version you read; a conflict means it changed since'),
    })
    .refine((v) => v.ifVersion === undefined || v.type === 'schedule_entry' || v.type === 'playlist', {
      message: 'ifVersion is for a playlist or a schedule entry',
      path: ['ifVersion'],
    }),
  // ------------------------------------------------------------ groups
  list_groups: z.object({ ...pageInput }),
  save_group: z
    .strictObject({
      groupId: id('group').optional().describe('The group to change; omit to create one'),
      name: name('group').optional(),
      screenIds: z.array(id('screen')).max(1000).optional().describe("A new list's screens, or those membership changes"),
      membership: z.enum(['add', 'remove', 'set']).optional().describe('How screenIds change a list; needed with groupId'),
      selector: rule.nullable().optional().describe('Screens matching every { key, op, values } term; null: a list'),
      ifVersion,
      idempotencyKey,
    })
    // A key on a change is refused: it replays its first answer, so a keyed add repeated after a remove would change nothing (#503).
    .superRefine((v, ctx) => {
      const problem =
        v.selector !== undefined && (v.screenIds !== undefined || v.membership !== undefined)
          ? "a smart group's screens are the ones its selector matches: give a selector or screenIds, not both"
          : v.groupId === undefined && v.selector === null
            ? 'a new group with no rule needs no selector: leave it out'
            : v.membership !== undefined && v.screenIds === undefined
              ? 'membership needs the screenIds it adds, removes or sets'
              : v.groupId === undefined
                ? v.name === undefined
                  ? 'a new group needs a name; give groupId to change one'
                  : v.membership === 'remove'
                    ? 'a new group has no screens to remove'
                    : v.ifVersion !== undefined
                      ? 'a new group has no version yet: ifVersion is for a change'
                      : undefined
                : v.idempotencyKey !== undefined
                  ? 'idempotencyKey is for a new group: a change is safe to repeat, and ifVersion guards a rename or set'
                  : (v.membership === 'add' || v.membership === 'remove') && v.screenIds?.length === 0
                    ? `give the screens to ${v.membership}: an empty list changes nothing (membership set with an empty list empties the group)`
                    : v.screenIds !== undefined && v.membership === undefined
                      ? 'give membership with screenIds: add, remove or set'
                      : v.name === undefined && v.screenIds === undefined && v.selector === undefined
                        ? 'give a name, screenIds or a selector to change'
                        : undefined;
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  delete_group: z.object({ groupId: id('group') }),
  // ------------------------------------------------------------ labels
  update_screen_labels: change,
  import_screen_labels: z.object({
    screens: z
      .array(
        z
          .object({ screenId: id('screen'), set: labels.default({}), remove: z.array(labelKey).default([]) })
          .refine((c) => !c.remove.some((k) => Object.hasOwn(c.set, k)), 'a key cannot be both set and removed'),
      )
      .min(1)
      .max(1000)
      .refine((all) => new Set(all.map((c) => c.screenId)).size === all.length, 'each screen once'),
  }),
  list_label_keys: z.object({ ...pageInput }),
  // ------------------------------------------------------------ members
  list_members: z.object({ ...pageInput }),
  list_invitations: z.object({ ...pageInput }),
  cancel_invitation: z.object({ invitationId: id('invitation') }),
  // ------------------------------------------------------------ pairing
  claim_screen: z.object({
    code,
    name: name('screen'),
    timezone,
    orientation,
    locale: locale.optional(),
    displayHours: displayHours.optional().describe('Omit for always on'),
    labels: labels.optional().describe('Its first labels, by key, such as { "region": "north" }; as update_screen_labels sets them'),
    idempotencyKey,
  }),
  // ------------------------------------------------------------ playlists
  list_playlists: z.object({
    ...pageInput,
    isDefault: z.boolean().optional().describe('true: only the default playlist (none while there is none)'),
    unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'),
  }),
  get_playlist: z.object({ playlistId: id('playlist') }),
  save_playlist: z.strictObject({
    playlistId: id('playlist').optional().describe('The playlist to change; omit to create one'),
    name: name('playlist').optional(),
    transition: transition.optional(),
    spotIds: spotIds.optional(),
    ifVersion,
    idempotencyKey,
  }),
  revert_playlist_draft: decidePlaylistInput,
  keep_playlist_draft: decidePlaylistInput,
  set_default_playlist: z.object({
    playlistId: id('playlist'),
    ifVersion: ifVersion.optional().describe("The organization settings' version you read (get_org_settings): refused with a conflict if they changed since"),
    ifDefault: id('playlist')
      .nullable()
      .optional()
      .describe('Set it only if the default is still this playlist; null: only if there is none. Refused with a conflict otherwise'),
  }),
  // ------------------------------------------------------------ preview
  preview_publish: z.object({}),
  // ------------------------------------------------------------ publish requests
  request_publish: z.object({
    drafts: z
      .array(draftPin)
      .min(1)
      .max(100)
      .refine((pins) => new Set(pins.map((p) => `${p.kind}:${p.id}`)).size === pins.length, 'each draft once')
      .describe('The drafts to publish, each at the version you read'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      // One line of plain text: nothing that breaks it, hides text or reorders it on the page or alert around it.
      .refine((v) => !HIDDEN.test(v), 'one line of text, with no control, format, bidirectional or invisible characters')
      .describe('What it is and why, for the person deciding: one line, 500 characters at most'),
    idempotencyKey,
  }),
  list_publish_requests: z.object({ pending: z.boolean().optional().describe('Only those still waiting: not decided, and not expired'), ...pageInput }),
  get_publish_request: z.object({ publishRequestId: id('publish request') }),
  approve_publish_request: z.object({
    publishRequestId: id('publish request'),
    allowSample: sampleAcks
      .optional()
      .describe(
        "The spots a sample_text refusal named, { spotId, version, fields } as named: publish them with their template's sample text anyway, once you have seen them",
      ),
    ifScreens: z
      .array(id('screen'))
      .max(5000)
      .optional()
      .describe("check_publish_request's screens, by id: approve only if it switches exactly these. Refused with a conflict, details { screens }, otherwise"),
    ifDefault: id('playlist')
      .nullable()
      .optional()
      .describe(
        "check_publish_request's defaultPlaylistId: approve only while it is the default (null: while there is none). Refused with a conflict otherwise",
      ),
  }),
  decline_publish_request: z.object({ publishRequestId: id('publish request') }),
  reopen_publish_request: z.object({ publishRequestId: id('publish request') }),
  check_publish_request: z.object({ publishRequestId: id('publish request') }),
  // ------------------------------------------------------------ publish
  publish_manifest_to_screen: z.object({
    screenId: id('screen'),
    manifestId: z.string().regex(SHA256, 'not a manifest id (64 lowercase hex characters)').describe("The manifest's id, the SHA-256 in its `id` field"),
  }),
  publish: z.object({
    ifDefault: id('playlist')
      .nullable()
      .optional()
      .describe('Publish only while this playlist is the default (null: while there is none); else a conflict { defaultPlaylistId }'),
    ifBrand: z
      .string()
      .max(200_000)
      .optional()
      .describe('Publish only while the brand kits are as the publish card read them; else a conflict { brand: true }'),
    ifScreens: z.array(id('screen')).max(5000).optional().describe('Publish only if it switches exactly these screens; else a conflict { screens }'),
    drafts: z
      .array(draftRef.extend({ version: z.number().int().positive().describe('The version you chose it at') }))
      .max(500)
      .optional()
      .describe('Each at the version you chose it at; omit for every changed draft, [] for none'),
    allowSample: sampleAcks
      .optional()
      .describe('People only: the spots a sample_text refusal named, as it named them, once a person chose to publish them anyway'),
  }),
  takeover: takeoverShape.superRefine(takeoverRules),
  roll_back_publish: z.object({
    publishId: id('publish').describe('The publish to go back to'),
    ifLatest: id('publish').optional().describe('For an undo: the publish being undone. Refused with a conflict unless it is still the latest'),
  }),
  list_publishes: z.object({ ...pageInput }),
  get_publish: z.object({
    publishId: id('publish').optional().describe('Omit for the latest publish'),
    // Every group's screen ids can be large: a page that polls the rollout leaves them out (review of #620).
    targets: z.boolean().default(false).describe('Also return whom each group reached'),
  }),
  count_drafts: z.object({}),
  // ------------------------------------------------------------ schedule
  list_schedule_entries: z.object({
    ...pageInput,
    unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'),
  }),
  start_takeover: z.object({ ...takeoverFields, idempotencyKey }).refine(aimed, AIMED),
  save_schedule_entry: z
    .strictObject({
      scheduleEntryId: id('schedule entry').optional().describe('The entry to change; omit to create one'),
      playlistId: id('playlist').optional(),
      target: scheduleTarget.optional(),
      groupId: aim.groupId,
      screenId: aim.screenId,
      priority: priority.optional(),
      ...when,
      startsAt: isoInstant("A takeover's start").optional(),
      endsAt: isoInstant("A takeover's end").optional(),
      ifVersion,
      idempotencyKey,
    })
    .refine(aimed, AIMED),
  // ------------------------------------------------------------ screens
  list_screens: z.object({ selector: selector.optional().describe('Only the screens it matches; omit for every screen'), ...pageInput }),
  list_screen_status: z.object({ ...pageInput }),
  get_screen: z.object({ screenId: id('screen') }),
  update_screen: z
    .strictObject({
      screenId: id('screen'),
      name: name('screen').optional(),
      timezone: timezone.optional(),
      locale: locale.nullable().optional(),
      orientation: orientation.optional(),
      displayHours: displayHours.nullable().optional(),
      ifVersion,
    })
    .refine(
      (v) => v.name !== undefined || v.timezone !== undefined || v.locale !== undefined || v.orientation !== undefined || v.displayHours !== undefined,
      'give at least one of name, timezone, locale, orientation or displayHours to change',
    ),
  screen_command: z.strictObject({
    screenId: id('screen'),
    command: z.enum(SCREEN_COMMANDS).describe('identify, restart, display_on, display_off or display_auto'),
  }),
  revoke_screen_credential: z.object({ screenId: id('screen'), credentialId: id('credential') }),
  // ------------------------------------------------------------ settings
  get_org_settings: z.object({}),
  update_org_settings: z
    .object({
      timezone: timezone.nullable().optional(),
      locale: locale.nullable().optional(),
      displayHours: displayHours.nullable().optional(),
      updateWindow: updateWindow.optional(),
      unreachableAfterMinutes: unreachableAfterMinutes.optional(),
      editorsPublish: editorsPublish.optional(),
      auditRetentionDays: auditRetentionDays.optional(),
      alerts: z
        .object({
          screen_offline: alertRule.partial().optional(),
          publish_finished: alertRule.partial().optional(),
          agent_refused: alertRule.partial().optional(),
          publish_requested: alertRule.partial().optional(),
        })
        .optional()
        .describe('Per kind, the fields of its rule to change; the rest stay'),
      ifVersion,
    })
    .refine((v) => Object.keys(v).some((k) => k !== 'ifVersion'), 'nothing to change'),
  // ------------------------------------------------------------ spots
  list_spots: z.object({
    ...pageInput,
    kind: z.enum(SPOT_KINDS).optional().describe('Only spots of this kind'),
    unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'),
  }),
  get_spot: z.object({ spotId: id('spot'), published: z.boolean().optional().describe("The version screens have, not the draft's") }),
  save_spot: z.strictObject({
    spotId: id('spot').optional().describe('The spot to change; omit to create one'),
    name: name('spot').optional(),
    kind: z.enum(SPOT_KINDS).optional().describe("A new spot's kind; fixed once made"),
    durationMs: durationMs.optional(),
    templateVersionId: id('template version').optional().describe("A new template spot's template version; fixed once made"),
    ...kindInput,
    sample: z.boolean().optional().describe("A new template spot: start with the template's sample copy in place of data (describe(spot))"),
    ifVersion,
    idempotencyKey,
  }),
  revert_spot_draft: decideSpotInput,
  keep_spot_draft: decideSpotInput,
  get_spot_preview: z.object({ orientation, templateVersionId: id('template version').optional(), brandKitId: id('brand kit').optional() }),
  delete_spot: z.object({ spotId: id('spot'), ifVersion }),
  // ------------------------------------------------------------ templates
  list_templates: z.object({ status: z.enum(TEMPLATE_STATUSES).optional().describe('Only versions with this status'), ...pageInput }),
  get_template: z.object({ templateId: id('template') }),
  register_template_version: z.object({
    manifest: z.record(z.string(), z.unknown()).describe("The built template's template.json, with the protocol the build added"),
    bundleId: sha('bundle').describe("SHA-256 of the built HTML file, uploaded to the owner's prefix"),
    sourcesId: sha('sources').describe("SHA-256 of the author's sources, uploaded as a JSON object of file name to text"),
  }),
  set_template_version_status: z.object({
    templateVersionId: id('template version'),
    status: z.enum(['approved', 'retired']),
  }),
  // ------------------------------------------------------------ uploading
  start_upload: z
    .strictObject({
      kind: z.enum(['image', 'video']),
      assetId: id('asset').optional().describe('image only: a pending image whose upload URLs expired; nothing else with it'),
      name: name('asset').optional(),
      renditions: renditionsInput.optional().describe('image: its landscape and portrait renditions'),
      sha256: videoFileInput.sha256.optional().describe("video: the file's SHA-256"),
      type: videoFileInput.type.optional(),
      size: videoFileInput.size.optional(),
      idempotencyKey,
    })
    .superRefine((v, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (v.kind === 'image' && v.assetId !== undefined) {
        for (const k of ['name', 'renditions', ...VIDEO_ONLY] as const) if (v[k] !== undefined) issue(k, `${k} is for a new upload: an assetId renews one`);
        return;
      }
      if (v.name === undefined) issue('name', `a new ${v.kind} needs a name`);
      if (v.kind === 'image') {
        if (v.renditions === undefined) issue('renditions', 'a new image needs its renditions');
        for (const k of VIDEO_ONLY) if (v[k] !== undefined) issue(k, `${k} is for a video`);
        return;
      }
      if (v.assetId !== undefined) issue('assetId', "a video's upload is not renewed: start it again");
      if (v.renditions !== undefined) issue('renditions', 'renditions are for an image');
      for (const k of VIDEO_ONLY) if (v[k] === undefined) issue(k, `a video needs its ${k}`);
    }),
  finalize_upload: z.strictObject({
    assetId: id('asset'),
    uploadId: z.string().min(1).max(1024).optional().describe("video only: start_upload's uploadId"),
    parts: videoParts.optional().describe("video only: each part's number and the ETag its PUT returned"),
  }),
  // ------------------------------------------------------------ read
  read: readInput(READ_TYPE_NAMES),
  describe: describeInput(READ_TYPE_NAMES),
} satisfies Record<ToolName, z.ZodType>;

/** What the tool named `N` takes, as a caller sends it. */
export type ToolInput<N extends ToolName> = z.input<(typeof inputs)[N]>;
