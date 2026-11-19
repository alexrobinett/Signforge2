/**
 * `@signforge/db`: the D1 schema and the only code allowed to query tenant tables.
 *
 * Handlers get a `scoped(db, orgId)` and nothing else. The table objects in `./schema` are not
 * exported, and `test/boundary.test.ts` fails if anything outside this package imports them.
 */
import type * as s from './schema';

export { scoped, NotInOrgError, type OrgScope, type NewRow, type RowPatch } from './scoped';
export { platform, type PlatformScope } from './platform';
export { newId } from './ids';
export { StaleVersionError, type Staged, type Write } from './writes';
export { published, draftChanged, type DraftRow, type PublishedPlaylist } from './drafts';
export { findDeviceScreen, type DeviceScreen } from './device';
export { claimDueDataSources } from './poller';
export { collectPairing, startPairing, PAIRING_TTL_MS, type PairingCollected } from './pairing';
export { findMembership, organizationExists, orgMembers } from './members';
export { findAlertWork, type AlertWork } from './alerts';
export { AUDIT_ROWS_PER_RUN, DEFAULT_AUDIT_RETENTION_DAYS, expireAlertDeliveries, expireAuditRows, expireIdempotencyKeys } from './retention';
export { alertChannelsOf, claimDueAlertDeliveries, settleAlertDeliveries, type AttemptResult } from './deliveries';

// Row shapes, as types only.
export type Screen = typeof s.screens.$inferSelect;
export type ScreenGroup = typeof s.screenGroups.$inferSelect;
export type ScreenCredential = typeof s.screenCredentials.$inferSelect;
export type Asset = typeof s.assets.$inferSelect;
export type AssetRendition = typeof s.assetRenditions.$inferSelect;
export type Template = typeof s.templates.$inferSelect;
export type TemplateVersion = typeof s.templateVersions.$inferSelect;
export type SpotRow = typeof s.spots.$inferSelect;
export type PlaylistRow = typeof s.playlists.$inferSelect;
export type ScheduleEntryRow = typeof s.scheduleEntries.$inferSelect;
export type Publish = typeof s.publishes.$inferSelect;
export type DataSourceRow = typeof s.dataSources.$inferSelect;
export type DataSnapshotRow = typeof s.dataSnapshots.$inferSelect;
export type AuditEntry = typeof s.auditLog.$inferSelect;
export type PlatformAuditEntry = typeof s.platformAuditLog.$inferSelect;
export type PlayCountRow = typeof s.playCounts.$inferSelect;
export type OrgSettings = typeof s.orgSettings.$inferSelect;
export type BrandKitRow = typeof s.brandKits.$inferSelect;
export type BrandAssignment = typeof s.brandAssignments.$inferSelect;
export type AlertChannelRow = typeof s.alertChannels.$inferSelect;
export type AlertDeliveryRow = typeof s.alertDeliveries.$inferSelect;
