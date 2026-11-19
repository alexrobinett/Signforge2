/**
 * Fetching one content file into Cache Storage. Shared by the download worker and, where there
 * are no workers, the store itself.
 */
// Not the package root: that brings the HTML parser the download worker has no use for.
import { Sha256 } from '@signforge/player-core/sha256';

/**
 * The server refused the screen's credential. Not offline: the server answered. The player treats
 * it as revoked: it wipes what it holds and pairs again (main.ts `revoked`).
 */
export class UnauthorisedError extends Error {
  constructor() {
    super('not authorised');
    this.name = 'UnauthorisedError';
  }
}

export interface DownloadRequest {
  url: string;
  /** The file's SHA-256, hex. */
  sha: string;
  /** Its media type, stored with it. */
  type: string;
  headers: Record<string, string>;
  stallMs: number;
  /** Where the verified file goes, and where it waits until verified. */
  key: string;
  partialKey: string;
}

/** What the download worker answers. */
export type DownloadResult = { ok: true } | { ok: false; unauthorised: boolean; message: string };

/** A download may take as long as it needs, but gives up after this long without receiving anything. */
export const STALL_MS = 30_000;

/**
 * Stream one file into the cache, hashing it on the way, and store it under its hash only if the
 * hash matches. Until then it sits under a partial key nothing reads, so a file that fails
 * verification, or a download cut short, is never used. Memory stays flat whatever the file's size.
 */
export async function download(blobs: Cache, { url, sha, type, headers, stallMs, key, partialKey: partial }: DownloadRequest): Promise<void> {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(new Error('download stalled')), stallMs);
  const nudge = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error('download stalled')), stallMs);
  };
  try {
    // No cookie, as in store.ts's sync.
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', headers, signal: ctl.signal });
    if (r.status === 401) throw new UnauthorisedError();
    if (!r.ok || !r.body) throw new Error(`request failed: ${r.status}`);
    const hash = new Sha256();
    const hashed = r.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          nudge();
          hash.update(chunk);
          out.enqueue(chunk);
        },
      }),
      { signal: ctl.signal },
    );
    await blobs.put(partial, new Response(hashed, { headers: { 'content-type': type } }));
    clearTimeout(timer);
    if (hash.hex() !== sha) throw new Error('failed verification');
    // A copy within the cache, disk to disk.
    await blobs.put(key, (await blobs.match(partial))!);
  } catch (err) {
    // An abort surfaces as the stream's error; report why it was aborted.
    throw ctl.signal.aborted ? ctl.signal.reason : err;
  } finally {
    clearTimeout(timer);
    // Stop the transfer if storing failed while the response was still arriving.
    ctl.abort();
    await blobs.delete(partial).catch(() => false);
  }
}
