/**
 * The D1 schema. Private to this package: everything outside reaches these tables through
 * `scoped(db, orgId)` in `./scoped.ts`. `test/boundary.test.ts` fails if anything else imports
 * this file.
 *
 * Rules, from docs/backend-plan.md#data-model-d1:
 *  - Text ids matching the contract's `ID_PATTERN`; integer millisecond timestamps.
 *  - Every tenant table has `org_id NOT NULL`, and its indexes lead with `org_id`.
 *  - Every row is unique on `(org_id, id)`, and references between tenant rows are composite
 *    `(org_id, x_id)` foreign keys, so a row cannot point into another org.
 *
 * Exceptions, each deliberate:
 *  - `templates` and `template_versions`: a null `org_id` is a base template every org can use.
 *    A spot references a template version by id alone, and the repository checks the version is
 *    the org's own or a base one.
 *  - `pairing_codes` exist before any org claims them, so `claimed_org_id` is nullable.
 *  - `platform_audit_log` records changes made outside any org (base templates); it has no org.
 *
 * Every tenant `org_id` references Better Auth's `organization` table, with no cascade: an org
 * cannot be deleted while it holds content.
 */
import { sql } from 'drizzle-orm';
import { check, customType, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const orgId = () => text('org_id').notNull().references(() => organization.id);
const created = () => integer('created_at').notNull().$defaultFn(() => Date.now());
const updated = () =>
  integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());

// --------------------------------------------------------------- Better Auth

/*
 * Better Auth's tables (M3-09), as `auth generate` in apps/api writes them for its options:
 * camelCase columns, `date` columns holding ISO strings. Better Auth reads and writes them
 * itself; apps/api/test/auth-schema.test.ts checks it finds nothing missing. Not tenant tables.
 */
const date = customType<{ data: string }>({ dataType: () => 'date' });
const bigint = customType<{ data: number }>({ dataType: () => 'bigint' });

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified').notNull(),
  image: text('image'),
  createdAt: date('createdAt').notNull(),
  updatedAt: date('updatedAt').notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: date('expiresAt').notNull(),
    token: text('token').notNull().unique(),
    createdAt: date('createdAt').notNull(),
    updatedAt: date('updatedAt').notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('activeOrganizationId'),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: date('accessTokenExpiresAt'),
    refreshTokenExpiresAt: date('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: date('createdAt').notNull(),
    updatedAt: date('updatedAt').notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: date('expiresAt').notNull(),
    createdAt: date('createdAt').notNull(),
    updatedAt: date('updatedAt').notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: date('createdAt').notNull(),
  metadata: text('metadata'),
});

export const member = sqliteTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organizationId').notNull().references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: date('createdAt').notNull(),
  },
  (t) => [index('member_organizationId_idx').on(t.organizationId), index('member_userId_idx').on(t.userId)],
);

export const invitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organizationId').notNull().references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull(),
    expiresAt: date('expiresAt').notNull(),
    createdAt: date('createdAt').notNull(),
    inviterId: text('inviterId').notNull().references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('invitation_organizationId_idx').on(t.organizationId), index('invitation_email_idx').on(t.email)],
);

/** Better Auth's rate-limit counters, per IP and path: in D1 so they survive restarts. */
export const rateLimit = sqliteTable('rateLimit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('lastRequest').notNull(),
});

// ------------------------------------------------------------------ screens

export const screens = sqliteTable(
  'screens',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    locale: text('locale'),
    orientation: text('orientation', { enum: ['landscape', 'portrait'] }).notNull(),
    /** The contract's `DisplayHours`, or null for always on. */
    displayHoursJson: text('display_hours_json'),
    desiredManifestId: text('desired_manifest_id'),
    /** The desired manifest before the current one. A screen may still be fetching its files, so they stay servable. */
    previousManifestId: text('previous_manifest_id'),
    reportedManifestId: text('reported_manifest_id'),
    lastSeenAt: integer('last_seen_at'),
    playerVersion: text('player_version'),
    status: text('status', { enum: ['active', 'revoked'] }).notNull().default('active'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('screens_org_id_uq').on(t.orgId, t.id), index('screens_org_name_idx').on(t.orgId, t.name)],
);

