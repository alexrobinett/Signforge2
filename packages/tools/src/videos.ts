/**
 * Video assets. A video ships as it was exported: there is no transcoding, so it must already
 * match `VIDEO_SPEC`. The CMS checks the file with `@signforge/media-check` before uploading;
 * `finalize_video_upload` checks it again here, over R2 range reads, because the client cannot be
 * trusted.
 *
 * The file goes straight to R2 as a multipart upload: `create_video_upload` starts it and signs
 * an UploadPart URL per part, the browser PUTs the parts, and `finalize_video_upload` completes
 * it, reads the MP4 header, re-hashes the file and only then moves it to `o/<org>/b/<sha256>`.
 */
import { VIDEO_SPEC } from '@signforge/contract';
import { checkVideo, EXPORT_ADVICE } from '@signforge/media-check';
import { z } from 'zod';
import { assetView, requireAsset, SHA256 } from './assets';
import { id, idempotencyKey, name } from './fields';
import { orgBlobKey, uploadKey } from './r2';
import { defineTool, ToolError } from './tool';
import { outputs, VIDEO_TYPES } from './outputs';

/**
 * Every part but the last is this size, as R2 requires (at least 5 MiB, all but the last equal).
 * The largest video is 30 parts.
 */
const VIDEO_PART_BYTES = 16 * 1024 * 1024;
/** How long the part URLs work. Each part must start before then; a 500 MB file at 5 Mbit/s takes about 15 minutes. */
const VIDEO_UPLOAD_URL_SECONDS = 60 * 60;
const createVideoUpload = defineTool({
  name: 'create_video_upload',
  description: `Start uploading a video. It must already be one screens play: H.264 MP4, Baseline, Main or High profile up to level 4.2, 8-bit 4:2:0, progressive, at most 1920x1080 (either way round), ${VIDEO_SPEC.maxFps} fps, ${VIDEO_SPEC.maxBitrate / 1e6} Mbit/s and ${VIDEO_SPEC.maxBytes / 1e6} MB; the CMS checks this first with @signforge/media-check. Pass the file's SHA-256 and byte size. Returns { asset, upload }: the new asset, pending, and a multipart upload: PUT each part (bytes [ (partNumber-1)*partBytes, +size )) to its URL with the given headers before expiresAt, keep each response's ETag, then call finalize_video_upload with uploadId and the ETags. upload is null when the org already holds the file; call finalize_video_upload with just the assetId. Pass an idempotencyKey so a retry cannot create the asset twice.`,
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  needs: ['uploads'],
  input: z.object({
    name: name('asset'),
    sha256: z.string().regex(SHA256, 'not a SHA-256 (64 lowercase hex characters)'),
    type: z.enum(VIDEO_TYPES),
    size: z
      .number()
      .int()
      .positive()
      .max(VIDEO_SPEC.maxBytes, `a video may be at most ${VIDEO_SPEC.maxBytes / 1e6} MB`),
    idempotencyKey,
  }),
  output: outputs.create_video_upload,
  example: { name: 'Summer promo', sha256: '1'.repeat(64), type: 'video/mp4', size: 48_000_000 },
  target: (_input, output) => ({ kind: 'asset', id: output.asset.id }),
  handler: async ({ org, blobs, input, write, services: { uploads } }) => {
    const asset = write(
      org.assets.stage.insert({
        kind: 'video',
        name: input.name,
        sha256: input.sha256,
        type: input.type,
        size: input.size,
        width: null,
        height: null,
        status: 'pending',
      }),
    );
    // Already stored and checked (an earlier upload, or `sf push`): finalize reads it from there.
    if (await blobs.head(orgBlobKey(org.orgId, input.sha256))) return { asset: assetView(asset, []), upload: null };
    const key = uploadKey(org.orgId, asset.id, input.sha256);
    const { uploadId } = await blobs.createMultipartUpload(key, { httpMetadata: { contentType: input.type } });
    const count = Math.ceil(input.size / VIDEO_PART_BYTES);
    const parts = [];
    let expiresAt = 0;
    for (let partNumber = 1; partNumber <= count; partNumber++) {
      const size = Math.min(VIDEO_PART_BYTES, input.size - (partNumber - 1) * VIDEO_PART_BYTES);
      const signed = await uploads.presignPut(key, {
        contentType: input.type,
        contentLength: size,
        expiresInSeconds: VIDEO_UPLOAD_URL_SECONDS,
        query: { partNumber: String(partNumber), uploadId },
      });
      expiresAt = signed.expiresAt;
      parts.push({ partNumber, method: 'PUT' as const, url: signed.url, headers: { 'content-type': input.type }, size });
    }
    return { asset: assetView(asset, []), upload: { uploadId, partBytes: VIDEO_PART_BYTES, parts, expiresAt } };
  },
});

