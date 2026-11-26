/**
 * On-device content store. Files are kept in Cache Storage under their SHA-256, so a file is
 * downloaded once however many manifests use it, and a manifest only goes live when every file
 * it names is present and verified.
 */
import { manifestShape, parseManifest, safeUrl, validTimezone, validateManifest, type ScreenManifest } from '@signforge/contract';
import { planSync } from '@signforge/player-core';
import type { Frames } from './bundles';
import { STALL_MS, UnauthorisedError, download, type DownloadRequest, type DownloadResult } from './download';

declare const __SF_PLAYER_VERSION__: string;

export { UnauthorisedError };

const BLOBS = 'sf-blobs-v1';
const STATE = 'sf-state-v1';
const ACTIVE = '/_sf/manifest/active';
const BLOB_PREFIX = '/_sf/blob/';
const PARTIAL_PREFIX = '/_sf/partial/';
const blobKey = (sha: string) => `${BLOB_PREFIX}${sha}`;

/**
 * Each template bundle as this player contains it (`containedFrames`), kept beside the file cache so the first prepare
 * after a page load or a kiosk restart does not contain it again: on a Pi 4 that was about 240 ms of a 400 kB bundle's
 * first prepare (#232). Kept under the player's version, which names its commit: a player that contains bundles
 * differently never reads what another made, and a sync's cleanup deletes what other versions left.
 */
const FRAMES = 'sf-frames-v1';
const FRAMES_PREFIX = '/_sf/frames/';
const framesKey = (sha: string) => `${FRAMES_PREFIX}${encodeURIComponent(__SF_PLAYER_VERSION__)}/${sha}`;

/** The frames this player made of bundle `sha` and kept, if it has. */
export async function storedFrames(sha: string): Promise<Frames | undefined> {
  const res = await (await caches.open(FRAMES)).match(framesKey(sha));
  if (!res) return undefined;
  const kept: unknown = await res.json();
  return typeof kept === 'object' && kept && 'wrapper' in kept && 'template' in kept && typeof kept.wrapper === 'string' && typeof kept.template === 'string'
    ? { wrapper: kept.wrapper, template: kept.template }
    : undefined;
}

/** Keep the frames of bundle `sha`, for the next page load. */
export async function storeFrames(sha: string, frames: Frames): Promise<void> {
  await (await caches.open(FRAMES)).put(framesKey(sha), jsonResponse(JSON.stringify(frames)));
}

/**
 * Download one file into the file cache (see `download`). In the browser it runs in a worker, so
 * hashing (about 2 ms per 64 KB on the Pi 4) never takes time from the spot on screen. Without
 * workers (unit tests in Node) it runs here.
 */
async function fetchFile(req: DownloadRequest, signal: AbortSignal): Promise<void> {
  if (typeof Worker === 'undefined') return download(await caches.open(BLOBS), req);
  const worker = new Worker(new URL('./download-worker.ts', import.meta.url), { type: 'module', name: 'sf-download' });
  try {
    await new Promise<void>((resolve, reject) => {
      // Terminating the worker ends its transfer and anything it was about to store.
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      worker.onmessage = (e: MessageEvent<DownloadResult>) => {
        if (e.data.ok) resolve();
        else reject(e.data.unauthorised ? new UnauthorisedError() : new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'download worker failed'));
      // A relative content base would resolve against the worker's script; resolve it against the page.
      worker.postMessage({ cache: BLOBS, req: { ...req, url: new URL(req.url, location.href).href } });
    });
  } finally {
    worker.terminate();
  }
}

/**
 * The manifest that last played a spot. Kept, with its files, until a newer manifest has played
 * one, so a screen whose new content plays nothing can go back to what it showed before.
 */
const LAST_GOOD = '/_sf/manifest/last-good';

const jsonResponse = (text: string) => new Response(text, { headers: { 'content-type': 'application/json' } });

/**
 * What the player needs to run a manifest at all, beyond its shape: without these the sequencer cannot pick a spot.
 * Also holds the line on what makes a screen unsafe, whatever release stored the manifest.
 */
function unplayable(m: ScreenManifest): string | undefined {
  if (!validTimezone(m.screen.timezone)) return 'no valid time zone';
  if (!m.playlists[m.defaultPlaylist]) return 'no default playlist';
  if (Object.values(m.spots).some((sp) => sp.kind === 'url' && !safeUrl(sp.url))) return 'a URL spot is not https';
  return undefined;
}

