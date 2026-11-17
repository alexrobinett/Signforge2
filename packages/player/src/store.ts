/**
 * On-device content store. Files are kept in Cache Storage under their SHA-256, so a file is
 * downloaded once however many manifests use it, and a manifest only goes live when every file
 * it names is present and verified.
 */
import type { ScreenManifest } from '@signforge/contract';
import { planSync, validateManifest } from '@signforge/player-core';

const BLOBS = 'sf-blobs-v1';
const STATE = 'sf-state-v1';
const ACTIVE = '/_sf/manifest/active';
const blobKey = (sha: string) => `/_sf/blob/${sha}`;

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

/** A download may take as long as it needs, but gives up after this long without receiving anything. */
const STALL_MS = 30_000;

async function download(url: string, headers: Record<string, string>): Promise<ArrayBuffer> {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(new Error('download stalled')), STALL_MS);
  const nudge = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error('download stalled')), STALL_MS);
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
}

/**
 * Fetch the manifest at `base`. If it is new, download and verify every missing file, then
 * make it active in one step. Any failure leaves the current manifest and files untouched.
 */
export async function sync(base: string, { currentId, headers = {} }: SyncOptions = {}): Promise<SyncResult> {
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
  const { missing, stale } = planSync(next, await heldHashes());
  if (same && !missing.length) return { changed: false, downloaded: 0 };
  for (const sha of missing) {
    const buf = await download(`${base}/blobs/${sha}`, headers).catch((err: unknown) => {
      if (err instanceof UnauthorisedError) throw err;
      throw new Error(`file ${sha.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if ((await sha256(buf)) !== sha) throw new Error(`file ${sha.slice(0, 12)} failed verification`);
    await blobs.put(blobKey(sha), new Response(buf, { headers: { 'content-type': next.files[sha]?.type ?? 'application/octet-stream' } }));
  }

  if (same) return { changed: false, downloaded: missing.length };
  await (await caches.open(STATE)).put(ACTIVE, new Response(text, { headers: { 'content-type': 'application/json' } }));
  // Safe to drop now: anything on screen already holds its files in memory.
  await Promise.all(stale.map((sha) => blobs.delete(blobKey(sha))));
  return { manifest: next, changed: true, downloaded: missing.length };
}

/** Ask the browser not to evict the cache under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}
