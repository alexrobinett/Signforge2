/**
 * The one lookup a screen's credential needs before its org is known.
 *
 * A device request carries `sfd_<screenId>.<secret>`, so the screen id is all the server has
 * until the secret is checked. This reads that screen and its live credentials by screen id
 * alone, and nothing else. Everything after authentication goes through `scoped(db, orgId)`
 * with the org this returns.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { isId } from '@signforge/contract';
import * as s from './schema';

export interface DeviceScreen {
  orgId: string;
  screenId: string;
  desiredManifestId: string | null;
  previousManifestId: string | null;
  /** The last manifest that played a spot, as the screen's last sync reported it (`manifest.lastGood`). */
  lastGoodManifestId: string | null;
  /** The feed photos the screen's last sync lacked, and what its reply asked for (`ScreenHeartbeat.photos`). */
  lastPhotos: { missing: number; retried: boolean; ask: string[]; sent?: string[]; repeat?: string[] } | null;
  /** The contract's `DisplayOverride` set from the CMS, as stored; it may have ended. */
  displayOverrideJson: string | null;
  /** Each credential that is not revoked, with the hex SHA-256 of its secret. Empty if the screen is revoked. */
  credentials: { id: string; secretHash: string /** Whether a request has authenticated with it yet. */; used: boolean }[];
}

/**
 * The screen a credential names, with its unrevoked credential hashes, or undefined if there is
 * no such screen. The caller compares the presented secret's hash against each credential's `secretHash`.
 */
export async function findDeviceScreen(d1: D1Database, screenId: string): Promise<DeviceScreen | undefined> {
  if (!isId(screenId)) return undefined;
  const db = drizzle(d1);
  const sc = s.screens;
  const cr = s.screenCredentials;
  const rows = await db
    .select({
      orgId: sc.orgId,
      status: sc.status,
      desiredManifestId: sc.desiredManifestId,
      previousManifestId: sc.previousManifestId,
      lastGoodManifestId: sql<string | null>`json_extract(${sc.heartbeatJson}, '$.manifest.lastGood')`,
      photosMissing: sql<number | null>`json_extract(${sc.heartbeatJson}, '$.photos.missing')`,
      photosRetried: sql<number | null>`json_extract(${sc.heartbeatJson}, '$.photos.retried')`,
      photosAsk: sql<string | null>`json_extract(${sc.heartbeatJson}, '$.photos.ask')`,
      // Lists only: #514's heartbeats kept one fingerprint of all the snapshots sent there, a string.
      photosSent: sql<
        string | null
      >`CASE WHEN json_type(${sc.heartbeatJson}, '$.photos.sent') = 'array' THEN json_extract(${sc.heartbeatJson}, '$.photos.sent') END`,
      photosRepeat: sql<
        string | null
      >`CASE WHEN json_type(${sc.heartbeatJson}, '$.photos.repeat') = 'array' THEN json_extract(${sc.heartbeatJson}, '$.photos.repeat') END`,
      displayOverrideJson: sc.displayOverrideJson,
      credentialId: cr.id,
      secretHash: cr.secretHash,
      lastUsedAt: cr.lastUsedAt,
    })
    .from(sc)
    .leftJoin(cr, and(eq(cr.orgId, sc.orgId), eq(cr.screenId, sc.id), isNull(cr.revokedAt)))
    .where(eq(sc.id, screenId))
    .all();
  const first = rows[0];
  if (!first) return undefined;
  return {
    orgId: first.orgId,
    screenId,
    desiredManifestId: first.desiredManifestId,
    previousManifestId: first.previousManifestId,
    lastGoodManifestId: first.lastGoodManifestId,
    // SQLite's json_extract reads a JSON boolean as 1 or 0.
    // A heartbeat from before #496 has no count missing: read as none, so the next reply starts the ask afresh.
    lastPhotos:
      first.photosMissing === null || first.photosAsk === null
        ? null
        : // json_extract gives an array as its JSON text; the API's sync route wrote it.
          {
            missing: first.photosMissing,
            retried: first.photosRetried === 1,
            ask: JSON.parse(first.photosAsk),
            ...(first.photosSent !== null && { sent: JSON.parse(first.photosSent) }),
            ...(first.photosRepeat !== null && { repeat: JSON.parse(first.photosRepeat) }),
          },
    displayOverrideJson: first.displayOverrideJson,
    credentials:
      first.status === 'active'
        ? rows.flatMap((r) => (r.credentialId && r.secretHash ? [{ id: r.credentialId, secretHash: r.secretHash, used: r.lastUsedAt !== null }] : []))
        : [],
  };
}
