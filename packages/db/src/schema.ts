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
 *  - `alert_deliveries_due_idx` leads with the next attempt: the delivery run looks across orgs.
 *
 * Every tenant `org_id` references Better Auth's `organization` table, with no cascade: an org
 * cannot be deleted while it holds content.
 */
import { SCREEN_KINDS } from '@signforge/contract';
import { sql } from 'drizzle-orm';
import { check, customType, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { newId } from './ids';

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
 * A row people edit: starts at 1 (a draft made again with a deleted one's id starts above its tombstone)
 * and moves on with every change through a repository's `stage`,
 * so an update made from an old read can be refused (`ifVersion`, ./scoped.ts). Not
 * `version`, which a template version already has for its semver.
 */
const rowVersion = () => integer('row_version').notNull().default(1);
const publishedAt = () => integer('published_at');
/**
 * The `row_version` a publish promoted (#361): the draft has changes screens do not have while it is
 * behind `row_version`, as every edit moves that on and a publish does not. Null until published.
 */
const publishedVersion = () => integer('published_version');
/**
 * Which row a draft is across delete and make-again: a content id may be chosen again once its
 * row is deleted, and `stage.publish` checks this with the version. Since migration 0020 the
 * version alone tells the rows apart (`draft_tombstones`); this stays as a second check, as
 * dropping it would rebuild the tables. Random, fixed at insert (no SQL default: Drizzle would
 * use it instead). Null on rows made before migration 0019.
 */
const incarnation = () => text('incarnation').$defaultFn(() => newId('inc'));

// --------------------------------------------------------------- Better Auth

/*
 * Better Auth's tables (M3-09), as `auth generate` in apps/api writes them for its options:
 * camelCase columns, `date` columns holding ISO strings. Better Auth reads and writes them
 * itself; apps/api/test/auth-platform.test.ts checks it finds nothing missing. Not tenant tables.
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
  /** The org the user last made active, which a new session starts in (`startingOrg`). Ours, declared to Better Auth as an additional field. */
  lastActiveOrganizationId: text('lastActiveOrganizationId'),
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

/*
 * Better Auth's OAuth provider (`@better-auth/oauth-provider`, M4-04): the clients agents register,
 * the one resource (`/mcp`), consents, and tokens, stored only as SHA-256 hashes. Columns as its CLI
 * generates them for apps/api's options. `referenceId` on a consent, a token or a refresh token is
 * the agent grant's id (`agentGrants`); the indexes on it are ours, for revoking a grant's tokens.
 */
export const oauthClient = sqliteTable(
  'oauthClient',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().unique(),
    clientSecret: text('clientSecret'),
    clientDiscoveryId: text('clientDiscoveryId'),
    disabled: integer('disabled'),
    skipConsent: integer('skipConsent'),
    enableEndSession: integer('enableEndSession'),
    subjectType: text('subjectType'),
    scopes: text('scopes'),
    clientCredentialsScopes: text('clientCredentialsScopes'),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: date('createdAt'),
    updatedAt: date('updatedAt'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts'),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('softwareId'),
    softwareVersion: text('softwareVersion'),
    softwareStatement: text('softwareStatement'),
    redirectUris: text('redirectUris').notNull(),
    postLogoutRedirectUris: text('postLogoutRedirectUris'),
    backchannelLogoutUri: text('backchannelLogoutUri'),
    backchannelLogoutSessionRequired: integer('backchannelLogoutSessionRequired'),
    tokenEndpointAuthMethod: text('tokenEndpointAuthMethod'),
    applicationType: text('applicationType'),
    jwks: text('jwks'),
    jwksUri: text('jwksUri'),
    grantTypes: text('grantTypes'),
    responseTypes: text('responseTypes'),
    requirePKCE: integer('requirePKCE'),
    dpopBoundAccessTokens: integer('dpopBoundAccessTokens'),
    referenceId: text('referenceId'),
    metadata: text('metadata'),
  },
  (t) => [index('oauthClient_userId_idx').on(t.userId)],
);

export const oauthResource = sqliteTable('oauthResource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('accessTokenTtl'),
  refreshTokenTtl: integer('refreshTokenTtl'),
  signingAlgorithm: text('signingAlgorithm'),
  signingKeyId: text('signingKeyId'),
  allowedScopes: text('allowedScopes'),
  customClaims: text('customClaims'),
  dpopBoundAccessTokensRequired: integer('dpopBoundAccessTokensRequired'),
  disabled: integer('disabled'),
  createdAt: date('createdAt'),
  updatedAt: date('updatedAt'),
  policyVersion: integer('policyVersion'),
  metadata: text('metadata'),
});

export const oauthClientResource = sqliteTable(
  'oauthClientResource',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resourceId')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: text('metadata'),
    createdAt: date('createdAt'),
  },
  (t) => [
    index('oauthClientResource_clientId_idx').on(t.clientId),
    index('oauthClientResource_resourceId_idx').on(t.resourceId),
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(t.clientId, t.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  'oauthRefreshToken',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('sessionId').references(() => session.id, { onDelete: 'set null' }),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requestedUserInfoClaims'),
    expiresAt: date('expiresAt').notNull(),
    createdAt: date('createdAt').notNull(),
    revoked: date('revoked'),
    rotatedAt: date('rotatedAt'),
    rotationReplayResponse: text('rotationReplayResponse'),
    rotationReplayExpiresAt: date('rotationReplayExpiresAt'),
    authTime: date('authTime'),
    confirmation: text('confirmation'),
    scopes: text('scopes').notNull(),
  },
  (t) => [
    index('oauthRefreshToken_clientId_idx').on(t.clientId),
    index('oauthRefreshToken_sessionId_idx').on(t.sessionId),
    index('oauthRefreshToken_userId_idx').on(t.userId),
    index('oauthRefreshToken_authorizationCodeId_idx').on(t.authorizationCodeId),
    index('oauthRefreshToken_referenceId_idx').on(t.referenceId),
  ],
);

export const oauthAccessToken = sqliteTable(
  'oauthAccessToken',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('sessionId').references(() => session.id, { onDelete: 'set null' }),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requestedUserInfoClaims'),
    refreshId: text('refreshId').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: date('expiresAt').notNull(),
    createdAt: date('createdAt').notNull(),
    revoked: date('revoked'),
    confirmation: text('confirmation'),
    scopes: text('scopes').notNull(),
  },
  (t) => [
    index('oauthAccessToken_clientId_idx').on(t.clientId),
    index('oauthAccessToken_sessionId_idx').on(t.sessionId),
    index('oauthAccessToken_userId_idx').on(t.userId),
    index('oauthAccessToken_authorizationCodeId_idx').on(t.authorizationCodeId),
    index('oauthAccessToken_refreshId_idx').on(t.refreshId),
    index('oauthAccessToken_referenceId_idx').on(t.referenceId),
  ],
);

