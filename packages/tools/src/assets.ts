/**
 * Assets: images uploaded for spots. The browser makes a landscape and a portrait rendition
 * (`@signforge/media`), `create_asset_upload` hands it a presigned PUT for each, and
 * `finalize_asset` checks what landed in R2 before anything can use it:
 *
 *   - the bytes hash to the SHA-256 the uploader claimed, and have the claimed size;
 *   - the bytes are a JPEG, PNG, WebP or SVG of the claimed type (read from the bytes);
 *   - a raster rendition has the claimed size in pixels, as displayed, and is no larger than its
 *     screen box allows under the cover rule, and within the decoded-pixel cap
 *     (`imageSizeProblem` in the contract; the cover rule is the one `sf build` follows);
 *   - a rendition's sample, when it has one, is a PNG of the size its rendition's sample has
 *     (`imageSampleSize`). Its pixels are not checked: that needs the rendition decoded, which a
 *     Worker cannot do. A wrong one misjudges only the uploading org's own text over its photo.
 *
 * A file that passes moves to `o/<org>/b/<sha256>`, where manifests reference it. One that fails
 * is deleted, and the asset is marked rejected. Video is in ./videos.ts.
 */
import { imageSampleSize, imageSizeProblem, SCREEN_BOX } from '@signforge/contract';
import type { Asset, AssetRendition, OrgScope } from '@signforge/db';
import { readImageInfo, RENDITION_TYPES } from '@signforge/media/image-info';
import { z } from 'zod';
import { id, idempotencyKey, name } from './fields';
import { page, pageInput } from './paging';
import { orgBlobKey, uploadKey } from './r2';
import { defineTool, notFound, ToolError, type ToolContext } from './tool';
import type { UploadSigner } from './upload';
import { ORIENTATIONS, ASSET_STATUSES, outputs, type AssetView, type RenditionView } from './outputs';

/** The most one rendition may weigh. A 3413x1920 PNG, the largest a cover-scaled 4K image gets, is well under it. */
export const MAX_RENDITION_BYTES = 20 * 1024 * 1024;
/** How long an upload URL works. */
export const UPLOAD_URL_SECONDS = 15 * 60;

// SVG renditions have no pixel size; the column is NOT NULL, so they store 0.
export const renditionView = (r: AssetRendition): RenditionView => ({
  orientation: r.orientation,
  sha256: r.sha256,
  type: r.type,
  size: r.size,
  width: r.width || null,
  height: r.height || null,
  sample: r.sampleSha256 && r.sampleSize !== null ? { sha256: r.sampleSha256, size: r.sampleSize } : null,
});

export const assetView = (a: Asset, renditions: AssetRendition[]): AssetView => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  status: a.status,
  sha256: a.sha256,
  type: a.type,
  size: a.size,
  width: a.width || null,
  height: a.height || null,
  durationMs: a.durationMs,
  renditions: renditions.map(renditionView).sort((x, y) => ORIENTATIONS.indexOf(x.orientation) - ORIENTATIONS.indexOf(y.orientation)),
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

export async function requireAsset(org: OrgScope, assetId: string) {
  const row = await org.assets.get(assetId);
  if (!row) throw notFound('asset', assetId);
  return row;
}

export const SHA256 = /^[0-9a-f]{64}$/;
const pixels = z.number().int().positive().max(65_535);
const sha256 = z.string().regex(SHA256, 'not a SHA-256 (64 lowercase hex characters)');
const bytes = z
  .number()
  .int()
  .positive()
  .max(MAX_RENDITION_BYTES, `a rendition may be at most ${MAX_RENDITION_BYTES / 1024 / 1024} MB`);
const renditionInput = z.object({
  sha256,
  type: z.enum(RENDITION_TYPES),
  size: bytes,
  width: pixels.nullable().describe('Pixels, as displayed; null for SVG'),
  height: pixels.nullable().describe('Pixels, as displayed; null for SVG'),
  sample: z
    .object({ sha256, size: bytes })
    .optional()
    .describe("The rendition's sample, a PNG (@signforge/media makes it); none for SVG or an image with transparent pixels"),
});