/**
 * Read a stored manifest. Everything stored passed the validator of the release that stored it,
 * so one this release's validator rejects (a schema it no longer plays, a tightened rule) is
 * still played when it can be run at all: when it reads as the manifest's shape (#156) and is playable. An offline
 * screen keeps its content across an update.
 */
async function loadStored(key: string): Promise<ScreenManifest | undefined> {
  const text = await (await (await caches.open(STATE)).match(key))?.text();
  if (text === undefined) return undefined;
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    console.warn(`[sf] stored manifest ${key} is not JSON; ignored`);
    return undefined;
  }
  const read = manifestShape.read(stored);
  const broken = read.ok ? unplayable(read.value) : read.problems[0];
  if (!read.ok || broken) {
    console.warn(`[sf] stored manifest ${key} cannot be played (${broken}); ignored`);
    return undefined;
  }
  const problems = validateManifest(read.value);
  if (problems.length) console.warn(`[sf] stored manifest ${read.value.id} is kept although this player rejects it: ${problems[0]}`);
  return read.value;
}

/** The manifest last made active and the last one that played, as far as the cache holds usable copies. */
export async function loadManifests(): Promise<{ active?: ScreenManifest; lastGood?: ScreenManifest }> {
  const [active, lastGood] = await Promise.all([loadStored(ACTIVE), loadStored(LAST_GOOD)]);
  return { ...(active && { active }), ...(lastGood && { lastGood }) };
}

/** The manifest last made active, if the cache holds a usable copy. */
export async function loadActiveManifest(): Promise<ScreenManifest | undefined> {
  return loadStored(ACTIVE);
}

/** Record that `manifest` played a spot: it becomes the one to fall back to. */
export async function rememberGood(manifest: ScreenManifest): Promise<void> {
  await (await caches.open(STATE)).put(LAST_GOOD, jsonResponse(JSON.stringify(manifest)));
}

export async function getBlob(sha: string): Promise<Blob> {
  const res = await (await caches.open(BLOBS)).match(blobKey(sha));
  if (!res) throw new Error(`file ${sha.slice(0, 12)} is not in the cache`);
  return res.blob();
}

/** Whether stored manifest text parses and is the manifest `id`. */
function storedIs(text: string | undefined, id: string | undefined): text is string {
  try {
    return !!text && (JSON.parse(text) as { id?: unknown } | null)?.id === id;
  } catch {
    return false;
  }
}

/** Every key in the file cache: verified files by hash, and any partial left by an interrupted download. */
async function heldKeys(blobs: Cache): Promise<{ hashes: string[]; partials: string[] }> {
  const paths = (await blobs.keys()).map((r) => new URL(r.url).pathname);
  return {
    hashes: paths.filter((p) => p.startsWith(BLOB_PREFIX)).map((p) => p.slice(BLOB_PREFIX.length)),
    partials: paths.filter((p) => p.startsWith(PARTIAL_PREFIX)),
  };
}

/**
 * Files the player is using outside the active manifest, which cleanup must keep: the spot on
 * screen, the spot preparing (which may belong to the manifest just replaced), the last known good
 * manifest. Each holder names its own set; holding again replaces it, `release` drops it.
 */
export class PinSet implements Iterable<string> {
  private holders = new Map<string, ReadonlySet<string>>();

  hold(holder: string, hashes: Iterable<string>): void {
    this.holders.set(holder, new Set(hashes));
  }

  release(holder: string): void {
    this.holders.delete(holder);
  }

  *[Symbol.iterator](): Iterator<string> {
    const seen = new Set<string>();
    for (const set of this.holders.values()) for (const h of set) if (!seen.has(h)) seen.add(h), yield h;
  }
}

/**
 * The end of the file cache work queued so far. A sync and a feed-image pass take turns: each
 * one's cleanup deletes every partial download and every file the active manifest does not name,
 * so run alongside another it would delete that one's download in flight, or the files of a
 * manifest downloaded but not yet made active.
 */
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work);
  turn = run.catch(() => undefined);
  return run;
}

/** Files of the manifest last synced, and of the one playing while falling back, that were missing and are not yet downloaded. */
let missingNow = 0;
export const filesMissing = (): number => missingNow;

export interface SyncResult {
  manifest?: ScreenManifest;
  /** True when a new manifest was downloaded and made active. */
  changed: boolean;
  downloaded: number;
}