export const oauthConsent = sqliteTable(
  'oauthConsent',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requestedUserInfoClaims'),
    scopes: text('scopes').notNull(),
    createdAt: date('createdAt').notNull(),
    updatedAt: date('updatedAt').notNull(),
  },
  (t) => [
    index('oauthConsent_clientId_idx').on(t.clientId),
    index('oauthConsent_userId_idx').on(t.userId),
    index('oauthConsent_referenceId_idx').on(t.referenceId),
  ],
);

export const oauthClientAssertion = sqliteTable('oauthClientAssertion', {
  id: text('id').primaryKey(),
  expiresAt: date('expiresAt').notNull(),
});

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
    /** The contract's `ScreenKind`: a device, or a test screen in a browser tab. Set at the claim, from what the screen said at pair start. */
    kind: text('kind', { enum: SCREEN_KINDS }).notNull().default('device'),
    /** The contract's `DisplayHours`, or null for always on. */
    displayHoursJson: text('display_hours_json'),
    desiredManifestId: text('desired_manifest_id'),
    /** The desired manifest before the current one. A screen may still be fetching its files, so they stay servable. */
    previousManifestId: text('previous_manifest_id'),
    reportedManifestId: text('reported_manifest_id'),
    /**
     * When the screen observed `reported_manifest_id`, on the server's clock: a report replaces it
     * only if observed later (gh-44). A report without a trusted time counts as observed when it
     * arrived. Null on rows reported before migration 0021.
     */
    reportedManifestAt: integer('reported_manifest_at'),
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

