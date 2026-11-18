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
 *  - Content rows (spots, playlists, schedule entries, data sources, and brand kits) are keyed
 *    `(org_id, id)`: content names their ids, so two orgs may use the same one. Every other
 *    tenant row has a global `id` primary key that only the server makes (`scoped.ts`), so no
 *    caller can collide with or probe another org's ids.
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

const orgId = () =>
  text('org_id')
    .notNull()
    .references(() => organization.id);
const created = () =>
  integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now());
const updated = () =>
  integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());
/**
 * Drafts (spots, playlists, schedule entries): the row's own columns are the draft, which edits
 * change. `published_json` is the version screens get, a copy of the draft's content columns
 * (and a playlist's items) taken when a publish promoted it; null until then. Only
 * `stage.publish` in ./scoped.ts writes it.
 */
const publishedJson = () => text('published_json');
/**
 * A row people edit: starts at 1 and moves on with every change through a repository's `stage`,
 * so an update made from an old read can be refused (`ifVersion`, ./scoped.ts). Not
 * `version`, which a template version already has for its semver.
 */
const rowVersion = () => integer('row_version').notNull().default(1);
const publishedAt = () => integer('published_at');

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
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    organizationId: text('organizationId')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: date('createdAt').notNull(),
  },
  (t) => [index('member_organizationId_idx').on(t.organizationId), index('member_userId_idx').on(t.userId)],
);

export const invitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organizationId')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull(),
    expiresAt: date('expiresAt').notNull(),
    createdAt: date('createdAt').notNull(),
    inviterId: text('inviterId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    /**
     * The screen's last heartbeat (`ScreenHeartbeat` in the API): display, clock, cache, fallback and
     * refused data, as its last sync reported them. Null until it first syncs.
     */
    heartbeatJson: text('heartbeat_json'),
    /**
     * The contract's `DisplayOverride` set from the CMS (wake now, sleep now), or null. Sent to the
     * screen over its socket when set, and in each sync while the screen reports something else.
     * Ends by itself at its `until`.
     */
    displayOverrideJson: text('display_override_json'),
    /** The `epoch` of the screen's play count batches, and the highest `seq` stored in it (contract `SyncRequest`). */
    syncEpoch: text('sync_epoch'),
    syncAckSeq: integer('sync_ack_seq').notNull().default(0),
    status: text('status', { enum: ['active', 'revoked'] })
      .notNull()
      .default('active'),
    rowVersion: rowVersion(),
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
    /** Moves on when the name or the members change. */
    rowVersion: rowVersion(),
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
    /**
     * The credential the screen last collected, and when it first collected one. A repeat poll
     * (the reply was lost) replaces that credential while it is unused (M3 review fix 2).
     */
    collectedCredentialId: text('collected_credential_id'),
    collectedAt: integer('collected_at'),
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
    status: text('status', { enum: ['pending', 'verified', 'rejected'] })
      .notNull()
      .default('pending'),
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
    status: text('status', { enum: ['draft', 'approved', 'retired'] })
      .notNull()
      .default('draft'),
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
    id: text('id').notNull(),
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
    publishedJson: publishedJson(),
    publishedAt: publishedAt(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    index('spots_org_asset_idx').on(t.orgId, t.assetId),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [assets.orgId, assets.id] }),
  ],
);