export interface SyncOptions {
  /** The id of the manifest playing now. Sent as `If-None-Match`, so an unchanged manifest is a 304. */
  currentId?: string;
  /** Sent on every request: the device credential when the content base is the API. */
  headers?: Record<string, string>;
  /** Give up on a download after this long without receiving anything. Default `STALL_MS`. */
  stallMs?: number;
  /**
   * Files cleanup must keep although the manifest no longer names them (see `PinSet`). Read when
   * cleanup runs, after the downloads, so pins taken meanwhile count.
   */
  pinned?: Iterable<string>;
  /** Stops the sync: no request continues, and nothing more is stored once it has aborted. */
  signal?: AbortSignal;
  /**
   * The manifest playing instead of the synced one, which played nothing: while the synced one is
   * unchanged, its missing files are fetched back too, after, and a failure there fails nothing.
   */
  fallback?: ScreenManifest;
}

/**
 * Fetch the manifest at `base`. If it is new, download and verify every missing file, then
 * make it active in one step. Any failure leaves the current manifest and files untouched.
 */
export function sync(base: string, options: SyncOptions = {}): Promise<SyncResult> {
  return inTurn(() => syncNow(base, options));
}

async function syncNow(
  base: string,
  { currentId, headers = {}, stallMs = STALL_MS, pinned = [], fallback, signal = new AbortController().signal }: SyncOptions,
): Promise<SyncResult> {
  const get = (conditional: boolean) =>
    fetch(`${base}/manifest.json`, {
      // no-store keeps the browser's HTTP cache out of it, so the condition is ours to send.
      cache: 'no-store',
      // The device API refuses a session cookie, which a test screen on the CMS's hostname has.
      credentials: 'omit',
      headers: conditional && currentId ? { ...headers, 'if-none-match': `"${currentId}"` } : headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
  let res = await get(true);
  let text: string | undefined;
  /** The stored copy of the current manifest is missing or damaged: store the fresh one even if unchanged. */
  let rewrite = false;
  if (res.status === 304) {
    // Unchanged: the active manifest is still the one to check for missing files. If it has
    // gone from the cache, ask again in full.
    text = await (await (await caches.open(STATE)).match(ACTIVE))?.text();
    if (!storedIs(text, currentId)) {
      text = undefined;
      rewrite = true;
      res = await get(false);
    }
  }
  if (res.status === 401) throw new UnauthorisedError();
  if (!text) {
    if (!res.ok) throw new Error(`manifest request failed: ${res.status}`);
    text = await res.text();
  }
  const sent: unknown = JSON.parse(text);
  const id = typeof sent === 'object' && sent !== null && 'id' in sent ? sent.id : undefined;
  const same = id === currentId;
  // The manifest playing, unchanged, is read by its shape alone, as it was when stored; a new one meets every rule.
  const read = same ? manifestShape.read(sent) : parseManifest(sent);
  if (!read.ok) throw new Error(`manifest ${String(id)} rejected: ${read.problems[0]}`);
  const next = read.value;

  // Even when the manifest is unchanged, files may have gone: the browser can evict the cache
  // under storage pressure if persistence was refused. Fetch back whatever is missing.
  const blobs = await caches.open(BLOBS);
  const held = (await heldKeys(blobs)).hashes;
  const own = planSync(next, held).missing;
  // Still falling back: the manifest playing is not the synced one, so its files are put back too,
  // after, and never holding up a publish (a new manifest replaces the fallback and needs only its own).
  const theirs = fallback && same ? planSync(fallback, held).missing.filter((sha) => !own.includes(sha)) : [];
  missingNow = own.length + theirs.length;
  const download = (sha: string, type = 'application/octet-stream') =>
    fetchFile({ url: `${base}/blobs/${sha}`, sha, type, headers, stallMs, key: blobKey(sha), partialKey: `${PARTIAL_PREFIX}${sha}` }, signal).catch(
      (err: unknown) => {
        if (err instanceof UnauthorisedError || signal.aborted) throw err;
        throw new Error(`file ${sha.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  for (const sha of own) {
    await download(sha, next.files[sha]?.type);
    missingNow--;
  }

  signal.throwIfAborted();
  if (!same || rewrite) await (await caches.open(STATE)).put(ACTIVE, jsonResponse(text));
  let repaired = 0;
  for (const sha of theirs) {
    try {
      await download(sha, fallback?.files[sha]?.type);
      missingNow--;
      repaired++;
    } catch (err) {
      // Revoked: the caller wipes the screen. Anything else stays counted missing, so the next sync tries again.
      if (err instanceof UnauthorisedError || signal.aborted) throw err;
      console.warn('[sf] could not fetch back a file of the manifest falling back to', err);
    }
  }
  // Every pass, not only on a change: a file pinned at the last change is dropped once released.
  await cleanup(blobs, next, pinned);
  const downloaded = own.length + repaired;
  return same ? { changed: false, downloaded } : { manifest: next, changed: true, downloaded };
}

/** Delete every file neither the active manifest nor a pin needs, and any leftover partial download. Returns true if any stale file was kept by a pin. */
async function cleanup(blobs: Cache, active: ScreenManifest, pinned: Iterable<string>): Promise<boolean> {
  const { hashes, partials } = await heldKeys(blobs);
  const { stale } = planSync(active, hashes);
  const keep = new Set(pinned);
  const evict = stale.filter((sha) => !keep.has(sha));
  await Promise.all([...evict.map(blobKey), ...partials].map((k) => blobs.delete(k)));
  // Frames go with their bundle, and those another version made go.
  const gone = new Set(evict);
  const held = new Set(hashes.filter((sha) => !gone.has(sha)).map(framesKey));
  const frames = await caches.open(FRAMES);
  const kept = (await frames.keys()).map((r) => new URL(r.url).pathname);
  await Promise.all(kept.filter((k) => !held.has(k)).map((k) => frames.delete(k)));
  return evict.length < stale.length;
}

/** Which of `hashes` are currently stored in the local blob cache, in order and deduplicated. */
export async function heldBlobs(hashes: Iterable<string>): Promise<string[]> {
  const want = [...new Set(hashes)];
  if (!want.length) return [];
  const held = new Set((await heldKeys(await caches.open(BLOBS))).hashes);
  return want.filter((sha) => held.has(sha));
}

/**
 * Feed images (#196): delete the files nothing needs, as a sync's cleanup does, then fetch those of
 * `hashes` that are missing. Cleanup goes first, so the space is free before new files arrive.
 *
 * What to keep is the stored active manifest's files (the synced one, which while falling back is
 * not the one playing) and `pinned`, read when cleanup runs. With no stored manifest nothing is
 * known to be stale, and nothing is deleted.
 *
 * Best-effort: a feed image that is missing, corrupt, too large or not an image is logged and
 * skipped, so its story plays with no image; a 401 (`UnauthorisedError`) or an abort is rethrown.
 * Returns true if cleanup kept a stale file because a pin held it.
 */
export function syncFeedImages(
  base: string,
  hashes: Iterable<string>,
  { headers = {}, stallMs = STALL_MS, pinned = [], signal = new AbortController().signal }: Pick<SyncOptions, 'headers' | 'stallMs' | 'pinned' | 'signal'> = {},
): Promise<boolean> {
  return inTurn(async () => {
    const blobs = await caches.open(BLOBS);
    const active = await loadStored(ACTIVE);
    const kept = active ? await cleanup(blobs, active, pinned) : false;
    const held = new Set((await heldKeys(blobs)).hashes);
    for (const sha of new Set(hashes)) {
      if (held.has(sha)) continue;
      signal.throwIfAborted();
      try {
        await fetchFile(
          { url: `${base}/blobs/${sha}`, sha, feedImage: true, headers, stallMs, key: blobKey(sha), partialKey: `${PARTIAL_PREFIX}${sha}` },
          signal,
        );
      } catch (err) {
        if (err instanceof UnauthorisedError || signal.aborted) throw err;
        console.warn(`[sf] feed image ${sha.slice(0, 12)} unavailable`, err);
      }
    }
    return kept;
  });
}

/** Ask the browser not to evict the cache under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}

/**
 * Forget everything a screen was sent: files, manifests (active and last good), unsent play
 * counts and data snapshots. For a revoked screen (owner decision Q2): it keeps nothing of the
 * org that revoked it. The player shell, cached by the service worker, stays.
 */
export async function wipeContent(): Promise<void> {
  await Promise.all([caches.delete(BLOBS), caches.delete(STATE), caches.delete(FRAMES)]);
  missingNow = 0;
}