/**
 * A screen's `key=value` labels, one value per key. The value is stored as typed (trimmed);
 * selectors compare it case-insensitively in `@signforge/compiler/selector`, not in SQL, whose
 * `lower()` folds ASCII only. System labels (orientation, kind, ...) come from the screen's
 * settings and are never rows here.
 */
export const screenLabels = sqliteTable(
  'screen_labels',
  {
    orgId: orgId(),
    screenId: text('screen_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.screenId, t.key] }),
    index('screen_labels_key_value_idx').on(t.orgId, t.key, t.value),
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
    /** What the screen said it is at pair start (contract `PairStartRequest`). */
    kind: text('kind', { enum: SCREEN_KINDS }).notNull().default('device'),
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
    /** The rendition's sample (`ManifestFile.sample`), a PNG; null for SVG, an image with transparency, or an upload from before samples (0028). */
    sampleSha256: text('sample_sha256'),
    sampleSize: integer('sample_size'),
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
    /**
     * Template spots: the contract's `SampleFields`, the fields of the draft still holding the
     * template's sample copy New spot started it with (#360); null for none. Draft only: never published.
     */
    sampleFieldsJson: text('sample_fields_json'),
    /** Moves on with every edit of the draft; publishing does not move it. */
    rowVersion: rowVersion(),
    incarnation: incarnation(),
    publishedJson: publishedJson(),
    publishedAt: publishedAt(),
    publishedVersion: publishedVersion(),
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
    /** Moves on with every edit of the draft, its items too; publishing does not move it. */
    rowVersion: rowVersion(),
    incarnation: incarnation(),
    publishedJson: publishedJson(),
    publishedAt: publishedAt(),
    publishedVersion: publishedVersion(),
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

/**
 * The draft kept beside a spot's or playlist's draft while an agent's draft is on it (#116), so a
 * person's edit is never lost to an agent's. `holds: 'person'`: the draft an agent first wrote over
 * (a person's, or the published version as it stood in the draft), which Reject puts back. `holds:
 * 'agent'`: the agent's draft a Reject set aside, which its Undo puts back. One per draft; it goes
 * with a publish, a person's edit and the draft itself (the foreign keys cascade, so a draft deleted
 * and made again with its id starts with none).
 */
export const draftSnapshots = sqliteTable(
  'draft_snapshots',
  {
    orgId: orgId(),
    spotId: text('spot_id'),
    playlistId: text('playlist_id'),
    holds: text('holds', { enum: ['person', 'agent'] }).notNull(),
    /** The kept draft's content as `published_json` holds content (`contentJson`, a playlist's with its items). */
    contentJson: text('content_json').notNull(),
    /** A spot's `sample_fields_json` as it was with that draft (#360, #392): it goes back with it. */
    sampleFieldsJson: text('sample_fields_json'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('draft_snapshots_spot_uq').on(t.orgId, t.spotId),
    uniqueIndex('draft_snapshots_playlist_uq').on(t.orgId, t.playlistId),
    foreignKey({ columns: [t.orgId, t.spotId], foreignColumns: [spots.orgId, spots.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.playlistId], foreignColumns: [playlists.orgId, playlists.id] }).onDelete('cascade'),
    check('draft_snapshots_one_draft', sql`(${t.spotId} IS NULL) <> (${t.playlistId} IS NULL)`),
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
    /** A takeover's absolute bounds, epoch ms: `starts_at` inclusive, `ends_at` exclusive. An entry with `ends_at` is a takeover. */
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    /**
     * Set when a published entry is deleted: screens keep its published version until a publish
     * applies the deletion (one of everything, or one that pins it), which deletes the row. An entry
     * never published is deleted at once.
     */
    deletedAt: integer('deleted_at'),
    /** Moves on with every edit of the draft; publishing does not move it. */
    rowVersion: rowVersion(),
    incarnation: incarnation(),
    publishedJson: publishedJson(),
    publishedAt: publishedAt(),
    publishedVersion: publishedVersion(),
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
 * The last version of each deleted draft (spot, playlist, schedule entry), so a row made again
 * with its id continues from it (./scoped.ts) and an edit made from the old row cannot land on
 * the new one: versions of an id never repeat within an org. Written only by the delete triggers
 * migration 0020 adds, which also catch a schedule entry deleted with its screen or group. No
 * `id` column: a row is the id of a row in `draft_table`.
 */
export const draftTombstones = sqliteTable(
  'draft_tombstones',
  {
    orgId: orgId(),
    draftTable: text('draft_table', { enum: ['spots', 'playlists', 'schedule_entries'] }).notNull(),
    draftId: text('draft_id').notNull(),
    rowVersion: integer('row_version').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.draftTable, t.draftId] })],
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
    /** Whether editors may publish, or only owners (owner decision Q7). */
    editorsPublish: integer('editors_publish', { mode: 'boolean' }).notNull().default(true),
    /** Days the org's audit rows are kept, then deleted by the daily job (./retention.ts). Null for the default (365). */
    auditRetentionDays: integer('audit_retention_days'),
    /** An org with no row has every default, at version 1; each `settings.stage.set` moves it on. */
    rowVersion: rowVersion(),
    /**
     * Moves on with every publish (`publishes.stage.advance`), so publishes commit in the order
     * they read: not a setting, so it leaves the version and `updatedAt` alone.
     */
    publishRevision: integer('publish_revision').notNull().default(0),
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

/**
 * Where an org's alerts go besides email (#88): at most one Slack incoming webhook and one
 * outgoing webhook, so keyed `(org_id, kind)` as `org_settings` is keyed by org. The URLs, and the
 * webhook's signing secret, are sealed as feed URLs are (apps/api src/data/cipher.ts); `host` is
 * what Settings shows of them.
 */
export const alertChannels = sqliteTable(
  'alert_channels',
  {
    orgId: orgId(),
    kind: text('kind', { enum: ['slack', 'webhook'] }).notNull(),
    host: text('host').notNull(),
    urlEncrypted: text('url_encrypted').notNull(),
    /** The webhook's signing secret, sealed; null for Slack, which signs nothing. */
    secretEncrypted: text('secret_encrypted'),
    secretSetAt: integer('secret_set_at'),
    /** The actor id that last set it. */
    connectedBy: text('connected_by').notNull(),
    rowVersion: rowVersion(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.kind] })],
);

/**
 * The model an org's built-in agent uses with its own key (#261, docs/proposals/cms-agent.md): one
 * row per org, absent while the org uses SignForge's demo model. The key is sealed by the API
 * (`ai-key:<org>/<provider>`) and never read back out but to call the provider; `key_last4` is all a
 * person is shown. Model ids are the exact ones the owner chose from the provider's list.
 */
export const orgAiProviders = sqliteTable('org_ai_providers', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id),
  provider: text('provider', { enum: ['anthropic', 'openai-compatible'] }).notNull(),
  /** An OpenAI-compatible endpoint's base address (#262), https and public; null for Anthropic, whose address is fixed. */
  baseUrl: text('base_url'),
  /**
   * Whether an OpenAI-compatible endpoint takes images and returns output to a JSON schema, as its owner
   * says: what Fill from a flyer needs (#262). Not read for Anthropic, which does both.
   */
  acceptsImages: integer('accepts_images', { mode: 'boolean' }).notNull().default(false),
  jsonSchemaOutput: integer('json_schema_output', { mode: 'boolean' }).notNull().default(false),
  keySealed: text('key_sealed').notNull(),
  keyLast4: text('key_last4').notNull(),
  /** The user who saved the key, and when. */
  keySavedBy: text('key_saved_by').notNull(),
  keySavedAt: integer('key_saved_at').notNull(),
  /** When a test last reached the provider with this key; null until one does, and again when the key is replaced. */
  verifiedAt: integer('verified_at'),
  /** For fills (fast) and the drawer (capable); null until chosen. */
  fastModel: text('fast_model'),
  capableModel: text('capable_model'),
  /** Agent turns a day across the org, then it pauses until midnight in the org's time zone; null for no ceiling. */
  dailyTurnCeiling: integer('daily_turn_ceiling'),
  rowVersion: rowVersion(),
  createdAt: created(),
  updatedAt: updated(),
});