const listAssets = defineTool({
  name: 'list_assets',
  description:
    "List the organization's assets (uploaded images), newest first, a page at a time, each with its landscape and portrait renditions and usageCount: how many spots use it. An asset is usable once its status is verified. Pass query to match names (case-insensitive substring) and status to filter. Returns { assets: Asset[], next }; pass next as cursor, with the same query and status, for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({
    query: z.string().trim().max(100).optional().describe('Part of the name, any case'),
    status: z.enum(ASSET_STATUSES).optional(),
    ...pageInput,
  }),
  output: outputs.list_assets,
  example: {},
  handler: async ({ org, input }) => {
    const q = input.query?.toLowerCase();
    const matching = (await org.assets.list()).filter((a) => (!q || a.name.toLowerCase().includes(q)) && (!input.status || a.status === input.status));
    // Newest first: created time descending, then id descending.
    const { rows, next } = page(
      matching,
      (a) => [-a.createdAt, a.id],
      input,
      (x, y) => Number(x[0]) - Number(y[0]) || (x[1] === y[1] ? 0 : String(x[1]) < String(y[1]) ? 1 : -1),
    );
    const [renditions, usage] = await Promise.all([org.assets.renditions.list(), org.assets.usage(rows.map((a) => a.id))]);
    const byAsset = Map.groupBy(renditions, (r) => r.assetId);
    return { assets: rows.map((a) => ({ ...assetView(a, byAsset.get(a.id) ?? []), usageCount: usage.get(a.id)?.length ?? 0 })), next };
  },
});

const getAsset = defineTool({
  name: 'get_asset',
  description: 'Get one asset with its renditions and the ids of the spots that use it. Returns { asset, spotIds }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ assetId: id('asset') }),
  output: outputs.get_asset,
  example: { assetId: 'ast_example' },
  handler: async ({ org, input }) => {
    const a = await requireAsset(org, input.assetId);
    const [renditions, usage] = await Promise.all([org.assets.renditions.forAsset(a.id), org.assets.usage([a.id])]);
    return { asset: assetView(a, renditions), spotIds: usage.get(a.id) ?? [] };
  },
});

const createAssetUpload = defineTool({
  name: 'create_asset_upload',
  description:
    "Start uploading an image. Scale it first (the CMS uses @signforge/media): a landscape and a portrait rendition, each the smallest size that covers its screen box (1920x1080, 1080x1920), JPEG, PNG or WebP; an SVG is sent as it is for both. Pass each rendition's SHA-256, type, byte size and pixel size, and of a raster one with no transparent pixel its sample (@signforge/media makes it), which a template reads to measure text over the photo without decoding it again. Returns { asset, uploads }: the new asset, pending, and for each file the server does not already hold, a URL to PUT it to with the given headers before expiresAt. Then call finalize_asset. Pass an idempotencyKey so a retry cannot create the asset twice; a retry returns the first call's upload URLs, which still expire at their expiresAt.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  needs: ['uploads'],
  input: z
    .object({
      name: name('asset'),
      renditions: z.object({ landscape: renditionInput, portrait: renditionInput }),
      idempotencyKey,
    })
    .superRefine(({ renditions }, ctx) => {
      for (const o of ORIENTATIONS) {
        const r = renditions[o];
        const path = ['renditions', o];
        if (r.type === 'image/svg+xml') {
          if (r.width !== null || r.height !== null) ctx.addIssue({ code: 'custom', path, message: 'an SVG has no pixel size: send width and height as null' });
          if (r.sample) ctx.addIssue({ code: 'custom', path, message: 'an SVG has no sample' });
        } else if (r.width === null || r.height === null) {
          ctx.addIssue({ code: 'custom', path, message: 'a raster rendition needs its width and height' });
        } else {
          const message = imageSizeProblem(r.width, r.height, SCREEN_BOX[o]);
          if (message) ctx.addIssue({ code: 'custom', path, message });
        }
      }
      const { landscape: l, portrait: p } = renditions;
      if ((l.type === 'image/svg+xml') !== (p.type === 'image/svg+xml'))
        ctx.addIssue({ code: 'custom', path: ['renditions'], message: 'an SVG is sent as it is for both orientations' });
      // Renditions and samples alike: a file is stored and checked once, by its hash.
      const files = [l, p].flatMap((r) => [r, ...(r.sample ? [{ ...r.sample, type: 'image/png' }] : [])]);
      if (files.some((f) => files.some((g) => f.sha256 === g.sha256 && (f.type !== g.type || f.size !== g.size))))
        ctx.addIssue({ code: 'custom', path: ['renditions'], message: 'the same file cannot have two types or sizes' });
    }),
  output: outputs.create_asset_upload,
  example: {
    name: 'Summer menu photo',
    renditions: {
      landscape: { sha256: '1'.repeat(64), type: 'image/jpeg', size: 412_000, width: 1920, height: 1280 },
      portrait: { sha256: '2'.repeat(64), type: 'image/jpeg', size: 690_000, width: 2880, height: 1920 },
    },
  },
  target: (_input, output) => ({ kind: 'asset', id: output.asset.id }),
  handler: async ({ org, blobs, input, write, services: { uploads } }) => {
    const { landscape } = input.renditions;
    await clearOfSweep(
      org,
      write,
      ORIENTATIONS.flatMap((o) => [input.renditions[o].sha256, ...(input.renditions[o].sample ? [input.renditions[o].sample.sha256] : [])]),
    );
    // The asset and both renditions are written in one batch: never an asset without its renditions.
    const asset = write(
      org.assets.stage.insert({
        kind: 'image',
        name: input.name,
        sha256: landscape.sha256,
        type: landscape.type,
        size: landscape.size,
        width: landscape.width,
        height: landscape.height,
        status: 'pending',
      }),
    );
    const renditions = ORIENTATIONS.map((o) => {
      const r = input.renditions[o];
      return write(
        org.assets.renditions.stage.insert({
          assetId: asset.id,
          orientation: o,
          sha256: r.sha256,
          type: r.type,
          size: r.size,
          width: r.width ?? 0,
          height: r.height ?? 0,
          sampleSha256: r.sample?.sha256 ?? null,
          sampleSize: r.sample?.size ?? null,
        }),
      );
    });
    return { asset: assetView(asset, renditions), uploads: await uploadTargets(org.orgId, asset.id, renditions, blobs, uploads, false) };
  },
});

