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
import { pixel, QUADRANTS, rotatedPhoto } from '@signforge/media/testing';

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
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) =>
      readFileSync(dir + f, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

beforeAll(async () => {
  photo = await rotatedPhoto();
  const script = await bundle(here('../harness-worker.ts'), {
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2026-11-01',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port: 0,
      d1Databases: ['DB'],
      r2Buckets: { BLOBS: { id: S3.bucket, s3Credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey } } },
      bindings: { MIGRATIONS: JSON.stringify(migrations()), S3: JSON.stringify(S3) },
    }),
  );
  origin = (await mf.ready).origin;
  expect((await fetch(`${origin}/setup`, { method: 'POST' })).status).toBe(200);

  browser = await chromium.launch({ executablePath: process.env.SF_CHROMIUM || undefined });
  page = await browser.newPage();
  await page.goto(`${origin}/`);
  await page.addScriptTag({
    content: await bundle(here('../../../media/src/index.ts'), { format: 'iife', globalName: 'SFMedia', platform: 'browser', target: 'chrome120' }),
  });
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
      const one = (r: any) => ({
        type: r.type,
        width: r.width,
        height: r.height,
        size: r.size,
        sha256: r.sha256,
        original: r.original,
        sample: { sha256: r.sample.sha256, size: r.sample.size },
      });
      return { asset, source: renditions.source, landscape: one(renditions.landscape), portrait: one(renditions.portrait) };
    }, photo.toString('base64'));

    // The browser turned it as EXIF says before measuring: 3840x2160, not 2160x3840.
    expect(result.source).toMatchObject({ type: 'image/jpeg', width: 3840, height: 2160 });
    // Cover-scaled: 1920x1080 exactly; for portrait, 1920 high and wider than 1080.
    expect(result.landscape).toMatchObject({ type: 'image/jpeg', width: 1920, height: 1080, original: false });
    expect(result.portrait).toMatchObject({ type: 'image/jpeg', width: 3413, height: 1920, original: false });
    expect(result.asset).toMatchObject({ status: 'verified', width: 1920, height: 1080 });
    expect(result.asset.renditions).toEqual([
      {
        orientation: 'landscape',
        sha256: result.landscape.sha256,
        type: 'image/jpeg',
        size: result.landscape.size,
        width: 1920,
        height: 1080,
        sample: result.landscape.sample,
      },
      {
        orientation: 'portrait',
        sha256: result.portrait.sha256,
        type: 'image/jpeg',
        size: result.portrait.size,
        width: 3413,
        height: 1920,
        sample: result.portrait.sample,
      },
    ]);
    // Each rendition's sample went up and was checked with it: a PNG of its rendition's sample size.
    for (const [r, w, h] of [
      [result.landscape, 120, 136],
      [result.portrait, 214, 240],
    ] as const) {
      const bytes = await stored(r.sample.sha256);
      expect(readImageInfo(new Uint8Array(bytes!))).toMatchObject({ type: 'image/png', width: w, height: h });
    }

    // What R2 holds: the pixels themselves are turned (no EXIF left to rely on), quadrants in place.
    for (const [r, w, h] of [
      [result.landscape, 1920, 1080],
      [result.portrait, 3413, 1920],
    ] as const) {
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
    const outcome = await page.evaluate(
      async ({ assetId, target, size }) => {
        // Same length and type, other bytes: the signature binds those, not the content.
        const status = (await fetch(target.url, { method: 'PUT', headers: target.headers, body: new Uint8Array(size).fill(7) })).status;
        try {
          await (globalThis as any).callTool('finalize_asset', { assetId });
          return { statuses: [status], refused: null };
        } catch (err: any) {
          return { statuses: [status], refused: err.result };
        }
      },
      { assetId: created.asset.id, target, size: landscape.size },
    );

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
    const statuses = await page.evaluate(
      async ({ target, size }) => {
        const put = (url: string, body: BodyInit, headers = target.headers) => fetch(url, { method: 'PUT', headers, body }).then((r) => r.status);
        return {
          longer: await put(target.url, new Uint8Array(size + 1)),
          otherType: await put(target.url, new Uint8Array(size), { 'content-type': 'text/html' }),
          otherKey: await put(target.url.replace(/\/up\/[^?]+/, '/o/org-e2e/b/' + '0'.repeat(64)), new Uint8Array(size)),
        };
      },
      { target, size: landscape.size },
    );
    expect(statuses).toEqual({ longer: 403, otherType: 403, otherKey: 403 });
  }, 30_000);
});

