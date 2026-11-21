// makeRenditions in a real Chromium (Playwright's, or the one at SF_CHROMIUM): createImageBitmap
// applies the EXIF orientation, OffscreenCanvas scales by the cover rule, and the bytes it makes
// are checked here in Node with sharp. The upload through the tools: packages/tools/test/e2e.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readImageInfo } from '../src/image-info';
import { imageSample } from '../src/sample';
import { pixel, png, QUADRANTS, rotatedPhoto } from './fixtures';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true,
    write: false,
    logLevel: 'silent',
    format: 'iife',
    globalName: 'SFMedia',
    platform: 'browser',
    target: 'chrome120',
  });
  browser = await chromium.launch({ executablePath: process.env.SF_CHROMIUM || undefined });
  page = await browser.newPage();
  // A secure context, as the CMS is: Web Crypto's digest exists only there.
  await page.route('http://localhost/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' }));
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: out.outputFiles![0]!.text });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

interface Made {
  orientation: string;
  type: string;
  width: number | null;
  height: number | null;
  size: number;
  sha256: string;
  original: boolean;
  b64: string;
  sample: { size: number; sha256: string; b64: string } | null;
}

/** Run makeRenditions on these bytes in the page; returns each rendition with its bytes. */
async function renditions(bytes: Buffer, name: string, type: string): Promise<{ source: Record<string, unknown>; landscape: Made; portrait: Made }> {
  return page.evaluate(
    async ({ b64, name, type }) => {
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type });
      const r = await (globalThis as any).SFMedia.makeRenditions(file);
      const base64 = async (blob: Blob) => {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const out = async (x: any) => ({
        orientation: x.orientation,
        type: x.type,
        width: x.width,
        height: x.height,
        size: x.size,
        sha256: x.sha256,
        original: x.original,
        b64: await base64(x.blob),
        sample: x.sample ? { size: x.sample.size, sha256: x.sample.sha256, b64: await base64(x.sample.blob) } : null,
      });
      return { source: r.source, landscape: await out(r.landscape), portrait: await out(r.portrait) };
    },
    { b64: bytes.toString('base64'), name, type },
  );
}

const bytesOf = (m: Made) => Buffer.from(m.b64, 'base64');
const near = (got: number[], want: readonly number[]) => got.every((v, i) => Math.abs(v - want[i]!) < 40);
async function upright(image: Buffer, w: number, h: number) {
  return [
    near(await pixel(image, 20, 20), QUADRANTS.topLeft),
    near(await pixel(image, w - 20, 20), QUADRANTS.topRight),
    near(await pixel(image, 20, h - 20), QUADRANTS.bottomLeft),
    near(await pixel(image, w - 20, h - 20), QUADRANTS.bottomRight),
  ];
}

describe('makeRenditions', () => {
  it('turns a 4K phone photo by its EXIF orientation and scales it to cover each screen box', async () => {
    const r = await renditions(await rotatedPhoto(), 'IMG_0042.jpg', 'image/jpeg');
    expect(r.source).toMatchObject({ type: 'image/jpeg', width: 3840, height: 2160 });
    for (const [m, w, h] of [
      [r.landscape, 1920, 1080],
      [r.portrait, 3413, 1920],
    ] as const) {
      expect(m).toMatchObject({ type: 'image/jpeg', width: w, height: h, original: false });
      const bytes = bytesOf(m);
      expect(m.size).toBe(bytes.length);
      expect(m.sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
      // No EXIF left: the pixels themselves are upright.
      expect(readImageInfo(new Uint8Array(bytes))).toEqual({ type: 'image/jpeg', width: w, height: h, orientation: 1 });
      expect(await upright(bytes, w, h)).toEqual([true, true, true, true]);
    }
  }, 30_000);

  it("samples each rendition as decoded from its own bytes: each 16 px cell's darkest and lightest pixel, as a PNG", async () => {
    const sharp = (await import('sharp')).default;
    const r = await renditions(await rotatedPhoto(), 'IMG_0042.jpg', 'image/jpeg');
    for (const m of [r.landscape, r.portrait]) {
      const png = Buffer.from(m.sample!.b64, 'base64');
      expect(m.sample!.size).toBe(png.length);
      expect(m.sample!.sha256).toBe((await import('node:crypto')).createHash('sha256').update(png).digest('hex'));
      const got = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      // The JPEG decoded again here, with sharp.
      const decoded = await sharp(bytesOf(m)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const want = imageSample(decoded.data, decoded.info.width, decoded.info.height)!;
      expect([got.info.width, got.info.height]).toEqual([want.width, want.height]);
      // libvips and Chromium decode a JPEG a level apart on some pixels.
      expect(want.data.reduce((most, v, i) => Math.max(most, Math.abs(v - got.data[i]!)), 0)).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  it('encodes a large PNG as WebP, keeping transparency', async () => {
    const r = await renditions(await png(2400, 1600, true), 'logo.png', 'image/png');
    expect(r.landscape).toMatchObject({ type: 'image/webp', width: 1920, height: 1280, original: false });
    // Covering 1080x1920 would mean enlarging it, which the rule never does: the original ships.
    expect(r.portrait).toMatchObject({ type: 'image/png', width: 2400, height: 1600, original: true });
    const meta = await (await import('sharp')).default(bytesOf(r.landscape)).metadata();
    expect(meta).toMatchObject({ format: 'webp', hasAlpha: true, width: 1920, height: 1280 });
    // What shows through a transparent pixel is known only where it plays: no sample.
    expect([r.landscape.sample, r.portrait.sample]).toEqual([null, null]);
  }, 30_000);

  it('ships a small upright image and an SVG unchanged', async () => {
    const small = await png(800, 600);
    const r = await renditions(small, 'small.png', 'image/png');
    for (const m of [r.landscape, r.portrait]) {
      expect(m).toMatchObject({ type: 'image/png', width: 800, height: 600, original: true, sample: { sha256: r.landscape.sample!.sha256 } });
      expect(bytesOf(m).equals(small)).toBe(true);
    }
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
    const s = await renditions(svg, 'logo.svg', 'image/svg+xml');
    expect(s.landscape).toMatchObject({ type: 'image/svg+xml', width: null, height: null, original: true, sample: null });
    expect(s.portrait.sha256).toBe(s.landscape.sha256);
    expect(bytesOf(s.portrait).equals(svg)).toBe(true);
  }, 30_000);

  it('refuses a file that is not an image', async () => {
    const message = await page.evaluate(async () => {
      try {
        await (globalThis as any).SFMedia.makeRenditions(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
        return null;
      } catch (err: any) {
        return `${err.name}: ${err.message}`;
      }
    });
    expect(message).toBe('MediaError: the file is not an image this browser can read');
  }, 30_000);
});
