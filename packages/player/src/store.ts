/**
 * On-device content store. Files are kept in Cache Storage under their SHA-256, so a file is
 * downloaded once however many manifests use it, and a manifest only goes live when every file
 * it names is present and verified.
 */
import type { ScreenManifest } from '@signforge/contract';
import { planSync, validateManifest } from '@signforge/player-core';
import { STALL_MS, UnauthorisedError, download, type DownloadRequest, type DownloadResult } from './download';

export { STALL_MS, UnauthorisedError };

const BLOBS = 'sf-blobs-v1';
const STATE = 'sf-state-v1';
const ACTIVE = '/_sf/manifest/active';
const BLOB_PREFIX = '/_sf/blob/';
const PARTIAL_PREFIX = '/_sf/partial/';
const blobKey = (sha: string) => `${BLOB_PREFIX}${sha}`;

/**
 * Download one file into the file cache (see `download`). In the browser it runs in a worker, so
 * hashing (about 2 ms per 64 KB on the Pi 4) never takes time from the spot on screen. Without
 * workers (unit tests in Node) it runs here.
 */
async function fetchFile(req: DownloadRequest): Promise<void> {
  if (typeof Worker === 'undefined') return download(await caches.open(BLOBS), req);
  const worker = new Worker(new URL('./download-worker.ts', import.meta.url), { type: 'module', name: 'sf-download' });
  try {
    await new Promise<void>((resolve, reject) => {
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

/** The manifest last made active, if it is one this player can still play. */
export async function loadActiveManifest(): Promise<ScreenManifest | undefined> {
  const res = await (await caches.open(STATE)).match(ACTIVE);
  if (!res) return undefined;
  const m = (await res.json()) as ScreenManifest;
  // A player update can tighten the rules; a stored manifest that now fails waits for a fresh one.
  const problems = validateManifest(m);
  if (problems.length) {
    console.warn(`[sf] cached manifest ${m.id} ignored: ${problems[0]}`);
    return undefined;
  }
  return m;
}

export async function getBlob(sha: string): Promise<Blob> {
  const res = await (await caches.open(BLOBS)).match(blobKey(sha));
  if (!res) throw new Error(`file ${sha.slice(0, 12)} is not in the cache`);
  return res.blob();
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
}

/**
 * Fetch the manifest at `base`. If it is new, download and verify every missing file, then
 * make it active in one step. Any failure leaves the current manifest and files untouched.
 */
export async function sync(base: string, { currentId, headers = {}, stallMs = STALL_MS, pinned = [] }: SyncOptions = {}): Promise<SyncResult> {
  const get = (conditional: boolean) =>
    fetch(`${base}/manifest.json`, {
      // no-store keeps the browser's HTTP cache out of it, so the condition is ours to send.
      cache: 'no-store',
      headers: conditional && currentId ? { ...headers, 'if-none-match': `"${currentId}"` } : headers,
      signal: AbortSignal.timeout(20_000),
    });
  let res = await get(true);
  let text: string | undefined;
  if (res.status === 304) {
    // Unchanged: the active manifest is still the one to check for missing files. If it has
    // gone from the cache, ask again in full.
    text = await (await (await caches.open(STATE)).match(ACTIVE))?.text();
    if (!text) res = await get(false);
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
  const { missing } = planSync(next, (await heldKeys(blobs)).hashes);
  for (const sha of missing) {
    const type = next.files[sha]?.type ?? 'application/octet-stream';
    await fetchFile({ url: `${base}/blobs/${sha}`, sha, type, headers, stallMs, key: blobKey(sha), partialKey: `${PARTIAL_PREFIX}${sha}` }).catch((err: unknown) => {
      if (err instanceof UnauthorisedError) throw err;
      throw new Error(`file ${sha.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  if (!same) await (await caches.open(STATE)).put(ACTIVE, new Response(text, { headers: { 'content-type': 'application/json' } }));
  // Every pass, not only on a change: a file pinned at the last change is dropped once released.
  await cleanup(blobs, next, pinned);
  return same ? { changed: false, downloaded: missing.length } : { manifest: next, changed: true, downloaded: missing.length };
}

/** Delete every file neither the active manifest nor a pin needs, and any leftover partial download. */
async function cleanup(blobs: Cache, active: ScreenManifest, pinned: Iterable<string>): Promise<void> {
  const { hashes, partials } = await heldKeys(blobs);
  const { stale } = planSync(active, hashes);
  const keep = new Set(pinned);
  await Promise.all([...stale.filter((sha) => !keep.has(sha)).map(blobKey), ...partials].map((k) => blobs.delete(k)));
}

/** Ask the browser not to evict the cache under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}
