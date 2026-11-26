/**
 * `POST /v1/device/sync` (docs/backend-plan.md, Screens): the one periodic call that carries
 * everything chatty, so the socket stays silent. The screen sends its heartbeat and play counts;
 * the server stores them on the screen's row in one batch and answers with the desired manifest,
 * snapshots newer than the screen holds, a socket ticket, the server time and any commands.
 *
 * D1 writes per sync: one (the screen row) plus, for each play count, one if its hour's row
 * exists or three if it is new (the row and two index entries), and one for a batch that moves its
 * epoch's mark (two for an epoch's first). The player sends an hour's counts once the hour has
 * ended, so each (hour, spot) row is written about once.
 */
import {
  MAX_SYNC_REQUEST_BYTES,
  MAX_SYNC_RESPONSE_BLOBS,
  MAX_SYNC_SOURCES,
  parseSyncRequest,
  type DataSnapshot,
  type DeviceCommand,
  type DisplayOverride,
  type SyncRequest,
  type SyncResponse,
} from '@signforge/contract';
import { scoped, type DeviceScreen } from '@signforge/db';
import { boundImageHashes, hasBoundListImage, snapshotFit } from '@signforge/player-core';
import { liveOverride, type ScreenHeartbeat } from '@signforge/tools';
import type { Context } from 'hono';
import type { DeviceEnv } from './auth';
import { fileManifests, screenManifests, type ManifestSummary } from './manifests';
import { issueTicket } from './ticket';

/** How often a screen syncs. */
const SYNC_INTERVAL_S = 300;
/**
 * How soon a screen syncs again while feed photos it lacks are left out of a reply (`MAX_SYNC_RESPONSE_BLOBS`): a few
 * replies bring a new feed's photos in a minute, not one batch every interval (#476). Each sync writes one D1 row, so
 * this lasts only while the count still missing moves, plus one retry for a lost reply: a screen that cannot store
 * them would otherwise sync 5,760 times a day rather than 288.
 */
const MORE_PHOTOS_SYNC_S = 15;
/** Counts for an hour this far past the server's are not believed: the screen's clock is wrong. */
const FUTURE_SLACK_MS = 3_600_000;

const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

/** Whether the screen's player can play `m`: its schema, and every template's frame protocol. */
function canPlay(player: SyncRequest['player'], m: ManifestSummary): boolean {
  return (!Number.isInteger(m.schema) || player.manifestSchemas.includes(m.schema)) && m.protocols.every((p) => player.protocols.includes(p));
}

/**
 * Of the desired manifest's sources: the snapshots newer than the screen holds, when those it
 * holds at the current version were last checked, and any feed image blob hashes referenced by
 * those snapshots that the screen did not report holding (capped at `MAX_SYNC_RESPONSE_BLOBS`),
 * with how many it lacks in all. `first`: sources whose photos go before the others', those of the
 * manifest a screen plays while it falls back from the desired one. `last`: the screen's last sync,
 * whose ask this one starts after.
 */
async function snapshotsFor(
  env: Env,
  screen: DeviceScreen,
  desired: ManifestSummary | undefined,
  held: Record<string, number>,
  heldBlobs: readonly string[] | undefined,
  includeBlobs: boolean,
  first: ReadonlySet<string>,
  last: DeviceScreen['lastPhotos'],
): Promise<Pick<SyncResponse, 'snapshots' | 'checked' | 'blobs'> & { missing: number }> {
  if (!desired?.dataSources.size) return { snapshots: [], checked: {}, missing: 0 };
  const rows = await scoped(env.DB, screen.orgId).dataSources.snapshots([...desired.dataSources]);
  // The stored version is a hash, for telling whether data changed; a screen orders snapshots by the fetch time.
  const snapshots: DataSnapshot[] = [];
  const checked: NonNullable<SyncResponse['checked']> = {};
  const have = new Set(heldBlobs ?? []);
  /** Each source's photos, in story order: `first`'s sources, then the rest. */
  const photosBySource: [string[][], string[][]] = [[], []];
  for (const r of rows) {
    const checkedAt = new Date(r.checkedAt).toISOString();
    if (r.fetchedAt === held[r.dataSourceId]) checked[r.dataSourceId] = { version: r.fetchedAt, checkedAt };
    const bound = desired.bound.get(r.dataSourceId) ?? [];
    const newer = r.fetchedAt > (held[r.dataSourceId] ?? -1);
    const wantBlobs = includeBlobs && hasBoundListImage(bound);
    if (!newer && !wantBlobs) continue;
    const data: unknown = JSON.parse(r.dataJson);
    // Stored only if it fit the spots published then; this screen's manifest may bind it differently.
    if (snapshotFit(bound, data).refused) continue;
    if (newer) snapshots.push({ id: r.dataSourceId, version: r.fetchedAt, fetchedAt: new Date(r.fetchedAt).toISOString(), checkedAt, data });
    if (wantBlobs) photosBySource[first.has(r.dataSourceId) ? 0 : 1].push(boundImageHashes(bound, data));
  }
  // One from each source in turn: every feed's first stories come before any feed's later ones, rather than the
  // sources first in order filling the reply.
  const order = new Set<string>();
  for (const group of photosBySource) for (let i = 0; group.some((h) => i < h.length); i++) for (const h of group) if (i < h.length) order.add(h[i]!);
  const photos = [...order];
  const lacking = photos.filter((sha) => !have.has(sha)).length;
  // From the photo after the one the last ask ended on, round to the front: photos that never arrive, and those a
  // screen holding more than MAX_SYNC_BLOBS holds but cannot report, cannot keep the rest from being asked for. From
  // the front once more are missing than were (a publish, a feed's new stories), so leads come before deeper stories.
  const start = last?.after !== undefined && lacking <= last.missing ? photos.indexOf(last.after) + 1 : 0;
  const missing = [...photos.slice(start), ...photos.slice(0, start)].filter((sha) => !have.has(sha));
  const blobs = missing.slice(0, MAX_SYNC_RESPONSE_BLOBS);
  return { snapshots, checked, ...(blobs.length ? { blobs } : {}), missing: missing.length };
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

/**
 * The body as text, or undefined once it is over MAX_SYNC_REQUEST_BYTES: a declared length is
 * refused unread, and a body without one is read no further than the ceiling.
 */
async function boundedText(req: Request): Promise<string | undefined> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_SYNC_REQUEST_BYTES) return undefined;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.byteLength;
    if (size > MAX_SYNC_REQUEST_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(r.value);
  }
  return new Blob(chunks).text();
}