/**
 * One alert event on its way to one channel (#88), queued by the alert check or a test send and
 * sent by the delivery run (apps/api src/deliveries.ts), which retries with backoff until
 * `give_up_at`. Kept 7 days, as the delivery log (./retention.ts). `event_json` is the event as a
 * webhook receives it, with no secret in it.
 */
export const alertDeliveries = sqliteTable(
  'alert_deliveries',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    channel: text('channel', { enum: ['email', 'slack', 'webhook'] }).notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    eventJson: text('event_json').notNull(),
    /** Email only (a test send): the member it goes to. */
    toUserId: text('to_user_id'),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    giveUpAt: integer('give_up_at').notNull(),
    lastAttemptAt: integer('last_attempt_at'),
    /** While an attempt is being sent: until when its claim holds. Null once it is settled. A retry is refused while it holds. */
    leasedUntil: integer('leased_until'),
    /** The receiver's HTTP status on the last attempt; null for none (no answer, or email). */
    lastHttpStatus: integer('last_http_status'),
    /** Why the last attempt failed, as a category; never the receiver's body. */
    lastError: text('last_error'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('alert_deliveries_org_id_uq').on(t.orgId, t.id),
    // One delivery per event and channel, so an event queued twice is sent once.
    uniqueIndex('alert_deliveries_event_uq').on(t.orgId, t.eventId, t.channel),
    index('alert_deliveries_org_created_idx').on(t.orgId, t.createdAt),
    // Not led by the org, deliberately: the delivery run finds what is due in every org, and this
    // index holds only the pending rows, so it stays small however long the log is.
    index('alert_deliveries_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
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
    /** `pending` is not written: a publish waiting for a person to approve is a `publish_requests` row (M4-09). */
    status: text('status', { enum: ['pending', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'] }).notNull(),
    /** When it is due. Null means now. */
    publishAt: integer('publish_at'),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'device', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    /** The org's publish revision this publish moved it to (`org_settings.publish_revision`): the "v15" people see. */
    revision: integer('revision').notNull(),
    /** A roll back: the publish whose screens it put back. Null for a publish of content. */
    restoresId: text('restores_id'),
    createdAt: created(),
    /** When every screen it switched reported playing its manifest, moved on to a later one, or was revoked. */
    finishedAt: integer('finished_at'),
    /** How many of its screens the check saw playing it then: 0 when replaced before any check saw one report it. Null until finished. */
    reached: integer('reached'),
  },
  (t) => [
    uniqueIndex('publishes_org_id_uq').on(t.orgId, t.id),
    index('publishes_org_created_idx').on(t.orgId, t.createdAt),
    uniqueIndex('publishes_org_revision_uq').on(t.orgId, t.revision),
    // The five-minute check reads the rollouts not yet finished, in every org (findUnfinishedRollouts).
    index('publishes_unfinished_idx').on(t.orgId).where(sql`${t.finishedAt} IS NULL`),
  ],
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

/**
 * A request to publish chosen drafts (M4-09): made by an agent without `content:publish`, or a
 * person who may not publish, and approved or declined by a person who may. It pins each draft at
 * the version it was asked for (`drafts_json`, `[{ kind, id, version }]` sorted by kind and id, so
 * the same pins are the same text), so approval publishes all of them at those versions, or none.
 * Pending until a decision; a pending one past `expires_at` (7 days) is expired and can no longer be
 * decided. Decided and expired ones are kept for the org's audit retention (./retention.ts).
 */
export const publishRequests = sqliteTable(
  'publish_requests',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    /** Who asked: a user id, or an agent grant id with its OAuth client. */
    requestedByKind: text('requested_by_kind', { enum: ['user', 'agent'] }).notNull(),
    requestedBy: text('requested_by').notNull(),
    clientId: text('client_id'),
    draftsJson: text('drafts_json').notNull(),
    /** The asker's own words for approvers, at most 500 characters: shown as theirs, never as instructions. */
    reason: text('reason').notNull(),
    /** The org's brand state when asked (`brandKits.state`): kits have no draft, so approval publishes only while it is unchanged. */
    brandState: text('brand_state').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'declined'] })
      .notNull()
      .default('pending'),
    createdAt: created(),
    expiresAt: integer('expires_at').notNull(),
    /** The person who approved or declined it, and when. */
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
    /** The publish its approval made; null until then, and when there was nothing to publish (every pin already live at its version). */
    publishId: text('publish_id'),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('publish_requests_org_id_uq').on(t.orgId, t.id),
    // The list, newest first, all of them or the pending ones, each read in index order.
    index('publish_requests_org_created_idx').on(t.orgId, t.createdAt, t.id),
    index('publish_requests_org_status_created_idx').on(t.orgId, t.status, t.createdAt, t.id),
    // One asker's pending requests: the same pins asked again, and the cap.
    index('publish_requests_org_asker_idx').on(t.orgId, t.requestedBy, t.status),
    foreignKey({ columns: [t.orgId, t.publishId], foreignColumns: [publishes.orgId, publishes.id] }),
  ],
);

// -------------------------------------------------------------- data sources

export const dataSources = sqliteTable(
  'data_sources',
  {
    id: text('id').notNull(),
    orgId: orgId(),
    name: text('name').notNull(),
    /**
     * How the poller reads the feed (`@signforge/feeds`): `json` as it is; `ical`, `rss`, `csv`
     * and `json-table` converted to the contract's feeds. `provider`: the connection's adapter
     * fetches it and gives the snapshot's data.
     */
    format: text('format', { enum: ['json', 'ical', 'rss', 'csv', 'json-table', 'provider'] }).notNull(),
    /**
     * The feed URL, encrypted: a private calendar URL is a secret. For a provider source, the
     * provider's resource (a calendar id, a sheet range), sealed the same way: a sheet's id can
     * be all it takes to read it.
     */
    urlEncrypted: text('url_encrypted').notNull(),
    /**
     * A provider source's connection. No foreign key: a column added to a table cannot carry a
     * composite one without rebuilding it. The repository checks it is the org's, and the
     * poller fails a source whose connection is gone as `disconnected`.
     */
    connectionId: text('connection_id'),
    /** How often the poller fetches it, at least 300 (docs/backend-plan.md, Data sources). */
    refreshS: integer('refresh_s').notNull(),
    /** Calendars: how many days ahead their events reach. Null: `@signforge/feeds`' default. */
    horizonDays: integer('horizon_days'),
    /** `json-table`: the dot path to the list of objects. Null: the document is the list. */
    rowsPath: text('rows_path'),
    /** `rss`: whether the poller fetches and stores its stories' photos (./feed-photos.ts, apps/api src/data/feed-photos.ts). On unless a person turns it off. */
    photos: integer('photos', { mode: 'boolean' }).notNull().default(true),
    /** `rss`: { stories: (URL | null)[] } in snapshot order. Older rows held a flat list of URLs. Null until polled with photos active. */
    photoUrlsJson: text('photo_urls_json'),
    /** Moves on when a photo delivery invalidates RSS validators, even if they were already clear. */
    photoGeneration: integer('photo_generation').notNull().default(0),
    nextPollAt: integer('next_poll_at').notNull().default(0),
    etag: text('etag'),
    lastModified: text('last_modified'),
    failures: integer('failures').notNull().default(0),
    /** An error category, never the upstream body. */
    lastError: text('last_error'),
    /** Moves on when someone changes the source, not with polls. */
    rowVersion: rowVersion(),
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
    /** Hash of the data, to tell a change. A screen orders snapshots by `fetched_at`, not by this. */
    version: text('version').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    /** When a poll last found the feed still saying this; a screen's staleness counts from it. */
    checkedAt: integer('checked_at').notNull(),
    dataJson: text('data_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.dataSourceId] }),
    foreignKey({ columns: [t.orgId, t.dataSourceId], foreignColumns: [dataSources.orgId, dataSources.id] }).onDelete('cascade'),
  ],
);

/**
 * The photos the org's news sources name, by the URL a feed gives (./feed-photos.ts, apps/api src/data/feed-photos.ts):
 * the stored copy's hashes once one was fetched and checked, the validators it came with, and when
 * to look at the URL again. One row per URL however many of the org's sources name it. A failed
 * fetch keeps the last good hashes. The files live in the feed-owned R2 prefix `o/<org>/f/<sha256>`.
 * A row no poll has named for a week goes (`expiredFeedImages`, ./retention.ts), queueing its
 * hashes into `feed_image_deletes` so R2 deletes retry cleanly and never race concurrent writes.
 */
export const feedImages = sqliteTable(
  'feed_images',
  {
    orgId: orgId(),
    /** As the feed names it, http or https: what a poll looks it up by. */
    url: text('url').notNull(),
    /** The source whose poll first named it: what a source's daily budget of new photos counts. No foreign key: the row may outlive the source until it expires. */
    sourceId: text('source_id').notNull(),
    /** The fetched bytes' hash: another URL in the org bringing the same bytes reuses its copies. */
    sourceSha256: text('source_sha256'),
    /** `NewsImage.file` and `.thumb`; null until a fetch succeeds. */
    fileSha256: text('file_sha256'),
    thumbSha256: text('thumb_sha256'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    /** When a poll that finds this URL queues it to be fetched again; moved on when it is queued, so the next poll does not queue it twice. */
    nextCheckAt: integer('next_check_at').notNull(),
    /** Why the last fetch failed, as a category; null once one succeeds. */
    lastError: text('last_error'),
    /** Fetches in a row that failed: each waits longer, up to a day. */
    failures: integer('failures').notNull().default(0),
    /** When a poll first named it, on the poller's clock: the daily budgets count rows made in the last day. */
    createdAt: integer('created_at').notNull(),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.url] }), index('feed_images_org_source_sha_idx').on(t.orgId, t.sourceSha256)],
);