describe('a video', () => {
  const clip = (name: string) => readFileSync(here(`../../../media-check/test/fixtures/${name}`)).toString('base64');

  it('is checked in the browser, uploaded in presigned parts to the S3 API, and checked again', async () => {
    const result = await page.evaluate(async (b64) => {
      const clip = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      // A top-level free box after the clip makes it 20 MiB longer, two parts; players skip it.
      const pad = new Uint8Array(20 * 1024 * 1024);
      new DataView(pad.buffer).setUint32(0, pad.length);
      pad.set([0x66, 0x72, 0x65, 0x65], 4);
      const file = new File([clip, pad], 'promo.mp4', { type: 'video/mp4' });
      const calls: string[] = [];
      const callTool = (name: string, input: unknown) => (calls.push(name), (globalThis as any).callTool(name, input));
      const { asset } = await (globalThis as any).SFMedia.uploadVideo(file, { callTool });
      return { asset, calls, size: file.size };
    }, clip('high.mp4'));
    expect(result.calls).toEqual(['create_video_upload', 'finalize_video_upload']);
    expect(result.asset).toMatchObject({ kind: 'video', status: 'verified', width: 320, height: 180, durationMs: 1000, size: result.size });
    const obj = await (await mf.getR2Bucket('BLOBS')).head(blobKey(result.asset.sha256));
    expect(obj?.size).toBe(result.size);
    expect((await (await mf.getR2Bucket('BLOBS')).list({ prefix: 'up/' })).objects).toEqual([]);
  }, 60_000);

  it('that screens cannot play is refused in the browser, with how to export one, before anything is uploaded', async () => {
    const refused = await page.evaluate(async (b64) => {
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'fast.mp4', { type: 'video/mp4' });
      const calls: string[] = [];
      try {
        await (globalThis as any).SFMedia.uploadVideo(file, { callTool: (name: string) => (calls.push(name), Promise.reject(new Error('no call expected'))) });
        return null;
      } catch (err: any) {
        return { name: err.name, problems: err.problems, message: err.message, calls };
      }
    }, clip('fps60.mp4'));
    expect(refused).toMatchObject({ name: 'VideoRejectedError', problems: [{ code: 'fps', message: '60 fps is above 30' }], calls: [] });
    expect(refused!.message).toMatch(/^60 fps is above 30\. Export it again as an MP4 with H\.264/);
  }, 30_000);

  it('that skips the browser check is rejected by the server and removed', async () => {
    const outcome = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const sha256 = await (globalThis as any).SFMedia.sha256Hex(bytes);
      const call = (globalThis as any).callTool;
      const { asset, upload } = await call('create_video_upload', { name: 'Sneaky', sha256, type: 'video/mp4', size: bytes.length });
      const part = upload.parts[0];
      const res = await fetch(part.url, { method: 'PUT', headers: part.headers, body: bytes });
      try {
        await call('finalize_video_upload', { assetId: asset.id, uploadId: upload.uploadId, parts: [{ partNumber: 1, etag: res.headers.get('etag') }] });
        return null;
      } catch (err: any) {
        return { status: res.status, refused: err.result, assetId: asset.id };
      }
    }, clip('fps60.mp4'));
    expect(outcome).toMatchObject({ status: 200, refused: { ok: false, error: 'invalid_input', details: [{ path: 'fps' }] } });
    expect((await (await mf.getR2Bucket('BLOBS')).list({ prefix: `up/${ORG}/${outcome!.assetId}/` })).objects).toEqual([]);
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

describe('an upload tried again', () => {
  it('makes one asset when the answer to its creation was lost', async () => {
    const outcome = await page.evaluate(async () => {
      const c = new OffscreenCanvas(640, 360);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#a40';
      ctx.fillRect(0, 0, 640, 360);
      const file = new File([await c.convertToBlob({ type: 'image/png' })], 'retried.png', { type: 'image/png' });
      const call = (globalThis as any).callTool;
      // The first creation commits, and its answer never arrives.
      let lost = false;
      const flaky = async (name: string, input: unknown) => {
        const out = await call(name, input);
        if (name === 'create_asset_upload' && !lost) {
          lost = true;
          throw new Error('the connection dropped');
        }
        return out;
      };
      const media = (globalThis as any).SFMedia;
      const options = { callTool: flaky, idempotencyKey: 'retried-upload-1' };
      const first = await media.uploadImage(file, options).then(
        () => 'uploaded',
        (err: Error) => err.message,
      );
      const { asset } = await media.uploadImage(file, options);
      const listed = (await call('list_assets', { query: 'retried' })).assets.map((a: any) => a.id);
      return { first, asset, listed };
    });
    expect(outcome.first).toBe('the connection dropped');
    expect(outcome.asset.status).toBe('verified');
    expect(outcome.listed).toEqual([outcome.asset.id]);
  }, 30_000);
});

describe('an upload whose URLs expired', () => {
  it('gets new ones for the same pending asset, and finishes it', async () => {
    const outcome = await page.evaluate(async () => {
      const c = new OffscreenCanvas(640, 360);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#05a';
      ctx.fillRect(0, 0, 640, 360);
      const file = new File([await c.convertToBlob({ type: 'image/png' })], 'late.png', { type: 'image/png' });
      const call = (globalThis as any).callTool;
      const calls: [string, unknown][] = [];
      // As a retry with the same key replays them after the tab slept: URLs past their expiry.
      const late = async (name: string, input: any) => {
        calls.push([name, input.assetId]);
        const out = await call(name, input);
        if (name === 'create_asset_upload') for (const u of out.uploads) u.expiresAt = Date.now() - 1000;
        return out;
      };
      const { asset } = await (globalThis as any).SFMedia.uploadImage(file, { callTool: late });
      const listed = (await call('list_assets', { query: 'late' })).assets.map((a: any) => a.id);
      return { asset, calls, listed };
    });
    expect(outcome.asset.status).toBe('verified');
    expect(outcome.calls).toEqual([
      ['create_asset_upload', undefined],
      ['renew_asset_upload', outcome.asset.id],
      ['finalize_asset', outcome.asset.id],
    ]);
    expect(outcome.listed).toEqual([outcome.asset.id]);
  }, 30_000);
});