const finalizeVideoUpload = defineTool({
  name: 'finalize_video_upload',
  description:
    "Finish a video upload started with create_video_upload, once every part is PUT: pass uploadId and each part's ETag (leave both out when create_video_upload returned upload: null). The server completes the upload, reads the MP4 header from storage and checks it against the video spec, and re-hashes the file. If all pass, the asset becomes verified, with its width, height and durationMs. If any fails, the file is deleted, the asset is marked rejected, and the call is refused with each problem and how to export a file that passes; upload it again as a new asset. Parts R2 cannot complete into the file (one missing, a wrong ETag) are refused without changing anything, so the client can PUT them again and retry. Finalizing a verified asset changes nothing. Returns { asset, changed }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    assetId: id('asset'),
    uploadId: z.string().min(1).max(1024).optional(),
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(10_000),
          // As the S3 API's response header gives it, in quotes; R2's binding takes it bare.
          etag: z
            .string()
            .min(1)
            .max(256)
            .transform((e) => e.replace(/^"(.*)"$/, '$1')),
        }),
      )
      .max(10_000)
      .optional(),
  }),
  output: outputs.finalize_video_upload,
  example: { assetId: 'ast_example', uploadId: 'upload-id', parts: [{ partNumber: 1, etag: '"etag"' }] },
  target: (input) => ({ kind: 'asset', id: input.assetId }),
  handler: async ({ org, blobs, input, write }) => {
    const asset = await requireAsset(org, input.assetId);
    if (asset.kind !== 'video') throw new ToolError('conflict', `asset ${asset.id} is an image; finish it with finalize_asset`);
    if (asset.status === 'verified') return { asset: assetView(asset, []), changed: false };
    if (asset.status === 'rejected') throw new ToolError('conflict', `asset ${asset.id} was rejected; upload the video again`);

    const staged = uploadKey(org.orgId, asset.id, asset.sha256);
    const stored = orgBlobKey(org.orgId, asset.sha256);
    let uploaded = await blobs.head(staged);
    if (!uploaded && input.uploadId) {
      // R2 would complete a subset of the parts into a shorter file; ask for all of them instead.
      const count = Math.ceil(asset.size / VIDEO_PART_BYTES);
      const numbers = (input.parts ?? []).map((p) => p.partNumber);
      if (numbers.length !== count || numbers.some((n, i) => n !== i + 1))
        throw new ToolError('invalid_input', `the upload has ${count} part${count === 1 ? '' : 's'}: pass the ETag of each, parts 1 to ${count} in order`, [
          { path: 'parts', message: `parts 1 to ${count}` },
        ]);
      try {
        await blobs.resumeMultipartUpload(staged, input.uploadId).complete(input.parts ?? []);
      } catch (e) {
        // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
        throw new ToolError(
          'invalid_input',
          `the upload could not be completed: ${e instanceof Error ? e.message : String(e)}`,
          [{ path: 'parts', message: 'PUT every part, then pass each ETag' }],
          false,
          { cause: e },
        );
      }
      uploaded = await blobs.head(staged);
    }
    const key = uploaded ? staged : (await blobs.head(stored)) ? stored : null;
    if (!key) throw new ToolError('invalid_input', 'not uploaded yet', [{ path: 'uploadId', message: 'not uploaded yet' }]);
    const size = uploaded?.size ?? asset.size;

    const problems: { path: string; message: string }[] = [];
    if (size !== asset.size) problems.push({ path: 'size', message: `the file is ${size} bytes, not the claimed ${asset.size}` });
    const { info, problems: video } = await checkVideo(async (offset, length) => {
      const part = await blobs.get(key, { range: { offset, length: Math.min(length, size - offset) } });
      if (!part) throw new Error(`${key} disappeared while it was read`);
      return new Uint8Array(await part.arrayBuffer());
    }, size);
    for (const p of video) problems.push({ path: p.code, message: p.message });
    if (!problems.length) {
      const body = await blobs.get(key);
      if (!body) throw new Error(`${key} disappeared while it was read`);
      const digest = new crypto.DigestStream('SHA-256');
      await body.body.pipeTo(digest);
      const actual = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (actual !== asset.sha256) problems.push({ path: 'sha256', message: `the file's SHA-256 is ${actual}, not the claimed ${asset.sha256}` });
    }

    if (problems.length || !info) {
      // `info` is null only alongside a problem; testing it narrows its type below.
      await blobs.delete(staged);
      write(org.assets.stage.update(asset, { status: 'rejected' }));
      throw new ToolError(
        'invalid_input',
        `the video was rejected and deleted: ${problems.map((p) => p.message).join('; ')}. ${EXPORT_ADVICE}`,
        problems,
        true,
      );
    }

    if (key === staged) {
      if (!(await blobs.head(stored))) {
        const body = await blobs.get(staged);
        if (!body) throw new Error(`${staged} disappeared while it was read`);
        // R2 checks the hash again as it writes, so the content-addressed key never holds other bytes.
        await blobs.put(stored, body.body, { httpMetadata: { contentType: asset.type }, sha256: asset.sha256 });
      }
      await blobs.delete(staged);
    }
    const verified = write(org.assets.stage.update(asset, { status: 'verified', width: info.width, height: info.height, durationMs: info.durationMs }));
    return { asset: assetView(verified, []), changed: true };
  },
});

export const videoTools = [createVideoUpload, finalizeVideoUpload];
