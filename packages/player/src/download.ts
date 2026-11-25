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

export type DownloadRequest = {
  url: string;
  /** The file's SHA-256, hex. */
  sha: string;
  headers: Record<string, string>;
  stallMs: number;
  /** Where the verified file goes, and where it waits until verified. */
  key: string;
  partialKey: string;
} & (
  | {
      /** Its media type, from the manifest, stored with it. */
      type: string;
    }
  | {
      /**
       * A feed image (#196): no manifest names its type, so it is the response's, and the template
       * gets the file as it is. Refused unless that is one of FEED_IMAGE_TYPES and the body is at
       * most FEED_IMAGE_MAX_BYTES, which is checked as it arrives, not after it is on disk.
       */
      feedImage: true;
    }
);

/** What the download worker answers. */
export type DownloadResult = { ok: true } | { ok: false; unauthorised: boolean; message: string };

/** Image types a browser draws without running anything: no SVG, which can carry script. */
const FEED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
/** The API fetches no feed photo bigger than this (apps/api/src/data/fetch.ts), and stores nothing bigger. */
export const FEED_IMAGE_MAX_BYTES = 8_000_000;

/** A download may take as long as it needs, but gives up after this long without receiving anything. */
export const STALL_MS = 30_000;

/**
 * Stream one file into the cache, hashing it on the way, and store it under its hash only if the
 * hash matches. Until then it sits under a partial key nothing reads, so a file that fails
 * verification, or a download cut short, is never used. Memory stays flat whatever the file's size.
 */
export async function download(blobs: Cache, req: DownloadRequest): Promise<void> {
  const { url, sha, headers, stallMs, key, partialKey: partial } = req;
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
    let type: string;
    let maxBytes = Number.POSITIVE_INFINITY;
    if ('feedImage' in req) {
      type = r.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!FEED_IMAGE_TYPES.has(type)) throw new Error(`not an image a screen shows: ${type || 'no type'}`);
      maxBytes = FEED_IMAGE_MAX_BYTES;
      if (Number(r.headers.get('content-length')) > maxBytes) throw new Error('too large');
    } else type = req.type;
    const hash = new Sha256();
    let bytes = 0;
    const hashed = r.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          nudge();
          bytes += chunk.byteLength;
          // A length header can be missing or wrong: count what arrives.
          if (bytes > maxBytes) return ctl.abort(new Error('too large'));
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
