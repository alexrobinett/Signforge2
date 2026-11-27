/**
 * Assets: images uploaded for spots. The browser makes a landscape and a portrait rendition
 * (`@signforge/media`), `start_upload` hands it a presigned PUT for each, and
 * `finalize_upload` checks what landed in R2 before anything can use it (both in ./uploading.ts):
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
import { readImageInfo } from '@signforge/media/image-info';
import type { z } from 'zod';
import { page } from './paging';
import { orgBlobKey, uploadKey } from './r2';
import { defineTool, notFound, ToolError, type ToolContext } from './tool';
import type { UploadSigner } from './upload';
import { ORIENTATIONS, outputs, type AssetView, type RenditionView } from './outputs';
import { inputs, MAX_RENDITION_BYTES, type renditionsInput } from './inputs';

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

const listAssets = defineTool({
  name: 'list_assets',
  description:
    "List the organization's assets (uploaded images), newest first, a page at a time, each with its landscape and portrait renditions and usageCount: how many spots use it. An asset is usable once its status is verified. Pass query to match names (case-insensitive substring) and status to filter. Returns { assets: Asset[], next }; pass next as cursor, with the same query and status, for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: inputs.list_assets,
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
  input: inputs.get_asset,
  output: outputs.get_asset,
  example: { assetId: 'ast_example' },
  handler: async ({ org, input }) => {
    const a = await requireAsset(org, input.assetId);
    const [renditions, usage] = await Promise.all([org.assets.renditions.forAsset(a.id), org.assets.usage([a.id])]);
    return { asset: assetView(a, renditions), spotIds: usage.get(a.id) ?? [] };
  },
});

/**
 * Start an image upload (`start_upload`): the asset, pending, and both renditions in one batch, and a presigned PUT for
 * each file the server does not already hold. Then `finalize_upload`.
 */
export async function startImageUpload(
  { org, blobs, write }: Pick<ToolContext<unknown>, 'org' | 'blobs' | 'write'>,
  uploads: UploadSigner,
  input: { name: string; renditions: z.output<typeof renditionsInput> },
) {
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
  // A file held already is not uploaded again: refused at the commit if the sweep deletes it meanwhile, and one it deleted
  // is not held (review of #434).
  const now = Date.now();
  const deleted = await org.storage.deleted([...claimedFiles(renditions).keys()], now);
  const { targets, reused } = await uploadTargets(org.orgId, asset.id, renditions, blobs, uploads, false, deleted);
  write({ row: undefined, writes: org.storage.stage.notDeleted(reused, now) });
  return { asset: assetView(asset, renditions), uploads: targets };
}

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
  deleted: readonly string[],
) {
  const files = new Map([...claimedFiles(renditions)].map(([sha, [first]]) => [sha, { sha256: sha, type: first!.type, size: first!.size }]));
  const targets = [];
  const reused: string[] = [];
  for (const r of files.values()) {
    // A copy back under a key the sweep deleted is uploaded again all the same: the upload clears its tombstone.
    if (!deleted.includes(r.sha256) && (await blobs.head(orgBlobKey(orgId, r.sha256)))) {
      reused.push(r.sha256);
      continue;
    }
    if (skipUploaded && (await blobs.head(uploadKey(orgId, assetId, r.sha256)))) continue;
    const signed = await uploads.presignPut(uploadKey(orgId, assetId, r.sha256), {
      contentType: r.type,
      contentLength: r.size,
      expiresInSeconds: UPLOAD_URL_SECONDS,
    });
    targets.push({ sha256: r.sha256, method: 'PUT' as const, url: signed.url, headers: { 'content-type': r.type }, expiresAt: signed.expiresAt });
  }
  return { targets, reused };
}

/** New upload URLs for a pending image whose URLs expired (`start_upload` with its assetId): one for each file not yet PUT. */
export async function renewImageUpload(org: OrgScope, blobs: R2Bucket, uploads: UploadSigner, asset: Asset) {
  if (asset.status !== 'pending') throw new ToolError('conflict', `asset ${asset.id} is ${asset.status}, not waiting for its upload`);
  const renditions = await org.assets.renditions.forAsset(asset.id);
  const deleted = await org.storage.deleted([...claimedFiles(renditions).keys()], Date.now());
  return { asset: assetView(asset, renditions), uploads: (await uploadTargets(org.orgId, asset.id, renditions, blobs, uploads, true, deleted)).targets };
}

interface Problem {
  path: string;
  message: string;
}

/**
 * Finish an image upload (`finalize_upload`): re-hash each file in storage and check its type, size and pixel size
 * against the claim and its screen box. All pass: verified. Any fails: its files are deleted, the asset is rejected and
 * the call refused with each problem. A file not uploaded yet is refused with nothing changed.
 */
export async function finalizeImage({ org, blobs, write }: Pick<ToolContext<unknown>, 'org' | 'blobs' | 'write'>, asset: Asset) {
  const renditions = await org.assets.renditions.forAsset(asset.id);
  if (asset.status === 'verified') return { asset: assetView(asset, renditions), changed: false };
  if (asset.status === 'rejected') throw new ToolError('conflict', `asset ${asset.id} was rejected; upload the image again`);
  // Before any file is read: what the sweep deletes from here on refuses the commit (review of #434).
  const since = Date.now();
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
    throw new ToolError(
      'invalid_input',
      `the upload was rejected and deleted: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`,
      problems,
      true,
      undefined,
      {
        kind: 'image',
      },
    );
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
  // Each file read or stored since `since`: a tombstone from before goes (review of #434, 3).
  write({ row: undefined, writes: org.storage.stage.restored([...bySha.keys()], Date.now(), since) });
  const verified = write(org.assets.stage.update(asset, { status: 'verified' }));
  return { asset: assetView(verified, renditions), changed: true };
}

/**
 * Delete an asset (the `delete` tool, ./delete.ts): refused with a conflict while a spot uses it or a brand kit has it as
 * its logo. Screens playing it keep their copy until their next publish; its stored files go to the storage sweep.
 */
export async function deleteAsset({ org, blobs, write }: Pick<ToolContext<unknown>, 'org' | 'blobs' | 'write'>, assetId: string) {
  const asset = await requireAsset(org, assetId);
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
  // Whatever its status: a pending or rejected upload may name bytes an earlier one stored, which the sweep then deletes
  // only if nothing else names them (review of #429, round 2, 5).
  write(org.storage.stage.queue(files, Date.now()));
}

/** `deleteAsset`'s batch refused as it ran: a spot or a brand kit took the asset up meanwhile. */
export async function assetTakenUp(org: OrgScope, assetId: string) {
  const spotIds = (await org.assets.usage([assetId])).get(assetId) ?? [];
  const kits = (await org.brandKits.list()).filter((k) => k.logoOnDarkAssetId === assetId || k.logoOnLightAssetId === assetId);
  return spotIds.length || kits.length
    ? new ToolError('conflict', `asset ${assetId} was taken into use while it was being deleted`, { spotIds, brandKitIds: kits.map((k) => k.id) })
    : undefined;
}

export const assetTools = [listAssets, getAsset];
