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
import { liveOverride, type ScreenHeartbeat, sha256Hex } from '@signforge/tools';
import type { Context } from 'hono';
import type { DeviceEnv } from './auth';
import { fileManifests, screenManifests, type ManifestSummary } from './manifests';
import { issueTicket } from './ticket';

/** How often a screen syncs. */
const SYNC_INTERVAL_S = 300;
/**
 * How soon a screen syncs again while feed photos it lacks are left out of a reply (`MAX_SYNC_RESPONSE_BLOBS`): a few
 * replies bring a new feed's photos in a minute, not one batch every interval (#476). Each sync writes one D1 row, so
 * this lasts only while photos it was asked for arrive or a reply's new snapshots bring more than one ask holds, plus
 * one retry for a lost reply: a screen that cannot store them would otherwise sync 5,760 times a day rather than 288
 * (the pace rule in `syncRoute`).
 */
const MORE_PHOTOS_SYNC_S = 15;
/** How much of each asked photo's hash the heartbeat keeps, its end, to tell whether the next sync holds it: 64 bits. */
const ASK_KEPT = 16;
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
 * with how many it lacks in all and of the snapshots sent new (`fresh`), the snapshots sent (`sent`)
 * and those of them the last reply sent too (`repeat`), each by `snapshotKey`, and whether the
 * screen holds a photo the last reply asked for (`fetched`) or this reply is its one retry (`retry`).
 * `first`: sources whose photos go before the others', those of the manifest a screen plays while it
 * falls back from the desired one. `last`: the screen's last sync, whose ask this one starts after.
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
): Promise<
  Pick<SyncResponse, 'snapshots' | 'checked' | 'blobs'> & { missing: number; fresh: number; sent: string[]; repeat: string[]; fetched: boolean; retry: boolean }
> {
  const have = new Set(heldBlobs ?? []);
  const reported = new Set([...have].map((sha) => sha.slice(-ASK_KEPT)));
  const fetched = !last?.ask.length || last.ask.some((p) => reported.has(p));
  const retry = !fetched && !last?.retried;
  if (!desired?.dataSources.size) return { snapshots: [], checked: {}, missing: 0, fresh: 0, sent: [], repeat: [], fetched, retry };
  const rows = await scoped(env.DB, screen.orgId).dataSources.snapshots([...desired.dataSources]);
  // The stored version is a hash, for telling whether data changed; a screen orders snapshots by the fetch time.
  const snapshots: DataSnapshot[] = [];
  const checked: NonNullable<SyncResponse['checked']> = {};
  /** Each source's photos, in story order: `first`'s sources, then the rest. */
  const photosBySource: [string[][], string[][]] = [[], []];
  /**
   * The photos of the snapshots this reply sends, while falling back only those the manifest playing binds: the player
   * reports no snapshot of a manifest it does not hold, so the broken one's are sent with every reply and their
   * photos, which it will not keep, would take the front each time (#464). `front`: those of snapshots the last reply
   * did not send, or sent once (a reply lost on the way, #531); `fresh`: those the last reply did not send. A
   * screen that does not take a snapshot (its manifest cannot be fetched) is sent it again with every reply, and it
   * would otherwise hold the front and the pace for good.
   */
  const front = new Set<string>();
  const freshPhotos = new Set<string>();
  const lastSent = new Set(last?.sent ?? []);
  const lastRepeat = new Set(last?.repeat ?? []);
  const sent: string[] = [];
  const repeat: string[] = [];
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
    const key = newer ? await snapshotKey(r.dataSourceId, r.fetchedAt) : undefined;
    if (key) {
      snapshots.push({ id: r.dataSourceId, version: r.fetchedAt, fetchedAt: new Date(r.fetchedAt).toISOString(), checkedAt, data });
      sent.push(key);
      if (lastSent.has(key)) repeat.push(key);
    }
    if (!wantBlobs) continue;
    const hashes = boundImageHashes(bound, data);
    photosBySource[first.has(r.dataSourceId) ? 0 : 1].push(hashes);
    if (key && (!first.size || first.has(r.dataSourceId)) && !lastRepeat.has(key))
      for (const sha of hashes) {
        front.add(sha);
        if (!lastSent.has(key)) freshPhotos.add(sha);
      }
  }
  // One from each source in turn: every feed's first stories come before any feed's later ones, rather than the
  // sources first in order filling the reply.
  const order = new Set<string>();
  for (const group of photosBySource) for (let i = 0; group.some((h) => i < h.length); i++) for (const h of group) if (i < h.length) order.add(h[i]!);
  const photos = [...order];
  /** Positions in `photos` of those the screen lacks. */
  const lacking = photos.flatMap((sha, i) => (have.has(sha) ? [] : [i]));
  // The front's photos first: a feed's new stories have theirs as their text arrives, even on a screen holding more
  // than MAX_SYNC_BLOBS, which cannot report them all. Then from the photo after the one the last ask ended on, round
  // to the front, so photos that never arrive, and those such a screen holds but cannot report, cannot keep the rest
  // from being asked for; a retry asks again from where the last ask started, as that reply may have been lost.
  const fresh = lacking.filter((i) => freshPhotos.has(photos[i]!)).length;
  const end = retry ? last?.ask[0] : last?.ask.at(-1);
  const at = end === undefined ? -1 : photos.findIndex((sha) => sha.endsWith(end));
  const after = retry && at !== -1 ? at - 1 : at;
  const rest = lacking.filter((i) => !front.has(photos[i]!));
  const ask = [...lacking.filter((i) => front.has(photos[i]!)), ...rest.filter((i) => i > after), ...rest.filter((i) => i <= after)]
    .slice(0, MAX_SYNC_RESPONSE_BLOBS)
    .map((i) => photos[i]!);
  return { snapshots, checked, ...(ask.length ? { blobs: ask } : {}), missing: lacking.length, fresh, sent, repeat, fetched, retry };
}

/** A snapshot as the heartbeat remembers it was sent: the end of the hash of its source and version. */
const snapshotKey = async (id: string, version: number) => (await sha256Hex(`${id}:${version}`)).slice(-ASK_KEPT);

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
  const { missing, fresh, sent, repeat, fetched, retry, ...snapshotsOut } = await snapshotsFor(
    c.env,
    screen,
    desired,
    req.snapshots,
    req.blobs,
    playable,
    playing?.dataSources ?? new Set(),
    last,
  );
  const asked = snapshotsOut.blobs ?? [];
  // Soon again while more are missing than this reply asks for, and the screen now holds a photo the last reply asked
  // for, or the snapshots this reply sends bring more photos than it asks for (a publish). Otherwise (it cannot fetch
  // them, keeps only those it plays, holds more than MAX_SYNC_BLOBS, or the reply was lost) one retry, for a lost
  // reply; then the full interval, as for a screen with nothing missing. The retry stays spent until one reply asks for
  // all that is missing, so a screen that can never fetch them all spends it once, and a feed's turnover costs it at
  // most one 15 s sync, once it fetches the new stories' photos.
  const more = missing > asked.length;
  const soon = more && (fetched || fresh > asked.length || retry);

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
    photos: {
      held: req.blobs?.length ?? 0,
      missing,
      // Spent by a retry until a reply asks for every photo missing.
      retried: more && (!!last?.retried || retry),
      ask: asked.map((sha) => sha.slice(-ASK_KEPT)),
      sent,
      repeat,
    },
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
