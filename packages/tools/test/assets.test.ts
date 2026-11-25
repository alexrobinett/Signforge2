// Asset tools: upload targets, the server's check of what landed in R2, usage and delete.
// The files here are image headers only: the server reads type and size from the header and never
// decodes. Real images through the browser and real presigned PUTs: packages/media/test/upload.test.ts.
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, orgBlobKey, r2Presigner, registry, uploadKey, type Caller } from '../src';
import { racing } from './calls';
import { memberOf } from './member';

let o: SeededOrg;
let owner: Caller;

const call = async <T = any>(name: string, input: unknown, as: Caller = owner): Promise<T> => {
  const r = await dispatch(registry, name, input, as);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const run = (name: string, input: unknown) => dispatch(registry, name, input, owner);

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', b));

/** A PNG header for a w x h image, padded to `size` bytes so files differ. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A JPEG header: an EXIF orientation, then a frame header of w x h as stored. */
function jpeg(w: number, h: number, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, 0, 2 + 6 + tiff.length, ...[...'Exif'].map((c) => c.charCodeAt(0)), 0, 0, ...tiff];
  const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');

async function claim(bytes: Uint8Array, type: string, width: number | null, height: number | null) {
  return { sha256: await sha256(bytes), type, size: bytes.length, width, height };
}

/** Start an upload and PUT each file as a client would (straight into the bucket), and the renditions' `samples`. */
async function upload(name: string, files: { landscape: [Uint8Array, unknown]; portrait: [Uint8Array, unknown] }, put = true, samples: Uint8Array[] = []) {
  const created = await call('create_asset_upload', { name, renditions: { landscape: files.landscape[1], portrait: files.portrait[1] } });
  if (put) {
    for (const bytes of [files.landscape[0], files.portrait[0], ...samples]) {
      const sha = await sha256(bytes);
      if (created.uploads.some((u: { sha256: string }) => u.sha256 === sha)) await env.BLOBS.put(uploadKey(o.orgId, created.asset.id, sha), bytes);
    }
  }
  return created;
}

beforeAll(async () => {
  o = await seedOrg(env.DB, 'assets-org');
  owner = memberOf(testScope(env.DB, o.orgId), 'owner', {
    uploads: r2Presigner({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'signforge-test',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      now: () => Date.UTC(2026, 10, 17, 12),
    }),
  });
});

describe('create_asset_upload', () => {
  it('creates a pending asset and a presigned PUT per distinct file', async () => {
    const l = png(1920, 1280, 1),
      p = png(2880, 1920, 2);
    const created = await upload(
      'Menu photo',
      { landscape: [l, await claim(l, 'image/png', 1920, 1280)], portrait: [p, await claim(p, 'image/png', 2880, 1920)] },
      false,
    );
    expect(created.asset).toMatchObject({ name: 'Menu photo', kind: 'image', status: 'pending', width: 1920, height: 1280 });
    expect(created.asset.renditions.map((r: { orientation: string }) => r.orientation)).toEqual(['landscape', 'portrait']);
    expect(created.uploads).toHaveLength(2);
    const url = new URL(created.uploads[0].url);
    expect(url.origin).toBe('https://acct.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/signforge-test/up/${o.orgId}/${created.asset.id}/${created.uploads[0].sha256}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(created.uploads[0]).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
  });

  it('refuses renditions bigger than the screen box needs, and inconsistent claims', async () => {
    const big = { sha256: '1'.repeat(64), type: 'image/jpeg', size: 1000, width: 3840, height: 2160 };
    const ok = { sha256: '2'.repeat(64), type: 'image/jpeg', size: 1000, width: 1080, height: 1920 };
    const r = await run('create_asset_upload', { name: 'x', renditions: { landscape: big, portrait: ok } });
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'renditions.landscape' }] });
    expect(await run('create_asset_upload', { name: 'x', renditions: { landscape: { ...ok, width: null }, portrait: ok } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
    expect(await run('create_asset_upload', { name: 'x', renditions: { landscape: { ...ok, type: 'image/gif' }, portrait: ok } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
    expect(await run('create_asset_upload', { name: 'x', renditions: { landscape: { ...ok, size: 30 * 1024 * 1024 }, portrait: ok } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it("refuses one file claimed at two sizes, a sample's included", async () => {
    const l = { sha256: '5'.repeat(64), type: 'image/jpeg', size: 1000, width: 1920, height: 1080 };
    const p = { sha256: '6'.repeat(64), type: 'image/jpeg', size: 1000, width: 1080, height: 1920 };
    const r = await run('create_asset_upload', {
      name: 'x',
      renditions: { landscape: { ...l, sample: { sha256: '7'.repeat(64), size: 300 } }, portrait: { ...p, sample: { sha256: '7'.repeat(64), size: 301 } } },
    });
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'renditions', message: 'the same file cannot have two types or sizes' }] });
  });

  it('refuses a sample of an SVG', async () => {
    const c = { ...(await claim(svg, 'image/svg+xml', null, null)), sample: { sha256: '4'.repeat(64), size: 100 } };
    expect(await run('create_asset_upload', { name: 'x', renditions: { landscape: c, portrait: c } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [
        { path: 'renditions.landscape', message: 'an SVG has no sample' },
        { path: 'renditions.portrait', message: 'an SVG has no sample' },
      ],
    });
  });

  it('refuses an image whose decoded size is over the pixel cap, though one side fits the box', async () => {
    const strip = { sha256: '3'.repeat(64), type: 'image/png', size: 1000, width: 65_535, height: 1080 };
    const ok = { sha256: '2'.repeat(64), type: 'image/jpeg', size: 1000, width: 1080, height: 1920 };
    const r = await run('create_asset_upload', { name: 'x', renditions: { landscape: strip, portrait: ok } });
    expect(r).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [{ path: 'renditions.landscape', message: '65535x1080 is 70.8 million pixels; a screen decodes at most 8.3 million (3840x2160)' }],
    });
  });
});

describe('finalize_asset', () => {
  it('verifies an upload, moves it to its content-addressed key and is idempotent', async () => {
    // A phone JPEG stored 1920x1080 with orientation 6 displays as 1080x1920.
    const l = jpeg(1920, 1080, 1),
      p = jpeg(1920, 1080, 6);
    const created = await upload('Phone photo', {
      landscape: [l, await claim(l, 'image/jpeg', 1920, 1080)],
      portrait: [p, await claim(p, 'image/jpeg', 1080, 1920)],
    });
    const { asset, changed } = await call('finalize_asset', { assetId: created.asset.id });
    expect(changed).toBe(true);
    expect(asset.status).toBe('verified');
    for (const bytes of [l, p]) {
      const sha = await sha256(bytes);
      const stored = await env.BLOBS.get(orgBlobKey(o.orgId, sha));
      expect(stored?.httpMetadata?.contentType).toBe('image/jpeg');
      expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
      expect(await env.BLOBS.head(uploadKey(o.orgId, asset.id, sha))).toBeNull();
    }
    expect(await call('finalize_asset', { assetId: asset.id })).toMatchObject({ changed: false, asset: { status: 'verified' } });

    // The same file again needs no upload: the server already holds it.
    const again = await call('create_asset_upload', {
      name: 'Again',
      renditions: { landscape: await claim(l, 'image/jpeg', 1920, 1080), portrait: await claim(p, 'image/jpeg', 1080, 1920) },
    });
    expect(again.uploads).toEqual([]);
    expect((await call('finalize_asset', { assetId: again.asset.id })).asset.status).toBe('verified');
  });

  it("verifies each rendition's sample, a PNG of its rendition's sample size, and stores it beside the renditions", async () => {
    const l = jpeg(1920, 1080, 1),
      p = jpeg(1080, 1920, 1),
      ls = png(120, 136),
      ps = png(68, 240);
    const created = await upload(
      'Sampled',
      {
        landscape: [l, { ...(await claim(l, 'image/jpeg', 1920, 1080)), sample: { sha256: await sha256(ls), size: ls.length } }],
        portrait: [p, { ...(await claim(p, 'image/jpeg', 1080, 1920)), sample: { sha256: await sha256(ps), size: ps.length } }],
      },
      true,
      [ls, ps],
    );
    // The landscape JPEG is an earlier test's, which the server holds already.
    expect(created.uploads.map((u: { sha256: string }) => u.sha256).sort()).toEqual([await sha256(p), await sha256(ls), await sha256(ps)].sort());
    expect(created.uploads.find((u: { sha256: string }) => u.sha256 === created.asset.renditions[0].sample.sha256)).toMatchObject({
      headers: { 'content-type': 'image/png' },
    });
    const { asset } = await call('finalize_asset', { assetId: created.asset.id });
    expect(asset.renditions.map((r: { sample: unknown }) => r.sample)).toEqual([
      { sha256: await sha256(ls), size: ls.length },
      { sha256: await sha256(ps), size: ps.length },
    ]);
    for (const bytes of [ls, ps]) {
      const stored = await env.BLOBS.get(orgBlobKey(o.orgId, await sha256(bytes)));
      expect(stored?.httpMetadata?.contentType).toBe('image/png');
      expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
    }

    // Deleting a pending asset deletes its samples' uploads too.
    const pending = await upload(
      'Sampled, abandoned',
      {
        landscape: [l, { ...(await claim(l, 'image/jpeg', 1920, 1080)), sample: { sha256: await sha256(png(120, 136, 1)), size: 34 } }],
        portrait: [p, await claim(p, 'image/jpeg', 1080, 1920)],
      },
      true,
      [png(120, 136, 1)],
    );
    expect((await env.BLOBS.list({ prefix: `up/${o.orgId}/${pending.asset.id}/` })).objects).toHaveLength(1);
    await call('delete_asset', { assetId: pending.asset.id });
    expect(await env.BLOBS.list({ prefix: `up/${o.orgId}/${pending.asset.id}/` })).toMatchObject({ objects: [] });
    // Never finalized, yet its hashes are queued for the storage sweep: an earlier upload may have stored the same bytes,
    // which it deletes only if nothing else names them (#235, review of #429, round 2, 5).
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM blob_deletes WHERE org_id = ? AND sha256 IN (?, ?)')
          .bind(o.orgId, await sha256(l), await sha256(p))
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("refuses a sample that is not a PNG of its rendition's sample size", async () => {
    const cases: [Uint8Array, RegExp][] = [
      [png(120, 137, 2), /landscape sample: the image is 120x137, not the claimed 120x136/],
      [jpeg(120, 136, 1), /landscape sample: the file is image\/jpeg, not the claimed image\/png/],
    ];
    for (const [bytes, message] of cases) {
      const l = jpeg(1920, 1080, 1),
        p = jpeg(1080, 1920, 1);
      const created = await upload(
        'Bad sample',
        {
          landscape: [l, { ...(await claim(l, 'image/jpeg', 1920, 1080)), sample: { sha256: await sha256(bytes), size: bytes.length } }],
          portrait: [p, await claim(p, 'image/jpeg', 1080, 1920)],
        },
        true,
        [bytes],
      );
      const r = await run('finalize_asset', { assetId: created.asset.id });
      expect(r, String(message)).toMatchObject({ ok: false, error: 'invalid_input' });
      expect((r as { message: string }).message).toMatch(message);
      expect((await call('get_asset', { assetId: created.asset.id })).asset.status).toBe('rejected');
    }
  });

  it('passes an SVG through for both orientations, uploaded once', async () => {
    const c = await claim(svg, 'image/svg+xml', null, null);
    const created = await upload('Logo', { landscape: [svg, c], portrait: [svg, c] });
    expect(created.uploads).toHaveLength(1);
    const { asset } = await call('finalize_asset', { assetId: created.asset.id });
    expect(asset).toMatchObject({ status: 'verified', type: 'image/svg+xml', width: null, height: null });
    expect(asset.renditions).toEqual([
      expect.objectContaining({ orientation: 'landscape', width: null }),
      expect.objectContaining({ orientation: 'portrait', width: null }),
    ]);
  });

  it('refuses bytes that do not match the claimed hash, deletes them and marks the asset rejected, audited', async () => {
    const l = png(1920, 1080, 3),
      p = png(1080, 1920, 4);
    const created = await upload(
      'Tampered',
      { landscape: [l, await claim(l, 'image/png', 1920, 1080)], portrait: [p, await claim(p, 'image/png', 1080, 1920)] },
      false,
    );
    const lsha = await sha256(l),
      psha = await sha256(p);
    await env.BLOBS.put(uploadKey(o.orgId, created.asset.id, lsha), png(1920, 1080, 99)); // other bytes
    await env.BLOBS.put(uploadKey(o.orgId, created.asset.id, psha), p);

    const r = await run('finalize_asset', { assetId: created.asset.id });
    expect(r).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [
        { path: 'landscape', message: expect.stringMatching(/SHA-256/) },
        { path: 'landscape', message: expect.stringMatching(/bytes/) },
      ],
    });
    // Both uploads are gone, and nothing reached the content-addressed keys.
    for (const sha of [lsha, psha]) {
      expect(await env.BLOBS.head(uploadKey(o.orgId, created.asset.id, sha))).toBeNull();
      expect(await env.BLOBS.head(orgBlobKey(o.orgId, sha))).toBeNull();
    }
    expect((await call('get_asset', { assetId: created.asset.id })).asset.status).toBe('rejected');
    expect(await run('finalize_asset', { assetId: created.asset.id })).toMatchObject({ ok: false, error: 'conflict' });
    const [entry] = await owner.org.auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ action: 'finalize_asset', targetKind: 'asset', targetId: created.asset.id });
    expect(JSON.parse(entry!.detailJson!)).toMatchObject({ refused: { error: 'invalid_input' } });
  });

  it('refuses a file whose type or pixel size is not what was claimed, or too big for the box', async () => {
    const cases: [Uint8Array, unknown, RegExp][] = [
      [jpeg(1920, 1080, 1), { type: 'image/png', width: 1920, height: 1080 }, /is image\/jpeg/],
      [png(1920, 1000), { type: 'image/png', width: 1920, height: 1080 }, /1920x1000, not the claimed 1920x1080/],
      // Claimed as it displays unrotated, but orientation 6 turns it.
      [jpeg(1920, 1080, 6), { type: 'image/jpeg', width: 1920, height: 1080 }, /1080x1920, not the claimed/],
      [new TextEncoder().encode('not an image at all'), { type: 'image/png', width: 1920, height: 1080 }, /not a JPEG, PNG, WebP or SVG/],
    ];
    for (const [bytes, claimed, message] of cases) {
      const p = png(1080, 1920, 5);
      const created = await upload('Bad', {
        landscape: [bytes, { ...(await claim(bytes, '', 0, 0)), ...(claimed as object) }],
        portrait: [p, await claim(p, 'image/png', 1080, 1920)],
      });
      const r = await run('finalize_asset', { assetId: created.asset.id });
      expect(r, String(message)).toMatchObject({ ok: false, error: 'invalid_input' });
      expect((r as { message: string }).message).toMatch(message);
    }
  });

  it('refuses without changing anything while a file is not uploaded', async () => {
    const l = png(1920, 1080, 6),
      p = png(1080, 1920, 7);
    const created = await upload(
      'Slow',
      { landscape: [l, await claim(l, 'image/png', 1920, 1080)], portrait: [p, await claim(p, 'image/png', 1080, 1920)] },
      false,
    );
    expect(await run('finalize_asset', { assetId: created.asset.id })).toMatchObject({
      ok: false,
      error: 'invalid_input',
      message: expect.stringMatching(/not uploaded yet/),
    });
    expect((await call('get_asset', { assetId: created.asset.id })).asset.status).toBe('pending');
  });

  it('refuses an asset missing a rendition, and leaves it unverified', async () => {
    // Written before M3-33, when an asset and its renditions were separate writes: the portrait row never landed.
    const l = png(1920, 1080, 8);
    const c = await claim(l, 'image/png', 1920, 1080);
    const org = testScope(env.DB, o.orgId);
    const asset = await org.assets.insert({
      kind: 'image',
      name: 'Half',
      sha256: c.sha256,
      type: c.type,
      size: c.size,
      width: 1920,
      height: 1080,
      status: 'pending',
    });
    await org.assets.renditions.insert({
      assetId: asset.id,
      orientation: 'landscape',
      sha256: c.sha256,
      type: c.type,
      size: c.size,
      width: 1920,
      height: 1080,
    });
    await env.BLOBS.put(uploadKey(o.orgId, asset.id, c.sha256), l);
    expect(await run('finalize_asset', { assetId: asset.id })).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringMatching(/no portrait rendition/),
    });
    expect((await call('get_asset', { assetId: asset.id })).asset.status).toBe('pending');
  });
});

