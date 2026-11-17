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

export async function loadActiveManifest(): Promise<ScreenManifest | undefined> {
  const res = await (await caches.open(STATE)).match(ACTIVE);
  return res ? ((await res.json()) as ScreenManifest) : undefined;
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
 * Fetch the manifest at `base`. If it is new, download and verify every missing file, then
 * make it active in one step. Any failure leaves the current manifest and files untouched.
 */
export async function sync(base: string, currentId?: string): Promise<SyncResult> {
  const res = await fetch(`${base}/manifest.json`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`manifest request failed: ${res.status}`);
  const text = await res.text();
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
    const r = await fetch(`${base}/blobs/${sha}`, { cache: 'no-store', signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`file ${sha.slice(0, 12)} request failed: ${r.status}`);
    const buf = await r.arrayBuffer();
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