/**
 * Feed photo blobs (`o/<org>/f/<sha256>`) queued for R2 deletion when a `feed_images` row expires
 * or replaces its hashes at the same URL. Kept until R2 delete succeeds so failures retry on the
 * next cleanup run; a grace window (`FEED_IMAGE_DELETE_GRACE_MS`) plus `deleting_until` lease keep
 * cleanup from racing a concurrent consumer putting or reusing the same hash.
 */
export const feedImageDeletes = sqliteTable(
  'feed_image_deletes',
  {
    orgId: orgId(),
    sha256: text('sha256').notNull(),
    queuedAt: integer('queued_at').notNull(),
    deletingUntil: integer('deleting_until').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sha256] })],
);

/**
 * A deleted asset's files (`o/<org>/b/<sha256>`), queued by `delete_asset` in its batch for the storage sweep (#235),
 * which deletes one past the grace period once nothing the org keeps names its bytes (packages/db `storage.ts`).
 * `claim_owner` and `claim_until`: the sweep's claim while it deletes the object; a writer that could reuse the bytes is
 * refused while it holds.
 */
export const blobDeletes = sqliteTable(
  'blob_deletes',
  {
    orgId: orgId(),
    sha256: text('sha256').notNull(),
    queuedAt: integer('queued_at').notNull(),
    claimOwner: text('claim_owner'),
    claimUntil: integer('claim_until').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sha256] })],
);

