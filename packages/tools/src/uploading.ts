import { finalizeImage, renewImageUpload, requireAsset, startImageUpload } from './assets';
import { defineTool, ToolError } from './tool';
import { outputs } from './outputs';
import { finalizeVideo, startVideoUpload } from './videos';
import { inputs } from './inputs';

const startUpload = defineTool({
  name: 'start_upload',
  description:
    "Start an upload; PUT its files, then call finalize_upload. kind image: its landscape and portrait renditions made with @signforge/media; with a pending image's assetId alone, new URLs for its files not yet PUT. kind video: one MP4, by SHA-256, type and size. Pass an idempotencyKey so a retry makes one asset. describe(asset) has the rules, the video spec and how the uploads work. Returns { asset, uploads } for an image, { asset, upload } for a video (null when the file is held already).",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  needs: ['uploads'],
  input: inputs.start_upload,
  output: outputs.start_upload,
  example: {
    kind: 'image',
    name: 'Summer menu photo',
    renditions: {
      landscape: { sha256: '1'.repeat(64), type: 'image/jpeg', size: 412_000, width: 1920, height: 1280 },
      portrait: { sha256: '2'.repeat(64), type: 'image/jpeg', size: 690_000, width: 2880, height: 1920 },
    },
  },
  target: (_input, output) => (output ? { kind: 'asset', id: output.asset.id } : undefined),
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
  input: inputs.finalize_upload,
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