describe('list, usage and delete', () => {
  it('lists with usage counts and search, and refuses to delete an asset in use', async () => {
    const org = testScope(env.DB, o.orgId);
    // The seeded image spot uses o.asset; a template spot uses it through its asset map too.
    const tpl = await org.spots.insert({
      name: 'Menu',
      kind: 'template',
      durationMs: 10_000,
      templateVersionId: o.templateVersion,
      dataJson: '{}',
      assetMapJson: JSON.stringify({ hero: o.asset }),
    });

    const { assets } = await call('list_assets', {});
    expect(assets.find((a: { id: string }) => a.id === o.asset)).toMatchObject({ usageCount: 2 });
    expect(assets.filter((a: { usageCount: number }) => a.usageCount === 0).length).toBe(assets.length - 1);
    expect((await call('list_assets', { query: 'LOGO.p' })).assets.map((a: { id: string }) => a.id)).toEqual([o.asset]);
    expect((await call('list_assets', { status: 'rejected' })).assets.every((a: { status: string }) => a.status === 'rejected')).toBe(true);
    expect((await call('get_asset', { assetId: o.asset })).spotIds).toEqual([o.imageSpot, tpl.id].sort());

    const refused = await run('delete_asset', { assetId: o.asset });
    expect(refused).toMatchObject({ ok: false, error: 'conflict', details: { spotIds: [o.imageSpot, tpl.id].sort() } });
    expect(await org.assets.get(o.asset)).toBeDefined();

    await org.spots.delete(tpl.id);
    await org.playlists.setItems(o.playlist, [o.templateSpot]);
    await org.spots.delete(o.imageSpot);
    // The seeded brand kit uses it as its logo, too.
    expect(await run('delete_asset', { assetId: o.asset })).toMatchObject({ ok: false, error: 'conflict', details: { brandKitIds: [o.brandKit] } });
    await org.brandKits.update(o.brandKit, { logoOnDarkAssetId: null });
    const files = (await org.assets.renditions.forAsset(o.asset)).flatMap((r) => [r.sha256, ...(r.sampleSha256 ? [r.sampleSha256] : [])]);
    // On a fixed clock: each file is queued at the moment of the deletion (review of #429, 10).
    const at = Date.UTC(2026, 4, 1, 9);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      expect(await call('delete_asset', { assetId: o.asset })).toEqual({ deleted: o.asset });
    } finally {
      vi.useRealTimers();
    }
    expect(await org.assets.get(o.asset)).toBeUndefined();
    expect(await org.assets.renditions.forAsset(o.asset)).toEqual([]);
    // Its stored files are queued, in the same batch, for the storage sweep (#235).
    const queued = await env.DB.prepare('SELECT sha256, queued_at AS at FROM blob_deletes WHERE org_id = ? AND sha256 IN (SELECT value FROM json_each(?))')
      .bind(o.orgId, JSON.stringify(files))
      .all<{ sha256: string; at: number }>();
    expect(queued.results.map((q) => q.sha256).toSorted()).toEqual([...new Set(files)].sort());
    expect(new Set(queued.results.map((q) => q.at))).toEqual(new Set([at]));
  });

  // Through an asset map: no foreign key holds the asset there, only the batch's guard (review of #429, 5).
  it('refuses, writing nothing, an asset a template spot takes up between the check and its batch', async () => {
    const org = testScope(env.DB, o.orgId);
    const asset = await org.assets.insert({ kind: 'video', name: 'Raced', sha256: '7'.repeat(64), type: 'video/mp4', size: 1, status: 'verified' });
    let spotId = '';
    const raced = racing(owner, async () => {
      spotId = (
        await org.spots.insert({
          name: 'Takes it',
          kind: 'template',
          durationMs: 10_000,
          templateVersionId: o.templateVersion,
          dataJson: '{}',
          assetMapJson: JSON.stringify({ hero: asset.id }),
        })
      ).id;
    });
    expect(await dispatch(registry, 'delete_asset', { assetId: asset.id }, raced)).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringContaining('taken into use'),
      details: { spotIds: [spotId] },
    });
    expect(await org.assets.get(asset.id)).toBeDefined();
  });

  it('deletes a pending asset and its uploads', async () => {
    const l = png(1920, 1080, 8),
      p = png(1080, 1920, 9);
    const created = await upload('Abandoned', {
      landscape: [l, await claim(l, 'image/png', 1920, 1080)],
      portrait: [p, await claim(p, 'image/png', 1080, 1920)],
    });
    await call('delete_asset', { assetId: created.asset.id });
    expect(await env.BLOBS.list({ prefix: `up/${o.orgId}/${created.asset.id}/` })).toMatchObject({ objects: [] });
  });
});