/**
 * The files each stored manifest names (`ScreenManifest.files`' hashes, as a JSON array), by the screen it is stored for
 * and its content-addressed id, as R2 keys it (#235): written in the batch of the publish or `/admin` push that stores
 * it, and by the storage sweep for one stored before this table. What the sweep keeps a file for. `files_json` is null
 * for one the sweep found no object for: its files are unknown, the screen can fetch nothing through it, and a real
 * write replaces it.
 */
export const storedManifests = sqliteTable(
  'stored_manifests',
  {
    orgId: orgId(),
    screenId: text('screen_id').notNull(),
    manifestId: text('manifest_id').notNull(),
    filesJson: text('files_json'),
    storedAt: integer('stored_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.screenId, t.manifestId] })],
);

/**
 * Each org's storage sweep (#235): its lease (`owner`, `lease_until`), so two never run on one org, and when it was last
 * swept, so the orgs least recently swept go first and none waits behind others' backlogs.
 */
export const storageSweeps = sqliteTable('storage_sweeps', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => organization.id),
  owner: text('owner'),
  leaseUntil: integer('lease_until').notNull().default(0),
  sweptAt: integer('swept_at').notNull().default(0),
});

// --------------------------------------------------------------- connections

/**
 * An account an org connected at a provider (docs/backend-plan.md, Connectors), which provider
 * data sources read through. Its credentials (an OAuth grant: access and refresh token and
 * expiry; or an API key) are sealed under the CONNECTION_KEY secret, bound to the org and this
 * id, and never leave the API's connector code: no tool returns them and the audit log never
 * holds them. Null once disconnected.
 */
