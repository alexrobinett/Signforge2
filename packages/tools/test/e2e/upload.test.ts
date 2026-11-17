// The upload, end to end, in a real Chromium (Node test: vitest.e2e.config.ts): @signforge/media scales a 4K phone photo with an
// EXIF rotation, the tools hand out presigned PUTs, the browser PUTs to the local bucket's S3 API
// (Miniflare checks the signatures as R2 does), and finalize_asset checks what landed.
//
// The browser is Playwright's Chromium, or the one at SF_CHROMIUM.
import { build } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readImageInfo } from '@signforge/media/image-info';
import { pixel, QUADRANTS, rotatedPhoto } from '../../../media/test/fixtures';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const S3 = { bucket: 'media-e2e', accessKeyId: 'media-e2e', secretAccessKey: 'media-e2e-secret' };
const ORG = 'org-e2e';

let mf: Miniflare;
let origin: string;
let browser: Browser;
let page: Page;
let photo: Buffer;

async function bundle(entry: string, options: Parameters<typeof build>[0]) {
  const out = await build({ entryPoints: [entry], bundle: true, write: false, logLevel: 'silent', ...options });
  return out.outputFiles![0]!.text;
}

function migrations(): string[][] {
  const dir = here('../../../db/migrations/');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(dir + f, 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean));
}

