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
import { isId, type FailedPlayerRelease, type PlayerChannel, type ScreenKind } from '@signforge/contract';
import * as s from './schema';

/** What a screen's last heartbeat said of player releases (#628): see `DeviceScreen.release`. */
export interface ScreenRelease {
  running: number | null;
  since: number | null;
  failed: FailedPlayerRelease[];
}

const sc = s.screens;
/** `ScreenRelease`'s columns, read from the heartbeat JSON, for `releaseOf`. */
export const releaseColumns = {
  releaseRunning: sql<number | null>`json_extract(${sc.heartbeatJson}, '$.player.release')`,
  releaseSince: sql<number | null>`json_extract(${sc.heartbeatJson}, '$.releaseSince')`,
  releasesFailed: sql<
    string | null
  >`CASE WHEN json_type(${sc.heartbeatJson}, '$.failedReleases') = 'array' THEN json_extract(${sc.heartbeatJson}, '$.failedReleases') END`,
};

/** A row's `releaseColumns` as a `ScreenRelease`. json_extract gives an array as its JSON text; the API's sync route wrote it. */
export const releaseOf = (r: { releaseRunning: number | null; releaseSince: number | null; releasesFailed: string | null }): ScreenRelease => ({
  running: r.releaseRunning,
  since: r.releaseSince,
  failed: r.releasesFailed === null ? [] : JSON.parse(r.releasesFailed),
});

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
  /** The player releases its device supervisor is offered (#628): read here with the screen, never named by a request. */
  playerChannel: PlayerChannel;
  /** A device with a supervisor, or a browser tab with none: only a device reports a player release it rolled back. */
  kind: ScreenKind;
  /**
   * From the screen's last heartbeat (#628): the player release it ran (`player.release`), since when it has run it
   * (`releaseSince`), and the releases its supervisor rolled back that it has run none newer than (`failedReleases`).
   * The sync carries them on, so they cost no write of their own.
   */
  release: ScreenRelease;
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
      playerChannel: sc.playerChannel,
      kind: sc.kind,
      ...releaseColumns,
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
    playerChannel: first.playerChannel,
    kind: first.kind,
    release: releaseOf(first),
    credentials:
      first.status === 'active'
        ? rows.flatMap((r) => (r.credentialId && r.secretHash ? [{ id: r.credentialId, secretHash: r.secretHash, used: r.lastUsedAt !== null }] : []))
        : [],
  };
}