export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    /** The adapter's name (`apps/api/src/connectors`). */
    provider: text('provider').notNull(),
    /** Which account, as the provider names it (`facilities@…`): shown, not a secret. */
    account: text('account').notNull(),
    /** The scopes the provider granted, a JSON array of strings. */
    scopesJson: text('scopes_json').notNull(),
    /** `needs_reconnect`: the provider refused the grant (revoked, expired); a person must connect it again. */
    status: text('status', { enum: ['active', 'needs_reconnect', 'disconnected'] }).notNull(),
    credentialsSealed: text('credentials_sealed'),
    /** When the access token expires; null for one that does not (an API key). */
    expiresAt: integer('expires_at'),
    /** The user who first connected it. */
    createdBy: text('created_by').notNull(),
    /** Why the provider last refused, as a category (`invalid_grant`), never its body. */
    lastError: text('last_error'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('connections_org_id_uq').on(t.orgId, t.id)],
);

/**
 * An OAuth authorization a member started and has not finished (`start_connection`): found by
 * the SHA-256 of its `state`, which only the authorize URL holds, and deleted when it is
 * finished, so a state works once. Good for 10 minutes. Bound to the member who started it.
 */
export const connectionAuthorizations = sqliteTable(
  'connection_authorizations',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    provider: text('provider').notNull(),
    /** The connection it reconnects; null for a new one. */
    connectionId: text('connection_id'),
    stateHash: text('state_hash').notNull(),
    /** The PKCE code verifier, sealed like credentials, bound to this row. */
    verifierSealed: text('verifier_sealed').notNull(),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'device', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('connection_authorizations_org_id_uq').on(t.orgId, t.id),
    uniqueIndex('connection_authorizations_state_uq').on(t.orgId, t.stateHash),
    foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connections.orgId, connections.id] }).onDelete('cascade'),
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
 * keys never meet. Deleted after about 7 days by a daily job (`expireIdempotencyKeys`, ./retention.ts).
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