export const playlists = sqliteTable(
  'playlists',
  {
    id: text('id').notNull(),
    orgId: orgId(),
    name: text('name').notNull(),
    /** The contract's `Transition`. */
    transitionJson: text('transition_json').notNull(),
    publishedJson: publishedJson(),
    publishedAt: publishedAt(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.id] })],
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
    id: text('id').notNull(),
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
    publishedJson: publishedJson(),
    publishedAt: publishedAt(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
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

/**
 * Org-wide settings, one row per org, made on first write. The default playlist plays on every
 * screen when no schedule entry applies; it cannot be deleted while it is the default.
 */
export const orgSettings = sqliteTable(
  'org_settings',
  {
    orgId: text('org_id')
      .primaryKey()
      .references(() => organization.id),
    defaultPlaylistId: text('default_playlist_id'),
    /** Defaults for new screens (M3-42): IANA time zone, BCP 47 locale, the contract's `DisplayHours`. Null means not set. */
    timezone: text('timezone'),
    locale: text('locale'),
    displayHoursJson: text('display_hours_json'),
    /** `{ from, to }` as HH:MM local time: when player and system updates may run. Null for the default. */
    updateWindowJson: text('update_window_json'),
    /** How long a screen may go unheard from before it alerts. Null for the default (15 minutes). */
    unreachableAfterMs: integer('unreachable_after_ms'),
    /** Who gets which alert, by email (packages/tools `alerts`). Null for the defaults. */
    alertsJson: text('alerts_json'),
    /** An org with no row has every default, at version 1; each `settings.stage.set` moves it on. */
    rowVersion: rowVersion(),
    updatedAt: updated(),
  },
  (t) => [foreignKey({ columns: [t.orgId, t.defaultPlaylistId], foreignColumns: [playlists.orgId, playlists.id] })],
);

/**
 * A screen's incidents (M3-42): one row from when it was found unheard from past the org's
 * threshold until it was heard from again. At most one open per screen (the partial index), so
 * an alert is sent once per incident however often the check runs.
 */
export const screenIncidents = sqliteTable(
  'screen_incidents',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    screenId: text('screen_id').notNull(),
    kind: text('kind', { enum: ['offline'] }).notNull(),
    /** The screen's `last_seen_at` when the incident opened; it clears once the screen is seen after it. */
    lastSeenAt: integer('last_seen_at').notNull(),
    openedAt: integer('opened_at').notNull(),
    clearedAt: integer('cleared_at'),
  },
  (t) => [
    uniqueIndex('screen_incidents_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('screen_incidents_open_uq').on(t.orgId, t.screenId, t.kind).where(sql`${t.clearedAt} IS NULL`),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);

// --------------------------------------------------------------------- brand

/**
 * Brand kits: an org's colours, fonts, logo and shape. Keyed `(org_id, id)` and the id is always
 * made by the server (`bk_...`), never chosen by a caller, so two orgs can never collide on one.
 * Read at publish and frozen into each manifest; editing a kit reaches screens at the next publish.
 */
export const brandKits = sqliteTable(
  'brand_kits',
  {
    id: text('id').notNull(),
    orgId: orgId(),
    name: text('name').notNull(),
    /**
     * The contract's `BrandColors` as `#rrggbb`, except that `onPrimary` and `onAccent` may be
     * absent: absent means derived for contrast at publish (compiler `onColor`).
     */
    colorsJson: text('colors_json').notNull(),
    shape: text('shape', { enum: ['square', 'soft', 'round'] }).notNull(),
    /** Font catalogue ids (compiler `FONTS`), `<owner>/<id>`. Null: the template's own font. */
    displayFontId: text('display_font_id'),
    bodyFontId: text('body_font_id'),
    /** Image assets, SVG or PNG. */
    logoOnDarkAssetId: text('logo_on_dark_asset_id'),
    logoOnLightAssetId: text('logo_on_light_asset_id'),
    rowVersion: rowVersion(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.logoOnDarkAssetId], foreignColumns: [assets.orgId, assets.id] }),
    foreignKey({ columns: [t.orgId, t.logoOnLightAssetId], foreignColumns: [assets.orgId, assets.id] }),
  ],
);

/**
 * Which kit applies where: the org's default (`org`), a group's, a screen's. At most one per
 * target. A screen uses its own, else its groups' (a conflict when they differ), else the
 * default: compiler `chooseBrandKit`. Deleting a group or screen drops its row.
 */
export const brandAssignments = sqliteTable(
  'brand_assignments',
  {
    orgId: orgId(),
    target: text('target', { enum: ['org', 'group', 'screen'] }).notNull(),
    groupId: text('group_id'),
    screenId: text('screen_id'),
    brandKitId: text('brand_kit_id').notNull(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('brand_assignments_org_uq').on(t.orgId).where(sql`${t.target} = 'org'`),
    uniqueIndex('brand_assignments_group_uq').on(t.orgId, t.groupId).where(sql`${t.groupId} IS NOT NULL`),
    uniqueIndex('brand_assignments_screen_uq').on(t.orgId, t.screenId).where(sql`${t.screenId} IS NOT NULL`),
    index('brand_assignments_kit_idx').on(t.orgId, t.brandKitId),
    foreignKey({ columns: [t.orgId, t.brandKitId], foreignColumns: [brandKits.orgId, brandKits.id] }),
    foreignKey({ columns: [t.orgId, t.groupId], foreignColumns: [screenGroups.orgId, screenGroups.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
    check(
      'brand_assignments_target_ck',
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
    id: text('id').notNull(),
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
  (t) => [primaryKey({ columns: [t.orgId, t.id] })],
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
    at: integer('at')
      .notNull()
      .$defaultFn(() => Date.now()),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'device', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    /** The app the actor acted through: `cms`, `sf-push`, or an agent's OAuth client id. */
    clientId: text('client_id'),
    action: text('action').notNull(),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    detailJson: text('detail_json'),
  },
  (t) => [
    uniqueIndex('audit_log_org_id_uq').on(t.orgId, t.id),
    index('audit_log_org_at_idx').on(t.orgId, t.at),
    // A screen's recent events in the CMS: what was done to it, newest first.
    index('audit_log_org_target_idx').on(t.orgId, t.targetKind, t.targetId, t.at),
  ],
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
    at: integer('at')
      .notNull()
      .$defaultFn(() => Date.now()),
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
