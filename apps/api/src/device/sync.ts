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
import { validateSyncRequest, type DataSnapshot, type DeviceCommand, type SyncRequest, type SyncResponse } from '@signforge/contract';
import { scoped, type DeviceScreen } from '@signforge/db';
import type { Context } from 'hono';
import type { DeviceEnv } from './auth';
import { screenManifests, type ManifestSummary } from './manifests';
import { issueTicket } from './ticket';

/** How often a screen syncs. */
export const SYNC_INTERVAL_S = 300;
/** Counts for an hour this far past the server's are not believed: the screen's clock is wrong. */
const FUTURE_SLACK_MS = 3_600_000;

/** What the last sync reported, kept on the screen row as `heartbeat_json` for the CMS. */
export interface ScreenHeartbeat {
  at: number;
  player: SyncRequest['player'];
  manifest: SyncRequest['manifest'];
  display: SyncRequest['display'];
  clock: SyncRequest['clock'];
  /** Server time minus the screen's own uncorrected clock when it sent the sync, in ms. */
  driftMs: number;
  dataRejected: Record<string, number>;
}

export function parseHeartbeat(json: string | null | undefined): ScreenHeartbeat | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as ScreenHeartbeat;
  } catch {
    return undefined;
  }
}

const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

/** Whether the screen's player can play `m`: its schema, and every template's frame protocol. */
function canPlay(player: SyncRequest['player'], m: ManifestSummary): boolean {
  return (!Number.isInteger(m.schema) || player.manifestSchemas.includes(m.schema)) && m.protocols.every((p) => player.protocols.includes(p));
}

async function changedSnapshots(env: Env, screen: DeviceScreen, desired: ManifestSummary | undefined, held: Record<string, number>): Promise<DataSnapshot[]> {
  if (!desired?.dataSources.size) return [];
  const rows = await scoped(env.DB, screen.orgId).dataSources.snapshots([...desired.dataSources]);
  // The stored version is a hash, for telling whether data changed; a screen orders snapshots by the fetch time.
  return rows
    .filter((r) => r.fetchedAt > (held[r.dataSourceId] ?? -1))
    .map((r) => ({ id: r.dataSourceId, version: r.fetchedAt, fetchedAt: new Date(r.fetchedAt).toISOString(), data: JSON.parse(r.dataJson) as unknown }));
}

export async function syncRoute(c: Context<DeviceEnv>): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return refuse(400, 'the body is not JSON');
  }
  const problems = validateSyncRequest(body);
  if (problems.length) return c.json({ error: 'invalid sync request', problems }, 400);
  const req = body as SyncRequest;
  const screen = c.get('screen');
  const now = Date.now();

  const heartbeat: ScreenHeartbeat = {
    at: now,
    player: req.player,
    manifest: req.manifest,
    display: req.display,
    clock: req.clock,
    driftMs: now - Date.parse(req.deviceTime),
    dataRejected: req.dataRejected ?? {},
  };
  const counts = req.playCounts
    .map((p) => ({ hour: Date.parse(p.hour), spotId: p.spot, plays: p.plays, ms: Math.round(p.ms) }))
    .filter((p) => p.hour <= now + FUTURE_SLACK_MS);

  const [stored, manifests] = await Promise.all([
    scoped(c.env.DB, screen.orgId).screens.sync(screen.screenId, {
      at: now,
      playerVersion: req.player.version,
      heartbeatJson: JSON.stringify(heartbeat),
      epoch: req.epoch,
      seq: req.seq,
      counts,
    }),
    screenManifests(c.env.BLOBS, screen),
  ]);
  if (!stored) return refuse(401, 'unauthorized');
  const desired = manifests.find((m) => m.id === screen.desiredManifestId);
  const commands: DeviceCommand[] = desired && !canPlay(req.player, desired) ? [{ type: 'reload' }] : [];

  const res: SyncResponse = {
    serverTime: new Date().toISOString(),
    nextSyncS: SYNC_INTERVAL_S,
    epoch: req.epoch,
    ackSeq: stored.ackSeq,
    ...(screen.desiredManifestId ? { desiredManifest: screen.desiredManifestId } : {}),
    snapshots: await changedSnapshots(c.env, screen, desired, req.snapshots),
    socketTicket: await issueTicket(c.env, { screenId: screen.screenId, credentialId: c.get('credentialId') }),
    commands,
  };
  return c.json(res, 200, { 'cache-control': 'no-store' });
}
