/**
 * Upload a video as an asset. The file is checked here first with `@signforge/media-check`, so a
 * file screens cannot play is refused before any byte leaves the browser, with how to export one
 * that passes. Then it is hashed, `create_video_upload` signs a URL per part, each part is PUT
 * straight to R2, and `finalize_video_upload` completes the upload and checks it again.
 */
import { blobReader, checkVideo, EXPORT_ADVICE, type VideoCheck, type VideoProblem } from '@signforge/media-check';
import { z } from 'zod';
import { MediaError, sha256Hex } from './renditions';
import type { CallTool } from './upload';

/** The file is not one screens play. `problems` says why; the message adds how to export one that does. */
export class VideoRejectedError extends MediaError {
  constructor(readonly problems: VideoProblem[]) {
    super(`${problems.map((p) => p.message).join('; ')}. ${EXPORT_ADVICE}`);
    this.name = 'VideoRejectedError';
  }
}

export interface VideoUploadOptions {
  /** The asset's name in the library. Default: the file's name. */
  name?: string;
  callTool: CallTool;
  fetch?: typeof fetch;
}

const created = z.object({
  asset: z.object({ id: z.string() }),
  upload: z
    .object({
      uploadId: z.string(),
      parts: z.array(
        z.object({ partNumber: z.number(), method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), size: z.number() }),
      ),
    })
    .nullable(),
});
const finalized = z.object({ asset: z.unknown() });

export async function uploadVideo(file: File, options: VideoUploadOptions): Promise<{ asset: unknown; check: VideoCheck }> {
  const put = options.fetch ?? fetch;
  const check = await checkVideo(blobReader(file), file.size);
  if (check.problems.length) throw new VideoRejectedError(check.problems);

  const sha256 = await sha256Hex(file);
  const { asset, upload } = created.parse(
    await options.callTool('create_video_upload', { name: options.name ?? file.name, sha256, type: 'video/mp4', size: file.size }),
  );
  const parts: { partNumber: number; etag: string }[] = [];
  let start = 0;
  for (const part of upload ? upload.parts : []) {
    const body = file.slice(start, (start += part.size));
    const res = await put(part.url, { method: part.method, headers: part.headers, body });
    if (!res.ok) throw new MediaError(`uploading part ${part.partNumber} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
    const etag = res.headers.get('etag');
    // R2 sends one; the browser shows it only if the bucket's CORS rule exposes ETag.
    if (!etag) throw new MediaError(`part ${part.partNumber} was stored, but its ETag cannot be read: the bucket's CORS rule must expose ETag`);
    parts.push({ partNumber: part.partNumber, etag });
  }
  const done = finalized.parse(
    await options.callTool('finalize_video_upload', upload ? { assetId: asset.id, uploadId: upload.uploadId, parts } : { assetId: asset.id }),
  );
  return { asset: done.asset, check };
}
