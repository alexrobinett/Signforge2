/**
 * On-device content store. Files are kept in Cache Storage under their SHA-256, so a file is
 * downloaded once however many manifests use it, and a manifest only goes live when every file
 * it names is present and verified.
 */
import type { ScreenManifest } from '@signforge/contract';
import { planSync, requiredFiles, safeUrl, validTimezone, validateManifest } from '@signforge/player-core';

const BLOBS = 'sf-blobs-v1';
const STATE = 'sf-state-v1';
const ACTIVE = '/_sf/manifest/active';
const blobKey = (sha: string) => `/_sf/blob/${sha}`;

/**
 * The manifest that last played a spot. Kept, with its files, until a newer manifest has played
 * one, so a screen whose new content plays nothing can go back to what it showed before.
 */
const LAST_GOOD = '/_sf/manifest/last-good';

const jsonResponse = (text: string) => new Response(text, { headers: { 'content-type': 'application/json' } });

/**
 * What the player needs to run a manifest at all: without these the sequencer cannot pick a spot.
 * Also holds the line on what makes a screen unsafe, whatever release stored the manifest.
 */
function unplayable(m: Partial<ScreenManifest> | null): string | undefined {
  if (!m || typeof m !== 'object') return 'not an object';
  if (typeof m.id !== 'string' || !m.id) return 'no id';
  for (const k of ['files', 'templates', 'spots', 'playlists', 'dataSources'] as const) if (!m[k] || typeof m[k] !== 'object') return `no ${k}`;
  if (!Array.isArray(m.schedule)) return 'no schedule';
  if (!m.screen || !validTimezone(m.screen.timezone)) return 'no valid time zone';
  if (!Object.values(m.playlists!).every((p) => p && Array.isArray(p.items))) return 'a playlist has no items';
  if (!m.playlists![m.defaultPlaylist ?? '']) return 'no default playlist';
  if (Object.values(m.spots!).some((sp) => sp?.kind === 'url' && !safeUrl(sp.url))) return 'a URL spot is not https';
  return undefined;
}

/**
 * Read a stored manifest. Everything stored passed the validator of the release that stored it,
 * so one this release's validator rejects (a schema it no longer plays, a tightened rule) is
 * still played when it can be run at all: an offline screen keeps its content across an update.
 */
async function loadStored(key: string): Promise<ScreenManifest | undefined> {
  const text = await (await (await caches.open(STATE)).match(key))?.text();
  if (text === undefined) return undefined;
  let m: ScreenManifest;
  try {
    m = JSON.parse(text) as ScreenManifest;
  } catch {
    console.warn(`[sf] stored manifest ${key} is not JSON; ignored`);
    return undefined;
  }
  const broken = unplayable(m);
  if (broken) {
    console.warn(`[sf] stored manifest ${key} cannot be played (${broken}); ignored`);
    return undefined;
  }
  const problems = validateManifest(m);
  if (problems.length) console.warn(`[sf] stored manifest ${m.id} is kept although this player rejects it: ${problems[0]}`);
  return m;
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

/**
 * Every file the screen must keep: those of the active manifest and of the last one that played.
 * Anything else in the cache can be deleted.
 */
export async function filesToKeep(): Promise<Set<string>> {
  const { active, lastGood } = await loadManifests();
  const keep = new Set<string>();
  for (const m of [active, lastGood]) if (m) for (const sha of requiredFiles(m)) keep.add(sha);
  return keep;
}

/** A download may take as long as it needs, but gives up after this long without receiving anything. */
export const STALL_MS = 30_000;

async function download(url: string, headers: Record<string, string>, stallMs: number): Promise<ArrayBuffer> {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(new Error('download stalled')), stallMs);
  const nudge = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error('download stalled')), stallMs);
  };
  try {
    const r = await fetch(url, { cache: 'no-store', headers, signal: ctl.signal });
    if (r.status === 401) throw new UnauthorisedError();
    if (!r.ok || !r.body) throw new Error(`request failed: ${r.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      nudge();
      chunks.push(value);
      size += value.byteLength;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out.buffer;
  } finally {
    clearTimeout(timer);
  }
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

async function heldHashes(): Promise<string[]> {
  const keys = await (await caches.open(BLOBS)).keys();
  return keys.map((r) => new URL(r.url).pathname.split('/').pop()!);
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SyncResult {
  manifest?: ScreenManifest;
  /** True when a new manifest was downloaded and made active. */
  changed: boolean;
  downloaded: number;
}

/**
 * The server refused the screen's credential. Not offline: the server answered. The player keeps
 * playing what it has; pairing (M3-08) decides what a revoked screen shows.
 */
export class UnauthorisedError extends Error {
  constructor() {
    super('not authorised');
    this.name = 'UnauthorisedError';
  }
}

export interface SyncOptions {
  /** The id of the manifest playing now. Sent as `If-None-Match`, so an unchanged manifest is a 304. */
  currentId?: string;
  /** Sent on every request: the device credential when the content base is the API. */
  headers?: Record<string, string>;
  /** Give up on a download after this long without receiving anything. Default `STALL_MS`. */
  stallMs?: number;
}

/**
 * Fetch the manifest at `base`. If it is new, download and verify every missing file, then
 * make it active in one step. Any failure leaves the current manifest and files untouched.
 */
export async function sync(base: string, { currentId, headers = {}, stallMs = STALL_MS }: SyncOptions = {}): Promise<SyncResult> {
  const get = (conditional: boolean) =>
    fetch(`${base}/manifest.json`, {
      // no-store keeps the browser's HTTP cache out of it, so the condition is ours to send.
      cache: 'no-store',
      headers: conditional && currentId ? { ...headers, 'if-none-match': `"${currentId}"` } : headers,
      signal: AbortSignal.timeout(20_000),
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
  const next = JSON.parse(text) as ScreenManifest;
  const same = next.id === currentId;

  if (!same) {
    const problems = validateManifest(next);
    if (problems.length) throw new Error(`manifest ${next.id} rejected: ${problems[0]}`);
  }

  // Even when the manifest is unchanged, files may have gone: the browser can evict the cache
  // under storage pressure if persistence was refused. Fetch back whatever is missing.
  const blobs = await caches.open(BLOBS);
  const { missing } = planSync(next, await heldHashes());
  if (same && !missing.length && !rewrite) return { changed: false, downloaded: 0 };
  for (const sha of missing) {
    const buf = await download(`${base}/blobs/${sha}`, headers, stallMs).catch((err: unknown) => {
      if (err instanceof UnauthorisedError) throw err;
      throw new Error(`file ${sha.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if ((await sha256(buf)) !== sha) throw new Error(`file ${sha.slice(0, 12)} failed verification`);
    await blobs.put(blobKey(sha), new Response(buf, { headers: { 'content-type': next.files[sha]?.type ?? 'application/octet-stream' } }));
  }

  if (same && !rewrite) return { changed: false, downloaded: missing.length };
  await (await caches.open(STATE)).put(ACTIVE, jsonResponse(text));
  if (same) return { changed: false, downloaded: missing.length };
  // Safe to drop now: anything on screen already holds its files in memory. The last manifest
  // that played keeps its files, in case the new one plays nothing.
  const keep = await filesToKeep();
  await Promise.all((await heldHashes()).filter((sha) => !keep.has(sha)).map((sha) => blobs.delete(blobKey(sha))));
  return { manifest: next, changed: true, downloaded: missing.length };
}

/** Ask the browser not to evict the cache under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}