/**
 * The highest play-count `seq` stored for each `epoch` a screen has synced in (contract
 * `SyncRequest`). One row per epoch, not one per screen: after a re-image, retries from the old
 * epoch and the new one can arrive in any order, and each is checked against its own epoch's mark.
 */
export const syncEpochs = sqliteTable(
  'sync_epochs',
  {
    orgId: orgId(),
    screenId: text('screen_id').notNull(),
    epoch: text('epoch').notNull(),
    ackSeq: integer('ack_seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.screenId, t.epoch] }),
    foreignKey({ columns: [t.orgId, t.screenId], foreignColumns: [screens.orgId, screens.id] }).onDelete('cascade'),
  ],
);

// ------------------------------------------------------------------ agent grants

/**
 * What an agent's OAuth client may do in one org, as one member (M4-04): its id (`agt_…`) is the
 * dispatcher's agent actor id and the provider's consent reference id, on every token issued under
 * it. Scopes are those the member chose at consent, capped by their role then; the dispatcher caps
 * them again on every call. It ends when revoked (by the person, an owner, or the membership
 * ending, with the provider's tokens) or 90 days after it was last used (`expires_at`).
 */
export const agentGrants = sqliteTable(
  'agent_grants',
  {
    id: text('id').primaryKey(),
    orgId: orgId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The OAuth client's id, and its name as it registered (unverified for an open registration). */
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    /** A JSON array of the tool scopes granted. */
    scopesJson: text('scopes_json').notNull(),
    createdAt: created(),
    /** Written at most once an hour per grant by `/mcp` (M4-06), with `expires_at`. */
    lastUsedAt: integer('last_used_at'),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    revokedBy: text('revoked_by'),
    rowVersion: rowVersion(),
  },
  (t) => [uniqueIndex('agent_grants_org_id_uq').on(t.orgId, t.id), index('agent_grants_org_user_idx').on(t.orgId, t.userId)],
);