/**
 * Every file an image asset is uploaded as, once each, for what is claimed of it: each rendition,
 * and the sample of each that has one. `path` names it in a problem; `box` is the screen box a
 * rendition fits, which a sample has none of.
 */
function claimedFiles(renditions: readonly AssetRendition[]) {
  const claims = renditions.flatMap((r) => [
    { sha: r.sha256, path: r.orientation, type: r.type, size: r.size, width: r.width, height: r.height, box: SCREEN_BOX[r.orientation] },
    ...(r.sampleSha256 && r.sampleSize !== null
      ? [{ sha: r.sampleSha256, path: `${r.orientation} sample`, type: 'image/png', size: r.sampleSize, ...imageSampleSize(r.width, r.height), box: undefined }]
      : []),
  ]);
  return Map.groupBy(claims, (c) => c.sha);
}

/**
 * A writer that could reuse stored bytes (an upload made or verified, a template registered) never adopts an object the
 * storage sweep is deleting (#235, review of #429): refused while a sweep claims any of `shas`, as it starts and again in
 * its batch. A claim lasts minutes.
 */
export async function clearOfSweep(org: OrgScope, write: ToolContext<unknown>['write'], shas: readonly string[]) {
  const now = Date.now();
  if (await org.storage.claimed(shas, now))
    throw new ToolError('conflict', 'the storage clean-up is deleting an earlier copy of these bytes: try again in a few minutes');
  write({ row: undefined, writes: org.storage.stage.unclaimed(shas, now) });
}

/**
 * A presigned PUT for each distinct file the server does not hold: not stored and checked (an
 * earlier upload, or `sf push`; finalize reads it from there), nor, with `skipUploaded`, already
 * PUT for this asset.
 */
async function uploadTargets(
  orgId: string,
  assetId: string,
  renditions: readonly AssetRendition[],
  blobs: R2Bucket,
  uploads: UploadSigner,
  skipUploaded: boolean,
) {
  const files = new Map([...claimedFiles(renditions)].map(([sha, [first]]) => [sha, { sha256: sha, type: first!.type, size: first!.size }]));
  const targets = [];
  for (const r of files.values()) {
    if (await blobs.head(orgBlobKey(orgId, r.sha256))) continue;
    if (skipUploaded && (await blobs.head(uploadKey(orgId, assetId, r.sha256)))) continue;
    const signed = await uploads.presignPut(uploadKey(orgId, assetId, r.sha256), {
      contentType: r.type,
      contentLength: r.size,
      expiresInSeconds: UPLOAD_URL_SECONDS,
    });
    targets.push({ sha256: r.sha256, method: 'PUT' as const, url: signed.url, headers: { 'content-type': r.type }, expiresAt: signed.expiresAt });
  }
  return targets;
}

