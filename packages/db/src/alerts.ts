/**
 * The alert check's one cross-org read (M3-42): which screens, in any org, have gone unheard from
 * past their org's threshold with no incident open, and which open incidents have cleared. It
 * reads ids, names and times only. Every write that follows goes through `scoped(db, orgId)`
 * with the org a row here names (`org.incidents`).
 */
import { and, eq, exists, gt, isNotNull, isNull, lt, not, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

export interface AlertWork {
  /** Screens silent past the threshold, with no open incident. */
  offline: { orgId: string; orgName: string; screenId: string; screenName: string; lastSeenAt: number }[];
  /** Open incidents whose screen has been heard from since. */
  back: { orgId: string; orgName: string; incidentId: string; screenId: string; screenName: string; since: number; lastSeenAt: number }[];
}

/**
 * What the alert check has to do at `now`. A screen counts while it has an unrevoked credential;
 * `defaultUnreachableMs` applies to an org that has not set its own threshold. A browser test screen
 * (M3-41) never counts: it goes quiet whenever its tab closes.
 */
export async function findAlertWork(d1: D1Database, now: number, defaultUnreachableMs: number): Promise<AlertWork> {
  const db = drizzle(d1);
  const sc = s.screens;
  const inc = s.screenIncidents;
  const live = exists(
    db
      .select({ one: sql`1` })
      .from(s.screenCredentials)
      .where(and(eq(s.screenCredentials.orgId, sc.orgId), eq(s.screenCredentials.screenId, sc.id), isNull(s.screenCredentials.revokedAt))),
  );
  const openIncident = exists(
    db
      .select({ one: sql`1` })
      .from(inc)
      .where(and(eq(inc.orgId, sc.orgId), eq(inc.screenId, sc.id), isNull(inc.clearedAt))),
  );
  const threshold = sql`coalesce(${s.orgSettings.unreachableAfterMs}, ${defaultUnreachableMs})`;
  const [offline, back] = await Promise.all([
    db
      .select({ orgId: sc.orgId, orgName: s.organization.name, screenId: sc.id, screenName: sc.name, lastSeenAt: sql<number>`${sc.lastSeenAt}` })
      .from(sc)
      .innerJoin(s.organization, eq(s.organization.id, sc.orgId))
      .leftJoin(s.orgSettings, eq(s.orgSettings.orgId, sc.orgId))
      .where(
        and(eq(sc.status, 'active'), eq(sc.kind, 'device'), isNotNull(sc.lastSeenAt), lt(sc.lastSeenAt, sql`${now} - ${threshold}`), live, not(openIncident)),
      )
      .all(),
    db
      .select({
        orgId: inc.orgId,
        orgName: s.organization.name,
        incidentId: inc.id,
        screenId: inc.screenId,
        screenName: sc.name,
        since: inc.lastSeenAt,
        lastSeenAt: sql<number>`${sc.lastSeenAt}`,
      })
      .from(inc)
      .innerJoin(sc, and(eq(sc.orgId, inc.orgId), eq(sc.id, inc.screenId)))
      .innerJoin(s.organization, eq(s.organization.id, inc.orgId))
      .where(and(isNull(inc.clearedAt), gt(sc.lastSeenAt, inc.lastSeenAt)))
      .all(),
  ]);
  return { offline, back };
}

/**
 * Publishes in any org whose rollout is over but not yet marked finished: each screen it switched
 * reports playing its manifest, or was moved on by a later publish. Ids, names, times and counts
 * only; each is marked, with its alert, through its org's scope (`publishes.finish`).
 */
export async function findFinishedRollouts(
  d1: D1Database,
): Promise<{ orgId: string; orgName: string; id: string; revision: number; createdAt: number; screens: number }[]> {
  const db = drizzle(d1);
  const p = s.publishes;
  const ps = s.publishScreens;
  const sc = s.screens;
  const waiting = exists(
    db
      .select({ one: sql`1` })
      .from(ps)
      .innerJoin(sc, and(eq(sc.orgId, ps.orgId), eq(sc.id, ps.screenId)))
      .where(
        and(eq(ps.orgId, p.orgId), eq(ps.publishId, p.id), eq(sc.desiredManifestId, ps.manifestId), sql`${sc.reportedManifestId} IS NOT ${ps.manifestId}`),
      ),
  );
  return db
    .select({
      orgId: p.orgId,
      orgName: s.organization.name,
      id: p.id,
      revision: p.revision,
      createdAt: p.createdAt,
      screens: sql<number>`(SELECT count(*) FROM ${ps} WHERE ${ps.orgId} = ${p.orgId} AND ${ps.publishId} = ${p.id})`.mapWith(Number),
    })
    .from(p)
    .innerJoin(s.organization, eq(s.organization.id, p.orgId))
    .where(and(isNull(p.finishedAt), eq(p.status, 'published'), not(waiting)))
    .all();
}
