/**
 * Upload an image as an asset: make its renditions here, ask the server where to put them
 * (`start_upload`, again with the asset's id once those URLs have expired), PUT each one
 * straight to R2, then have the server check them (`finalize_upload`). The tools are reached
 * through `callTool`, so the CMS passes its `/api/tools` client and a test can pass anything that
 * dispatches.
 */
import { makeRenditions, MediaError, type RenditionOptions, type Renditions } from './renditions';

/** Calls a tool and returns its output; throws on a refusal. */
export type CallTool = (name: string, input: unknown) => Promise<unknown>;

/** An upload URL this close to its expiry is renewed before use: a PUT of a large file takes a while. */
const RENEW_BEFORE_MS = 60_000;

/** One file to PUT, as `start_upload` returns it for an image. */
export interface UploadTarget {
  sha256: string;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export interface UploadOptions extends RenditionOptions {
  /** The asset's name in the library. Default: the file's name. */
  name?: string;
  callTool: CallTool;
  /** Sent to `start_upload`: the same upload retried with the same key makes one asset. */
  idempotencyKey?: string;
  fetch?: typeof fetch;
}

/** The input `start_upload` takes for an image with these renditions. */
export function assetUploadInput(name: string, r: Renditions) {
  const one = (x: Renditions['landscape']) => ({
    sha256: x.sha256,
    type: x.type,
    size: x.size,
    width: x.width,
    height: x.height,
    ...(x.sample ? { sample: { sha256: x.sample.sha256, size: x.sample.size } } : {}),
  });
  return { kind: 'image', name, renditions: { landscape: one(r.landscape), portrait: one(r.portrait) } };
}

export async function uploadImage(file: Blob, options: UploadOptions): Promise<{ asset: unknown; renditions: Renditions }> {
  const put = options.fetch ?? fetch;
  const name = options.name ?? ((file as File).name || 'image');
  const renditions = await makeRenditions(file, options);
  const created = (await options.callTool('start_upload', { ...assetUploadInput(name, renditions), idempotencyKey: options.idempotencyKey })) as {
    asset: { id: string };
    uploads: UploadTarget[];
  };
  let targets = created.uploads;
  // The first call's URLs come back on a retry with the same key, and may have expired since:
  // new ones for the same pending asset, not a second asset.
  if (targets.some((t) => t.expiresAt - RENEW_BEFORE_MS <= Date.now())) {
    targets = ((await options.callTool('start_upload', { kind: 'image', assetId: created.asset.id })) as { uploads: UploadTarget[] }).uploads;
  }
  const blobs = new Map(
    [renditions.landscape, renditions.portrait].flatMap((r) => [[r.sha256, r.blob] as const, ...(r.sample ? [[r.sample.sha256, r.sample.blob] as const] : [])]),
  );
  for (const target of targets) {
    const blob = blobs.get(target.sha256);
    if (!blob) throw new MediaError(`the server asked for a file this upload does not have (${target.sha256})`);
    const res = await put(target.url, { method: target.method, headers: target.headers, body: blob });
    if (!res.ok) throw new MediaError(`uploading ${target.sha256.slice(0, 12)} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  const finalized = (await options.callTool('finalize_upload', { assetId: created.asset.id })) as { asset: unknown };
  return { asset: finalized.asset, renditions };
}