describe('the storage sweep and uploads (#235, review of #429, 6)', () => {
  // On a fixed clock (review of #429, round 2, 7).
  const AT = Date.UTC(2026, 4, 1, 9);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT);
  });
  afterEach(() => vi.useRealTimers());
  /** The sweep's claim on `sha`, as its claim batch writes it: held for an hour, or run out. */
  const claimFile = (sha: string, held: boolean) =>
    env.DB.prepare(
      `INSERT INTO blob_deletes (org_id, sha256, queued_at, claim_owner, claim_until) VALUES (?, ?, 0, 'sweep', ?)
       ON CONFLICT (org_id, sha256) DO UPDATE SET claim_owner = excluded.claim_owner, claim_until = excluded.claim_until`,
    )
      .bind(o.orgId, sha, held ? AT + 3_600_000 : 0)
      .run();
  const pair = (seed: number) => {
    const l = png(1920, 1080, seed),
      p = png(1080, 1920, seed + 1);
    return Promise.all([claim(l, 'image/png', 1920, 1080), claim(p, 'image/png', 1080, 1920)]).then(
      ([lc, pc]) => ({ landscape: [l, lc], portrait: [p, pc] }) as { landscape: [Uint8Array, { sha256: string }]; portrait: [Uint8Array, { sha256: string }] },
    );
  };

  it("queues a pending upload's file when it is deleted: an earlier one may have stored the bytes (round 2, 5)", async () => {
    const org = testScope(env.DB, o.orgId);
    const sha = 'd'.repeat(64);
    const pending = await org.assets.insert({ kind: 'video', name: 'Never finished', sha256: sha, type: 'video/mp4', size: 1 });
    expect(await call('delete_asset', { assetId: pending.id })).toEqual({ deleted: pending.id });
    const row = await env.DB.prepare('SELECT queued_at AS q FROM blob_deletes WHERE org_id = ? AND sha256 = ?').bind(o.orgId, sha).first<{ q: number }>();
    expect(row?.q).toBe(AT);
  });

  it('refuses to start an upload of bytes the sweep has claimed, and starts it once the claim has run out', async () => {
    const files = await pair(30);
    await claimFile(files.landscape[1].sha256, true);
    const input = { name: 'Claimed bytes', renditions: { landscape: files.landscape[1], portrait: files.portrait[1] } };
    expect(await run('create_asset_upload', input)).toMatchObject({ ok: false, error: 'conflict', message: expect.stringContaining('storage clean-up') });
    await claimFile(files.landscape[1].sha256, false);
    expect(await run('create_asset_upload', input)).toMatchObject({ ok: true });
  });

  it('refuses, writing nothing, an upload whose bytes the sweep claims between the check and its batch', async () => {
    const files = await pair(32);
    const raced = racing(owner, () => claimFile(files.portrait[1].sha256, true));
    const input = { name: 'Raced claim', renditions: { landscape: files.landscape[1], portrait: files.portrait[1] } };
    expect(await dispatch(registry, 'create_asset_upload', input, raced)).toMatchObject({ ok: false, error: 'conflict' });
    const made = await env.DB.prepare("SELECT count(*) AS n FROM assets WHERE org_id = ? AND name = 'Raced claim'").bind(o.orgId).first<{ n: number }>();
    expect(made?.n).toBe(0);
  });

  it('refuses to verify an upload whose bytes the sweep has claimed since it started', async () => {
    const files = await pair(34);
    const created = await upload('Claimed later', files);
    await claimFile(files.portrait[1].sha256, true);
    expect(await run('finalize_asset', { assetId: created.asset.id })).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringContaining('storage clean-up'),
    });
    expect((await testScope(env.DB, o.orgId).assets.get(created.asset.id))?.status).toBe('pending');
  });
});

