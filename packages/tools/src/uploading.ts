/**
 * Uploads, of an image or a video, in two tools (#345): `start_upload` makes the pending asset and hands out where to
 * PUT its files, and `finalize_upload` checks what landed before anything may use it. Each kind's own rules are in
 * ./assets.ts and ./videos.ts. Both need `@signforge/media` or `@signforge/media-check` on the uploading side to make
 * what they claim, so a chat agent rarely calls them; they stay on /mcp until M4-14 (owner decision on #345).
 */
import { VIDEO_SPEC } from '@signforge/contract';
import { z } from 'zod';
import { finalizeImage, renditionsInput, renewImageUpload, requireAsset, startImageUpload } from './assets';
import { id, idempotencyKey, name } from './fields';
import { defineTool, ToolError } from './tool';
import { outputs } from './outputs';
import { finalizeVideo, startVideoUpload, videoFileInput, videoParts } from './videos';

const VIDEO_ONLY = ['sha256', 'type', 'size'] as const;

const startUpload = defineTool({
  name: 'start_upload',
  description: `Start an upload; PUT its files, then call finalize_upload. kind image: two renditions made with @signforge/media, each the smallest that covers its screen box (landscape 1920x1080, portrait 1080x1920), JPEG, PNG or WebP (an SVG as it is, for both), each with its SHA-256, type, bytes, pixel size and, if raster without transparency, its sample. Returns { asset, uploads }: a PUT URL and headers per file the server lacks, until expiresAt. kind image with a pending image's assetId alone: new URLs for its files not yet PUT. kind video: an H.264 MP4 screens play as it is (${VIDEO_SPEC.maxBytes / 1e6} MB at most; @signforge/media-check checks it), by SHA-256, type and size. Returns { asset, upload }: a multipart upload, part n being bytes from (n-1)*partBytes; keep each part's ETag. upload is null when the file is held already. Pass an idempotencyKey so a retry makes one asset.`,
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  needs: ['uploads'],
  input: z
    .strictObject({
      kind: z.enum(['image', 'video']),
      assetId: id('asset').optional().describe('image only: a pending image whose upload URLs expired; nothing else with it'),
      name: name('asset').optional(),
      renditions: renditionsInput.optional().describe('image: its landscape and portrait renditions'),
      sha256: videoFileInput.sha256.optional().describe("video: the file's SHA-256"),
      type: videoFileInput.type.optional(),
      size: videoFileInput.size.optional(),
      idempotencyKey,
    })
    .superRefine((v, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (v.kind === 'image' && v.assetId !== undefined) {
        for (const k of ['name', 'renditions', ...VIDEO_ONLY] as const) if (v[k] !== undefined) issue(k, `${k} is for a new upload: an assetId renews one`);
        return;
      }
      if (v.name === undefined) issue('name', `a new ${v.kind} needs a name`);
      if (v.kind === 'image') {
        if (v.renditions === undefined) issue('renditions', 'a new image needs its renditions');
        for (const k of VIDEO_ONLY) if (v[k] !== undefined) issue(k, `${k} is for a video`);
        return;
      }
      if (v.assetId !== undefined) issue('assetId', "a video's upload is not renewed: start it again");
      if (v.renditions !== undefined) issue('renditions', 'renditions are for an image');
      for (const k of VIDEO_ONLY) if (v[k] === undefined) issue(k, `a video needs its ${k}`);
    }),
  output: outputs.start_upload,
  example: {
    kind: 'image',
    name: 'Summer menu photo',
    renditions: {
      landscape: { sha256: '1'.repeat(64), type: 'image/jpeg', size: 412_000, width: 1920, height: 1280 },
      portrait: { sha256: '2'.repeat(64), type: 'image/jpeg', size: 690_000, width: 2880, height: 1920 },
    },
  },
  target: (_input, output) => ({ kind: 'asset', id: output.asset.id }),
  handler: async (ctx) => {
    const { org, blobs, input, services } = ctx;
    if (input.assetId !== undefined) {
      const asset = await requireAsset(org, input.assetId);
      if (asset.kind === 'video') throw new ToolError('conflict', `asset ${asset.id} is a video; its upload is not renewed: start it again`);
      return renewImageUpload(org, blobs, services.uploads, asset);
    }
    // Given for a new upload of its kind: the input refuses it otherwise.
    const name = input.name!;
    if (input.kind === 'image') return startImageUpload(ctx, services.uploads, { name, renditions: input.renditions! });
    return startVideoUpload(ctx, services.uploads, { name, sha256: input.sha256!, type: input.type!, size: input.size! });
  },
});

const finalizeUpload = defineTool({
  name: 'finalize_upload',
  description:
    "Finish an upload started with start_upload, once every file is PUT. A video: pass uploadId and each part's ETag (neither when start_upload returned upload: null). The server re-hashes what landed and checks it against what was claimed: an image's type, size and pixel size against its screen box, a video's MP4 header against the video spec. If all pass, the asset becomes verified and usable. If any fails, its files are deleted, the asset is marked rejected, and the call is refused with each problem (a video's with how to export one that passes); upload it again as a new asset. A file not uploaded yet, or parts R2 cannot complete, are refused without changing anything, so PUT them and retry. Finalizing a verified asset changes nothing. Returns { asset, changed }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.strictObject({
    assetId: id('asset'),
    uploadId: z.string().min(1).max(1024).optional().describe("video only: start_upload's uploadId"),
    parts: videoParts.optional().describe("video only: each part's number and the ETag its PUT returned"),
  }),
  output: outputs.finalize_upload,
  example: { assetId: 'ast_example' },
  target: (input) => ({ kind: 'asset', id: input.assetId }),
  // Its input names no kind: the audit log says an image or a video was checked, and finds it by that; a rejection
  // records it the same way (`ToolError`'s `auditDetail`).
  auditDetail: (output) => ({ kind: output.asset.kind }),
  handler: async (ctx) => {
    const { org, input } = ctx;
    const asset = await requireAsset(org, input.assetId);
    if (asset.kind === 'video') return finalizeVideo(ctx, asset, input);
    if (input.uploadId !== undefined || input.parts !== undefined)
      throw new ToolError('invalid_input', `asset ${asset.id} is an image: uploadId and parts are for a video`, [
        { path: input.uploadId === undefined ? 'parts' : 'uploadId', message: 'for a video only' },
      ]);
    return finalizeImage(ctx, asset);
  },
});

export const uploadTools = [startUpload, finalizeUpload];
