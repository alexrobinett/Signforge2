/**
 * `POST /v1/device/sync` (docs/backend-plan.md, Screens): the one periodic call that carries
 * everything chatty, so the socket stays silent. The screen sends its heartbeat and play counts;
 * the server stores them on the screen's row in one batch and answers with the desired manifest,
 * snapshots newer than the screen holds, a socket ticket, the server time and any commands.
 *
 * D1 writes per sync: one (the screen row) plus, for each play count, one if its hour's row
 * exists or three if it is new (the row and two index entries). The player sends an hour's counts
 * once the hour has ended, so each (hour, spot) row is written about once.
 */
import {
  MAX_SYNC_SOURCES,
  parseSyncRequest,
  type DataSnapshot,
  type DeviceCommand,
  type DisplayOverride,
  type SyncRequest,
  type SyncResponse,
} from '@signforge/contract';
import { scoped, type DeviceScreen } from '@signforge/db';
import { liveOverride, type ScreenHeartbeat } from '@signforge/tools';
import type { Context } from 'hono';
import type { DeviceEnv } from './auth';
import { fitsBoundFields } from '../data/fit';
import { screenManifests, type ManifestSummary } from './manifests';
import { issueTicket } from './ticket';

/** How often a screen syncs. */
const SYNC_INTERVAL_S = 300;
/** Counts for an hour this far past the server's are not believed: the screen's clock is wrong. */
const FUTURE_SLACK_MS = 3_600_000;

const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

/** Whether the screen's player can play `m`: its schema, and every template's frame protocol. */
function canPlay(player: SyncRequest['player'], m: ManifestSummary): boolean {
  return (!Number.isInteger(m.schema) || player.manifestSchemas.includes(m.schema)) && m.protocols.every((p) => player.protocols.includes(p));
}

/**
 * Of the desired manifest's sources: the snapshots newer than the screen holds, and for those it
 * holds at the current version, when they were last checked, so an unchanged feed does not go
 * stale on the screen and is not sent again.
 */
async function snapshotsFor(
  env: Env,
  screen: DeviceScreen,
  desired: ManifestSummary | undefined,
  held: Record<string, number>,
): Promise<Pick<SyncResponse, 'snapshots' | 'checked'>> {
  if (!desired?.dataSources.size) return { snapshots: [], checked: {} };
  const rows = await scoped(env.DB, screen.orgId).dataSources.snapshots([...desired.dataSources]);
  // The stored version is a hash, for telling whether data changed; a screen orders snapshots by the fetch time.
  const snapshots: DataSnapshot[] = [];
  const checked: NonNullable<SyncResponse['checked']> = {};
  for (const r of rows) {
    const checkedAt = new Date(r.checkedAt).toISOString();
    if (r.fetchedAt === held[r.dataSourceId]) checked[r.dataSourceId] = { version: r.fetchedAt, checkedAt };
    if (r.fetchedAt <= (held[r.dataSourceId] ?? -1)) continue;
    const data: unknown = JSON.parse(r.dataJson);
    // Stored only if it fit the spots published then; this screen's manifest may bind it differently.
    if (fitsBoundFields(desired.bound.get(r.dataSourceId) ?? [], data))
      snapshots.push({ id: r.dataSourceId, version: r.fetchedAt, fetchedAt: new Date(r.fetchedAt).toISOString(), checkedAt, data });
  }
  return { snapshots, checked };
}

const sameOverride = (a: DisplayOverride | null, b: DisplayOverride | null) =>
  a?.state === b?.state && (a === null || Date.parse(a.until) === Date.parse(b!.until));

/**
 * The CMS's display override (wake now, sleep now), while the screen reports another: one it
 * missed on the socket, or one cleared since. Nothing once it has ended, as the screen ends it too.
 */
function overrideCommand(screen: DeviceScreen, held: DisplayOverride | undefined, now: number): DeviceCommand | undefined {
  const want = liveOverride(screen.displayOverrideJson, now);
  const has = held && Date.parse(held.until) > now ? held : null;
  return sameOverride(want, has) ? undefined : { type: 'display', override: want };
}

export async function syncRoute(c: Context<DeviceEnv>): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return refuse(400, 'the body is not JSON');
  }
  const parsed = parseSyncRequest(body);
  if (!parsed.ok) return c.json({ error: 'invalid sync request', problems: parsed.problems }, 400);
  const req = parsed.value;
  const screen = c.get('screen');
  const now = Date.now();

  const heartbeat: ScreenHeartbeat = {
    at: now,
    player: req.player,
    manifest: req.manifest,
    display: req.display,
    clock: req.clock,
    driftMs: now - Date.parse(req.deviceTime),
    // A player before gh-45 reports every source seen since it started: kept to a bounded row.
    dataRejected: Object.fromEntries(Object.entries(req.dataRejected ?? {}).slice(0, MAX_SYNC_SOURCES)),
  };
  const counts = req.playCounts
    .map((p) => ({ hour: Date.parse(p.hour), spotId: p.spot, plays: p.plays, ms: Math.round(p.ms) }))
    .filter((p) => p.hour <= now + FUTURE_SLACK_MS);

  const [stored, manifests] = await Promise.all([
    scoped(c.env.DB, screen.orgId).screens.sync(screen.screenId, {
      at: now,
      playerVersion: req.player.version,
      heartbeatJson: JSON.stringify(heartbeat),
      active: req.manifest.active,
      epoch: req.epoch,
      seq: req.seq,
      counts,
    }),
    screenManifests(c.env.BLOBS, screen),
  ]);
  if (!stored) return refuse(401, 'unauthorized');
  const desired = manifests.find((m) => m.id === screen.desiredManifestId);
  const commands: DeviceCommand[] = desired && !canPlay(req.player, desired) ? [{ type: 'reload' }] : [];
  const display = overrideCommand(screen, req.display.override, now);
  if (display) commands.push(display);

  const res: SyncResponse = {
    serverTime: new Date().toISOString(),
    nextSyncS: SYNC_INTERVAL_S,
    epoch: req.epoch,
    ackSeq: stored.ackSeq,
    ...(screen.desiredManifestId ? { desiredManifest: screen.desiredManifestId } : {}),
    ...(await snapshotsFor(c.env, screen, desired, req.snapshots)),
    socketTicket: await issueTicket(c.env, { screenId: screen.screenId, credentialId: c.get('credentialId') }),
    commands,
  };
  return c.json(res, 200, { 'cache-control': 'no-store' });
}