describe('renew_asset_upload', () => {
  it('signs new URLs for the files of the same pending asset not yet PUT, and refuses once it is finished', async () => {
    const l = png(1920, 1080, 7),
      p = png(1080, 1920, 8);
    const created = await upload(
      'Renewed',
      { landscape: [l, await claim(l, 'image/png', 1920, 1080)], portrait: [p, await claim(p, 'image/png', 1080, 1920)] },
      false,
    );
    await env.BLOBS.put(uploadKey(o.orgId, created.asset.id, await sha256(l)), l);

    const renewed = await call('renew_asset_upload', { assetId: created.asset.id });
    expect(renewed.asset).toMatchObject({ id: created.asset.id, status: 'pending' });
    expect(renewed.uploads.map((u: { sha256: string }) => u.sha256)).toEqual([await sha256(p)]);
    expect(new URL(renewed.uploads[0].url).pathname).toBe(`/signforge-test/up/${o.orgId}/${created.asset.id}/${await sha256(p)}`);

    await env.BLOBS.put(uploadKey(o.orgId, created.asset.id, await sha256(p)), p);
    expect((await call('finalize_asset', { assetId: created.asset.id })).asset.status).toBe('verified');
    expect(await run('renew_asset_upload', { assetId: created.asset.id })).toMatchObject({ ok: false, error: 'conflict' });
  });
});