export const screenGroups = sqliteTable(
  'screen_groups',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    name: text('name').notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('screen_groups_org_id_uq').on(t.orgId, t.id)],
);

export const screenGroupMembers = sqliteTable(
  'screen_group_members',
  {
    orgId: orgId(),
    groupId: text('group_id').notNull(),
    screenId: text('screen_id').notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.groupId, t.screenId] }),
    index('screen_group_members_screen_idx').on(t.orgId, t.screenId),
    foreignKey({ columns: [t.orgId, t.groupId], foreignColumns: [screenGroups.orgId, screenGroups.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);

export const screenCredentials = sqliteTable(
  'screen_credentials',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    screenId: text('screen_id').notNull(),
    /** Lowercase hex SHA-256 of the credential's secret. The secret itself is never stored. */
    secretHash: text('secret_hash').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('screen_credentials_org_id_uq').on(t.orgId, t.id),
    index('screen_credentials_screen_idx').on(t.orgId, t.screenId),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);

/** Not a tenant table: a code exists before an org claims it. */
export const pairingCodes = sqliteTable(
  'pairing_codes',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    pollTokenHash: text('poll_token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    claimedOrgId: text('claimed_org_id'),
    claimedScreenId: text('claimed_screen_id'),
    claimedAt: integer('claimed_at'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('pairing_codes_code_uq').on(t.code),
    uniqueIndex('pairing_codes_poll_token_uq').on(t.pollTokenHash),
    foreignKey({ columns: [t.claimedOrgId, t.claimedScreenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);

// ------------------------------------------------------------------- assets

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    name: text('name').notNull(),
    sha256: text('sha256').notNull(),
    type: text('type').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    status: text('status', { enum: ['pending', 'verified', 'rejected'] }).notNull().default('pending'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('assets_org_id_uq').on(t.orgId, t.id), index('assets_org_sha_idx').on(t.orgId, t.sha256)],
);

export const assetRenditions = sqliteTable(
  'asset_renditions',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    assetId: text('asset_id').notNull(),
    orientation: text('orientation', { enum: ['landscape', 'portrait'] }).notNull(),
    sha256: text('sha256').notNull(),
    type: text('type').notNull(),
    size: integer('size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('asset_renditions_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('asset_renditions_asset_orientation_uq').on(t.orgId, t.assetId, t.orientation),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [assets.orgId, assets.id] }).onDelete('cascade'),
  ],
);

// ---------------------------------------------------------------- templates

/** A null `org_id` is a base template. */
export const templates = sqliteTable(
  'templates',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').references(() => organization.id),
    /** The template's own id from `template.json`, e.g. `menu-board`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('templates_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('templates_org_key_uq').on(t.orgId, t.key),
    uniqueIndex('templates_base_key_uq').on(t.key).where(sql`${t.orgId} IS NULL`),
  ],
);

export const templateVersions = sqliteTable(
  'template_versions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').references(() => organization.id),
    templateId: text('template_id').notNull(),
    version: text('version').notNull(),
    /** The contract's `TemplateManifest`. */
    manifestJson: text('manifest_json').notNull(),
    bundleSha256: text('bundle_sha256').notNull(),
    status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull().default('draft'),
    checkReportJson: text('check_report_json'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('template_versions_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('template_versions_org_version_uq').on(t.orgId, t.templateId, t.version),
    uniqueIndex('template_versions_base_version_uq').on(t.templateId, t.version).where(sql`${t.orgId} IS NULL`),
    // Enforced for org rows; SQLite skips a composite key containing a null, so base rows are not.
    foreignKey({ columns: [t.orgId, t.templateId], foreignColumns: [templates.orgId, templates.id] }).onDelete('cascade'),
  ],
);

// ---------------------------------------------------------- spots, playlists

export const spots = sqliteTable(
  'spots',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['template', 'image', 'video', 'url'] }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    /** Template spots. The org's own version or a base one: checked by the repository. */
    templateVersionId: text('template_version_id').references(() => templateVersions.id),
    dataJson: text('data_json'),
    /** Image fields to asset ids, by field name. */
    assetMapJson: text('asset_map_json'),
    /** The contract's `Binding`s, by field name. */
    bindingsJson: text('bindings_json'),
    /** Image and video spots. */
    assetId: text('asset_id'),
    fit: text('fit', { enum: ['cover', 'contain'] }),
    /** URL spots: an https page on another origin. */
    url: text('url'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('spots_org_id_uq').on(t.orgId, t.id),
    index('spots_org_asset_idx').on(t.orgId, t.assetId),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [assets.orgId, assets.id] }),
  ],
);

export const playlists = sqliteTable(
  'playlists',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    name: text('name').notNull(),
    /** The contract's `Transition`. */
    transitionJson: text('transition_json').notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('playlists_org_id_uq').on(t.orgId, t.id)],
);

export const playlistItems = sqliteTable(
  'playlist_items',
  {
    orgId: orgId(),
    playlistId: text('playlist_id').notNull(),
    position: integer('position').notNull(),
    spotId: text('spot_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.playlistId, t.position] }),
    index('playlist_items_spot_idx').on(t.orgId, t.spotId),
    foreignKey({ columns: [t.orgId, t.playlistId], foreignColumns: [playlists.orgId, playlists.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.spotId], foreignColumns: [spots.orgId, spots.id] }),
  ],
);

// ------------------------------------------------------------------ schedule

export const scheduleEntries = sqliteTable(
  'schedule_entries',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    playlistId: text('playlist_id').notNull(),
    priority: integer('priority').notNull().default(0),
    target: text('target', { enum: ['org', 'group', 'screen'] }).notNull(),
    groupId: text('group_id'),
    screenId: text('screen_id'),
    /** Inclusive local dates, `YYYY-MM-DD`, in the screen's time zone. */
    startDate: text('start_date'),
    endDate: text('end_date'),
    /** JSON array of weekdays, 0 = Sunday. Null means every day. */
    daysJson: text('days_json'),
    /** Local `HH:MM`. */
    fromTime: text('from_time'),
    toTime: text('to_time'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('schedule_entries_org_id_uq').on(t.orgId, t.id),
    index('schedule_entries_org_playlist_idx').on(t.orgId, t.playlistId),
    foreignKey({ columns: [t.orgId, t.playlistId], foreignColumns: [playlists.orgId, playlists.id] }),
    foreignKey({ columns: [t.orgId, t.groupId], foreignColumns: [screenGroups.orgId, screenGroups.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
    check(
      'schedule_entries_target_ck',
      sql`(${t.target} = 'org' AND ${t.groupId} IS NULL AND ${t.screenId} IS NULL)
        OR (${t.target} = 'group' AND ${t.groupId} IS NOT NULL AND ${t.screenId} IS NULL)
        OR (${t.target} = 'screen' AND ${t.screenId} IS NOT NULL AND ${t.groupId} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------- publishing

export const publishes = sqliteTable(
  'publishes',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    /** `pending` waits for a person to approve (an agent without publish scope). */
    status: text('status', { enum: ['pending', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'] }).notNull(),
    /** When it is due. Null means now. */
    publishAt: integer('publish_at'),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'device', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: created(),
    finishedAt: integer('finished_at'),
  },
  (t) => [uniqueIndex('publishes_org_id_uq').on(t.orgId, t.id), index('publishes_org_created_idx').on(t.orgId, t.createdAt)],
);

/** Which manifest each screen got from a publish. Rollout is a join against `screens.reported_manifest_id`. */
export const publishScreens = sqliteTable(
  'publish_screens',
  {
    orgId: orgId(),
    publishId: text('publish_id').notNull(),
    screenId: text('screen_id').notNull(),
    manifestId: text('manifest_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.publishId, t.screenId] }),
    index('publish_screens_screen_idx').on(t.orgId, t.screenId),
    foreignKey({ columns: [t.orgId, t.publishId], foreignColumns: [publishes.orgId, publishes.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);

// -------------------------------------------------------------- data sources

export const dataSources = sqliteTable(
  'data_sources',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    name: text('name').notNull(),
    format: text('format', { enum: ['json', 'ical', 'rss'] }).notNull(),
    /** The feed URL, encrypted: a private calendar URL is a secret. */
    urlEncrypted: text('url_encrypted').notNull(),
    refreshS: integer('refresh_s').notNull(),
    nextPollAt: integer('next_poll_at').notNull().default(0),
    etag: text('etag'),
    lastModified: text('last_modified'),
    failures: integer('failures').notNull().default(0),
    /** An error category, never the upstream body. */
    lastError: text('last_error'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('data_sources_org_id_uq').on(t.orgId, t.id)],
);

/** The latest snapshot of each source, at most 64 kB. */
export const dataSnapshots = sqliteTable(
  'data_snapshots',
  {
    orgId: orgId(),
    dataSourceId: text('data_source_id').notNull(),
    /** Hash of the data; what a screen reports holding. */
    version: text('version').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    dataJson: text('data_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.dataSourceId] }),
    foreignKey({ columns: [t.orgId, t.dataSourceId], foreignColumns: [dataSources.orgId, dataSources.id] }).onDelete('cascade'),
  ],
);

// ------------------------------------------------------------- audit, counts

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    at: integer('at').notNull().$defaultFn(() => Date.now()),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'device', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    /** The app the actor acted through: `cms`, `sf-push`, or an agent's OAuth client id. */
    clientId: text('client_id'),
    action: text('action').notNull(),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    detailJson: text('detail_json'),
  },
  (t) => [uniqueIndex('audit_log_org_id_uq').on(t.orgId, t.id), index('audit_log_org_at_idx').on(t.orgId, t.at)],
);

/**
 * Idempotency keys: one row per creating tool call made with a key, written in the same batch as
 * the change and its audit row. A retry with the same key gets `output_json` back and writes
 * nothing; the same key with another action or input is refused. Keyed per org, so two orgs'
 * keys never meet. Kept indefinitely for now; expiring old keys is M3-24's.
 */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    orgId: orgId(),
    key: text('key').notNull(),
    /** The tool name. */
    action: text('action').notNull(),
    /** SHA-256 of the canonical JSON of the input, without the key. */
    inputSha256: text('input_sha256').notNull(),
    outputJson: text('output_json').notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

/**
 * Changes the platform makes outside any org, such as registering a base template. Not a tenant
 * table: no org reads it. Written only by the tool dispatcher, through `platform(db)`.
 */
export const platformAuditLog = sqliteTable(
  'platform_audit_log',
  {
    id: text('id').primaryKey(),
    at: integer('at').notNull().$defaultFn(() => Date.now()),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'device', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    clientId: text('client_id'),
    action: text('action').notNull(),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    detailJson: text('detail_json'),
  },
  (t) => [index('platform_audit_log_at_idx').on(t.at)],
);

/**
 * Plays of one spot on one screen in one UTC hour. No foreign key to the spot: counts outlive
 * the spots they count.
 */
export const playCounts = sqliteTable(
  'play_counts',
  {
    orgId: orgId(),
    screenId: text('screen_id').notNull(),
    /** Start of the UTC hour, in milliseconds. */
    hour: integer('hour').notNull(),
    spotId: text('spot_id').notNull(),
    plays: integer('plays').notNull().default(0),
    ms: integer('ms').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.screenId, t.hour, t.spotId] }),
    index('play_counts_org_hour_idx').on(t.orgId, t.hour),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);