const renewAssetUpload = defineTool({
  name: 'renew_asset_upload',
  description:
    'Get new upload URLs for a pending asset whose URLs from create_asset_upload expired, instead of starting the image again as a new asset. Returns { asset, uploads }: a URL for each file not yet PUT, as create_asset_upload returns them. Then call finalize_asset. Refused for an asset that is verified or rejected, and for a video.',
  scope: 'content:draft',
  minRole: 'editor',
  // It writes nothing, so nothing is audited, but it hands out the right to upload.
  mutates: true,
  needs: ['uploads'],
  input: z.object({ assetId: id('asset') }),
  output: outputs.renew_asset_upload,
  example: { assetId: 'ast_example' },
  handler: async ({ org, blobs, input, services: { uploads } }) => {
    const asset = await requireAsset(org, input.assetId);
    if (asset.kind === 'video') throw new ToolError('conflict', `asset ${asset.id} is a video; it has no image renditions to renew`);
    if (asset.status !== 'pending') throw new ToolError('conflict', `asset ${asset.id} is ${asset.status}, not waiting for its upload`);
    const renditions = await org.assets.renditions.forAsset(asset.id);
    return { asset: assetView(asset, renditions), uploads: await uploadTargets(org.orgId, asset.id, renditions, blobs, uploads, true) };
  },
});

interface Problem {
  path: string;
  message: string;
}

const finalizeAsset = defineTool({
  name: 'finalize_asset',
  description:
    'Finish an upload started with create_asset_upload, once every file is PUT. The server re-hashes each file in storage and checks its type, size and pixel size against what was claimed and against the screen box (a sample: a PNG of the sample size for its rendition). If all pass, the asset becomes verified and usable. If any fails, its files are deleted, the asset is marked rejected, and the call is refused with each problem; upload it again as a new asset. An asset without both renditions, or a file not uploaded yet, is refused without changing anything. Finalizing a verified asset changes nothing. Returns { asset, changed }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ assetId: id('asset') }),
  output: outputs.finalize_asset,
  example: { assetId: 'ast_example' },
  target: (input) => ({ kind: 'asset', id: input.assetId }),
  handler: async ({ org, blobs, input, write }) => {
    const asset = await requireAsset(org, input.assetId);
    if (asset.kind === 'video') throw new ToolError('conflict', `asset ${asset.id} is a video; finish it with finalize_video_upload`);
    const renditions = await org.assets.renditions.forAsset(asset.id);
    if (asset.status === 'verified') return { asset: assetView(asset, renditions), changed: false };
    if (asset.status === 'rejected') throw new ToolError('conflict', `asset ${asset.id} was rejected; upload the image again`);
    await clearOfSweep(org, write, [...claimedFiles(renditions).keys()]);
    // Both renditions, or the asset cannot be verified: a screen of either orientation needs its own.
    const absent = ORIENTATIONS.filter((o) => !renditions.some((r) => r.orientation === o));
    if (absent.length) {
      throw new ToolError(
        'conflict',
        `asset ${asset.id} has no ${absent.join(' or ')} rendition; upload the image again`,
        absent.map((path) => ({ path, message: 'no rendition' })),
      );
    }

    const bySha = claimedFiles(renditions);
    const staged = [...bySha.keys()].map((sha) => uploadKey(org.orgId, asset.id, sha));
    const checked: { sha: string; bytes: ArrayBuffer | null; type: string }[] = [];
    const problems: Problem[] = [];
    const missing: string[] = [];

    for (const [sha, rows] of bySha) {
      const first = rows[0]!;
      const where = rows.map((r) => r.path).join('+');
      const obj = (await blobs.get(uploadKey(org.orgId, asset.id, sha))) ?? undefined;
      const stored = obj ? undefined : await blobs.get(orgBlobKey(org.orgId, sha));
      const body = obj ?? stored;
      if (!body) {
        missing.push(where);
        continue;
      }
      if (body.size > MAX_RENDITION_BYTES) {
        await body.body.cancel();
        problems.push({ path: where, message: `${body.size} bytes is more than the ${MAX_RENDITION_BYTES} a rendition may be` });
        continue;
      }
      const bytes = await body.arrayBuffer();
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const before = problems.length;
      if (actual !== sha) problems.push({ path: where, message: `the file's SHA-256 is ${actual}, not the claimed ${sha}` });
      if (bytes.byteLength !== first.size) problems.push({ path: where, message: `the file is ${bytes.byteLength} bytes, not the claimed ${first.size}` });
      const info = readImageInfo(new Uint8Array(bytes));
      if (!info) problems.push({ path: where, message: 'the file is not a JPEG, PNG, WebP or SVG' });
      else if (info.type !== first.type) problems.push({ path: where, message: `the file is ${info.type}, not the claimed ${first.type}` });
      else if (info.width !== null && info.height !== null) {
        for (const r of rows) {
          if (info.width !== r.width || info.height !== r.height)
            problems.push({ path: r.path, message: `the image is ${info.width}x${info.height}, not the claimed ${r.width}x${r.height}` });
          else {
            const message = r.box && imageSizeProblem(info.width, info.height, r.box);
            if (message) problems.push({ path: r.path, message });
          }
        }
      }
      if (problems.length === before) checked.push({ sha, bytes: obj ? bytes : null, type: first.type });
    }

    if (problems.length) {
      await blobs.delete(staged);
      write(org.assets.stage.update(asset, { status: 'rejected' }));
      throw new ToolError('invalid_input', `the upload was rejected and deleted: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`, problems, true);
    }
    if (missing.length) {
      throw new ToolError(
        'invalid_input',
        `not uploaded yet: ${missing.join(', ')}`,
        missing.map((path) => ({ path, message: 'not uploaded yet' })),
      );
    }

    // Move each checked upload to its content-addressed key; one already there is the same bytes.
    for (const c of checked) {
      if (c.bytes && !(await blobs.head(orgBlobKey(org.orgId, c.sha)))) {
        await blobs.put(orgBlobKey(org.orgId, c.sha), c.bytes, { httpMetadata: { contentType: c.type }, sha256: c.sha });
      }
    }
    await blobs.delete(staged);
    const verified = write(org.assets.stage.update(asset, { status: 'verified' }));
    return { asset: assetView(verified, renditions), changed: true };
  },
});