beforeAll(async () => {
  photo = await rotatedPhoto();
  const script = await bundle(here('../harness-worker.ts'), {
    format: 'esm', platform: 'neutral', target: 'es2024', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['cloudflare:*', 'node:*'],
  });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    d1Databases: ['DB'],
    r2Buckets: { BLOBS: { id: S3.bucket, s3Credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey } } },
    bindings: { MIGRATIONS: JSON.stringify(migrations()), S3: JSON.stringify(S3) },
  }));
  origin = (await mf.ready).origin;
  expect((await fetch(`${origin}/setup`, { method: 'POST' })).status).toBe(200);

  browser = await chromium.launch({ executablePath: process.env.SF_CHROMIUM || undefined });
  page = await browser.newPage();
  await page.goto(`${origin}/`);
  await page.addScriptTag({ content: await bundle(here('../../../media/src/index.ts'), { format: 'iife', globalName: 'SFMedia', platform: 'browser', target: 'chrome120' }) });
  await page.evaluate(() => {
    (globalThis as any).callTool = async (name: string, input: unknown) => {
      const res = await fetch(`/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const r = await res.json();
      if (!r.ok) throw Object.assign(new Error(`${name}: ${r.error}: ${r.message}`), { result: r });
      return r.output;
    };
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await mf?.dispose();
});

const blobKey = (sha: string) => `o/${ORG}/b/${sha}`;
async function stored(sha: string): Promise<Buffer | null> {
  const obj = await (await mf.getR2Bucket('BLOBS')).get(blobKey(sha));
  return obj ? Buffer.from(await obj.arrayBuffer()) : null;
}

describe('a 4K phone photo with an EXIF rotation', () => {
  it('uploads through the library and the tools as renditions within the screen box, the right way up', async () => {
    const result = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'IMG_0042.jpg', { type: 'image/jpeg' });
      const { asset, renditions } = await (globalThis as any).SFMedia.uploadImage(file, { callTool: (globalThis as any).callTool });
      const one = (r: any) => ({ type: r.type, width: r.width, height: r.height, size: r.size, sha256: r.sha256, original: r.original });
      return { asset, source: renditions.source, landscape: one(renditions.landscape), portrait: one(renditions.portrait) };
    }, photo.toString('base64'));

    // The browser turned it as EXIF says before measuring: 3840x2160, not 2160x3840.
    expect(result.source).toMatchObject({ type: 'image/jpeg', width: 3840, height: 2160 });
    // Cover-scaled: 1920x1080 exactly; for portrait, 1920 high and wider than 1080.
    expect(result.landscape).toMatchObject({ type: 'image/jpeg', width: 1920, height: 1080, original: false });
    expect(result.portrait).toMatchObject({ type: 'image/jpeg', width: 3413, height: 1920, original: false });
    expect(result.asset).toMatchObject({ status: 'verified', width: 1920, height: 1080 });
    expect(result.asset.renditions).toEqual([
      { orientation: 'landscape', sha256: result.landscape.sha256, type: 'image/jpeg', size: result.landscape.size, width: 1920, height: 1080 },
      { orientation: 'portrait', sha256: result.portrait.sha256, type: 'image/jpeg', size: result.portrait.size, width: 3413, height: 1920 },
    ]);

    // What R2 holds: the pixels themselves are turned (no EXIF left to rely on), quadrants in place.
    for (const [r, w, h] of [[result.landscape, 1920, 1080], [result.portrait, 3413, 1920]] as const) {
      const bytes = await stored(r.sha256);
      expect(bytes, r.sha256).not.toBeNull();
      expect(readImageInfo(new Uint8Array(bytes!))).toEqual({ type: 'image/jpeg', width: w, height: h, orientation: 1 });
      const near = (got: number[], want: readonly number[]) => got.every((v, i) => Math.abs(v - want[i]!) < 40);
      expect(near(await pixel(bytes!, 20, 20), QUADRANTS.topLeft)).toBe(true);
      expect(near(await pixel(bytes!, w - 20, 20), QUADRANTS.topRight)).toBe(true);
      expect(near(await pixel(bytes!, 20, h - 20), QUADRANTS.bottomLeft)).toBe(true);
      expect(near(await pixel(bytes!, w - 20, h - 20), QUADRANTS.bottomRight)).toBe(true);
    }
    // Nothing is left in the upload area.
    expect((await (await mf.getR2Bucket('BLOBS')).list({ prefix: 'up/' })).objects).toEqual([]);
  }, 60_000);
});

describe('the presigned PUT and the server check', () => {
  /** Make renditions of a small image in the browser and start its upload; returns the claims and targets. */
  const start = (name: string) =>
    page.evaluate(async (name) => {
      const c = new OffscreenCanvas(1200, 800);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#0a7';
      ctx.fillRect(0, 0, 1200, 800);
      const file = new File([await c.convertToBlob({ type: 'image/png' })], `${name}.png`, { type: 'image/png' });
      const media = (globalThis as any).SFMedia;
      const r = await media.makeRenditions(file);
      const created = await (globalThis as any).callTool('create_asset_upload', media.assetUploadInput(name, r));
      return { created, landscape: { size: r.landscape.size, sha256: r.landscape.sha256, type: r.landscape.type } };
    }, name);

  it('refuses bytes that do not match the claimed hash, and removes them from R2', async () => {
    const { created, landscape } = await start('tampered');
    const target = created.uploads.find((u: { sha256: string }) => u.sha256 === landscape.sha256);
    const outcome = await page.evaluate(async ({ assetId, target, size }) => {
      // Same length and type, other bytes: the signature binds those, not the content.
      const status = (await fetch(target.url, { method: 'PUT', headers: target.headers, body: new Uint8Array(size).fill(7) })).status;
      try {
        await (globalThis as any).callTool('finalize_asset', { assetId });
        return { statuses: [status], refused: null };
      } catch (err: any) {
        return { statuses: [status], refused: err.result };
      }
    }, { assetId: created.asset.id, target, size: landscape.size });

    expect(outcome.statuses).toEqual([200]);
    expect(outcome.refused).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(outcome.refused.message).toMatch(/SHA-256/);
    const bucket = await mf.getR2Bucket('BLOBS');
    expect((await bucket.list({ prefix: `up/${ORG}/${created.asset.id}/` })).objects).toEqual([]);
    expect(await bucket.head(blobKey(landscape.sha256))).toBeNull();
    const got = await page.evaluate((assetId) => (globalThis as any).callTool('get_asset', { assetId }), created.asset.id);
    expect(got.asset.status).toBe('rejected');
  }, 30_000);

  it('signs the size and type: R2 refuses a PUT of another length or type, or to another key', async () => {
    const { created, landscape } = await start('resized');
    const target = created.uploads.find((u: { sha256: string }) => u.sha256 === landscape.sha256);
    const statuses = await page.evaluate(async ({ target, size }) => {
      const put = (url: string, body: BodyInit, headers = target.headers) => fetch(url, { method: 'PUT', headers, body }).then((r) => r.status);
      return {
        longer: await put(target.url, new Uint8Array(size + 1)),
        otherType: await put(target.url, new Uint8Array(size), { 'content-type': 'text/html' }),
        otherKey: await put(target.url.replace(/\/up\/[^?]+/, '/o/org-e2e/b/' + '0'.repeat(64)), new Uint8Array(size)),
      };
    }, { target, size: landscape.size });
    expect(statuses).toEqual({ longer: 403, otherType: 403, otherKey: 403 });
  }, 30_000);
});

describe('delete_asset', () => {
  it('refuses while a spot uses the asset', async () => {
    const outcome = await page.evaluate(async () => {
      const c = new OffscreenCanvas(640, 360);
      c.getContext('2d')!.fillRect(0, 0, 640, 360);
      const file = new File([await c.convertToBlob({ type: 'image/png' })], 'used.png', { type: 'image/png' });
      const call = (globalThis as any).callTool;
      const { asset } = await (globalThis as any).SFMedia.uploadImage(file, { callTool: call });
      const { spotId } = await (await fetch(`/use/${asset.id}`, { method: 'POST' })).json();
      const listed = (await call('list_assets', { query: 'used' })).assets.find((a: any) => a.id === asset.id);
      let refused = null;
      try {
        await call('delete_asset', { assetId: asset.id });
      } catch (err: any) {
        refused = err.result;
      }
      return { asset, spotId, usageCount: listed.usageCount, refused, after: (await call('get_asset', { assetId: asset.id })).asset.status };
    });
    // Small enough to ship as it is: the original PNG, unchanged.
    expect(outcome.asset).toMatchObject({ status: 'verified', type: 'image/png', width: 640, height: 360 });
    expect(outcome.usageCount).toBe(1);
    expect(outcome.refused).toMatchObject({ ok: false, error: 'conflict', details: { spotIds: [outcome.spotId] } });
    expect(outcome.after).toBe('verified');
  }, 30_000);
});