export async function syncRoute(c: Context<DeviceEnv>): Promise<Response> {
  const text = await boundedText(c.req.raw);
  if (text === undefined) return refuse(413, `the body is over ${MAX_SYNC_REQUEST_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'the body is not JSON');
  }
  const parsed = parseSyncRequest(body);
  if (!parsed.ok) return c.json({ error: 'invalid sync request', problems: parsed.problems }, 400);
  const req = parsed.value;
  const screen = c.get('screen');
  const now = Date.now();

  const manifests = await screenManifests(c.env.BLOBS, screen);
  const desired = manifests.find((m) => m.id === screen.desiredManifestId);
  const playable = !desired || canPlay(req.player, desired);
  // Falling back from the desired manifest, the screen plays its last good one: a feed both bind gets its photos first,
  // rather than the reply filling with those of feeds only the broken one names (#464).
  const playing =
    desired && req.manifest.fallbackFrom === desired.id ? (await fileManifests(c.env.BLOBS, screen)).find((m) => m.id === req.manifest.active) : undefined;
  const last = screen.lastPhotos;
  const { missing, ...snapshotsOut } = await snapshotsFor(
    c.env,
    screen,
    desired,
    req.snapshots,
    req.blobs,
    playable,
    playing?.dataSources ?? new Set(),
    last,
  );
  const asked = snapshotsOut.blobs;
  // Soon again while more are missing than this reply asks for and the count still missing moves. When it holds (the
  // screen cannot fetch them, keeps only those it plays, or holds more than MAX_SYNC_BLOBS), one retry, for a reply
  // that was lost, then the full interval, as for a screen with nothing missing.
  const moved = !last?.asked || missing !== last.missing;
  const soon = missing > (asked?.length ?? 0) && (moved || !last?.retried);

  const { player, manifest: m, display: d, clock } = req;
  // Only the contract's fields, copied one by one: the parser lets unknown keys through, and the
  // device lookup reads this row with json_extract, which a deeply nested unknown key would break.
  const heartbeat: ScreenHeartbeat = {
    at: now,
    player: { version: player.version, manifestSchemas: [...player.manifestSchemas], protocols: [...player.protocols] },
    manifest: {
      filesMissing: m.filesMissing,
      ...(m.active !== undefined && { active: m.active }),
      ...(m.fallbackFrom !== undefined && { fallbackFrom: m.fallbackFrom }),
      ...(m.lastGood !== undefined && { lastGood: m.lastGood }),
    },
    display: {
      on: d.on,
      ...(d.methods !== undefined && { methods: { ...d.methods } }),
      ...(d.override !== undefined && { override: { state: d.override.state, until: d.override.until } }),
    },
    clock: { offsetMs: clock.offsetMs, trusted: clock.trusted },
    driftMs: now - Date.parse(req.deviceTime),
    // A player before gh-45 reports every source seen since it started: kept to a bounded row.
    dataRejected: Object.fromEntries(Object.entries(req.dataRejected ?? {}).slice(0, MAX_SYNC_SOURCES)),
    photos: { held: req.blobs?.length ?? 0, missing, asked: asked !== undefined, retried: !moved, ...(asked && { after: asked.at(-1)! }) },
  };
  const counts = req.playCounts
    .map((p) => ({ hour: Date.parse(p.hour), spotId: p.spot, plays: p.plays, ms: Math.round(p.ms) }))
    .filter((p) => p.hour <= now + FUTURE_SLACK_MS);

  const stored = await scoped(c.env.DB, screen.orgId).screens.sync(screen.screenId, {
    at: now,
    playerVersion: req.player.version,
    heartbeatJson: JSON.stringify(heartbeat),
    fallbackFrom: req.manifest.fallbackFrom ?? null,
    active: req.manifest.active,
    // The heartbeat was built when it read `active`: the screen's clock then, corrected. An untrusted one cannot be compared.
    ...(clock.trusted && { observedAt: Date.parse(req.deviceTime) + clock.offsetMs }),
    epoch: req.epoch,
    seq: req.seq,
    counts,
  });
  if (!stored) return refuse(401, 'unauthorized');
  const commands: DeviceCommand[] = playable ? [] : [{ type: 'reload' }];
  const display = overrideCommand(screen, req.display.override, now);
  if (display) commands.push(display);

  const res: SyncResponse = {
    serverTime: new Date().toISOString(),
    nextSyncS: soon ? MORE_PHOTOS_SYNC_S : SYNC_INTERVAL_S,
    epoch: req.epoch,
    ackSeq: stored.ackSeq,
    ...(screen.desiredManifestId ? { desiredManifest: screen.desiredManifestId } : {}),
    ...snapshotsOut,
    socketTicket: await issueTicket(c.env, { screenId: screen.screenId, credentialId: c.get('credentialId') }),
    commands,
  };
  return c.json(res, 200, { 'cache-control': 'no-store' });
}
