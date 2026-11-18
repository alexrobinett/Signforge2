/**
 * Upload an image as an asset: make its renditions here, ask the server where to put them
 * (`create_asset_upload`), PUT each one straight to R2, then have the server check them
 * (`finalize_asset`). The tools are reached through `callTool`, so the CMS passes its
 * `/api/tools` client and a test can pass anything that dispatches.
 */
import { makeRenditions, MediaError, type RenditionOptions, type Renditions } from './renditions';

/** Calls a tool and returns its output; throws on a refusal. */
export type CallTool = (name: string, input: unknown) => Promise<unknown>;

/** One file to PUT, as `create_asset_upload` returns it. */
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
  /** Sent to `create_asset_upload`: the same upload retried with the same key makes one asset. */
  idempotencyKey?: string;
  fetch?: typeof fetch;
}

/** The input `create_asset_upload` takes for these renditions. */
export function assetUploadInput(name: string, r: Renditions) {
  const one = (x: Renditions['landscape']) => ({ sha256: x.sha256, type: x.type, size: x.size, width: x.width, height: x.height });
  return { name, renditions: { landscape: one(r.landscape), portrait: one(r.portrait) } };
}

export async function uploadImage(file: Blob, options: UploadOptions): Promise<{ asset: unknown; renditions: Renditions }> {
  const put = options.fetch ?? fetch;
  const name = options.name ?? ((file as File).name || 'image');
  const renditions = await makeRenditions(file, options);
  const created = (await options.callTool('create_asset_upload', { ...assetUploadInput(name, renditions), idempotencyKey: options.idempotencyKey })) as {
    asset: { id: string };
    uploads: UploadTarget[];
  };
  const blobs = new Map([renditions.landscape, renditions.portrait].map((r) => [r.sha256, r.blob]));
  for (const target of created.uploads) {
    const blob = blobs.get(target.sha256);
    if (!blob) throw new MediaError(`the server asked for a file this upload does not have (${target.sha256})`);
    const res = await put(target.url, { method: target.method, headers: target.headers, body: blob });
    if (!res.ok) throw new MediaError(`uploading ${target.sha256.slice(0, 12)} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  const finalized = (await options.callTool('finalize_asset', { assetId: created.asset.id })) as { asset: unknown };
  return { asset: finalized.asset, renditions };
}