const deleteAsset = defineTool({
  name: 'delete_asset',
  description:
    'Delete an asset from the library. Refused with a conflict while any spot uses it, or a brand kit uses it as its logo (details list the spot or brand kit ids); change or delete those first. Screens already playing it keep their copy until their next publish; its stored files are deleted 90 days later, once nothing needs them. Returns { deleted: assetId }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ assetId: id('asset') }),
  output: outputs.delete_asset,
  example: { assetId: 'ast_example' },
  target: (input) => ({ kind: 'asset', id: input.assetId }),
  handler: async ({ org, blobs, input, write }) => {
    const asset = await requireAsset(org, input.assetId);
    const spotIds = (await org.assets.usage([asset.id])).get(asset.id) ?? [];
    if (spotIds.length) throw new ToolError('conflict', `asset ${asset.id} is used by ${spotIds.length} spot${spotIds.length === 1 ? '' : 's'}`, { spotIds });
    const brandKitIds = (await org.brandKits.list()).filter((k) => k.logoOnDarkAssetId === asset.id || k.logoOnLightAssetId === asset.id).map((k) => k.id);
    if (brandKitIds.length)
      throw new ToolError('conflict', `asset ${asset.id} is the logo of ${brandKitIds.length} brand kit${brandKitIds.length === 1 ? '' : 's'}`, {
        brandKitIds,
      });
    // Uploads never finalized. Stored files stay for now: other assets and published manifests may name the same bytes.
    const renditions = await org.assets.renditions.forAsset(asset.id);
    // A video has no renditions: its one file is the asset's own.
    const files = asset.kind === 'video' ? [asset.sha256] : [...claimedFiles(renditions).keys()];
    const staged = [...new Set(files.map((sha) => uploadKey(org.orgId, asset.id, sha)))];
    if (staged.length) await blobs.delete(staged);
    // Its renditions go with it (the foreign key cascades). Its stored files are queued for the storage sweep, which deletes
    // each past the grace period once nothing of the org names its bytes and no screen holds a manifest from before (#235).
    // Held to the commit: a spot or a brand kit that took it up meanwhile refuses the batch (review of #429).
    write({ row: undefined, writes: [org.assets.stage.unused(asset.id)] });
    write(org.assets.stage.delete(asset.id));
    if (asset.status === 'verified') write(org.storage.stage.queue(files, Date.now()));
    return { deleted: asset.id };
  },
  // Its batch refused as it ran: a spot or a brand kit took the asset up meanwhile.
  refuseFailedCommit: async ({ org, input }) => {
    const spotIds = (await org.assets.usage([input.assetId])).get(input.assetId) ?? [];
    const kits = (await org.brandKits.list()).filter((k) => k.logoOnDarkAssetId === input.assetId || k.logoOnLightAssetId === input.assetId);
    return spotIds.length || kits.length
      ? new ToolError('conflict', `asset ${input.assetId} was taken into use while it was being deleted`, { spotIds, brandKitIds: kits.map((k) => k.id) })
      : undefined;
  },
});

export const assetTools = [listAssets, getAsset, createAssetUpload, renewAssetUpload, finalizeAsset, deleteAsset];
