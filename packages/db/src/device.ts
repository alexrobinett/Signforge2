/**
 * The one lookup a screen's credential needs before its org is known.
 *
 * A device request carries `sfd_<screenId>.<secret>`, so the screen id is all the server has
 * until the secret is checked. This reads that screen and its live credentials by screen id
 * alone, and nothing else. Everything after authentication goes through `scoped(db, orgId)`
 * with the org this returns.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { isId } from '@signforge/contract';
import * as s from './schema';

export interface DeviceScreen {
  orgId: string;
  screenId: string;
  desiredManifestId: string | null;
  previousManifestId: string | null;
  /** Each credential that is not revoked, with the hex SHA-256 of its secret. Empty if the screen is revoked. */
  credentials: { id: string; secretHash: string }[];
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
      credentialId: cr.id,
      secretHash: cr.secretHash,
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
    credentials: first.status === 'active' ? rows.flatMap((r) => (r.credentialId && r.secretHash ? [{ id: r.credentialId, secretHash: r.secretHash }] : [])) : [],
  };
}
