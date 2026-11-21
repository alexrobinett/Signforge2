// qrSvg drawn by Chromium, as a screen draws it, and read back as a phone's reader would (#191).
// The code runs in the page; Chromium rasterises the SVG it builds onto a canvas, and jsQR decodes
// those pixels. A drawing Chromium cannot paint decodes to nothing.
import { MAX_URL_BYTES } from '@signforge/contract';
import { build } from 'esbuild';
import jsQR from 'jsqr';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

declare const sfQr: typeof import('./qr');

let browser: Browser;
let page: Page;
// Launching Chromium and bundling take longer on a busy runner than the default hook timeout.
beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL('./qr.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'sfQr',
    logLevel: 'silent',
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
}, 120_000);
afterAll(() => browser?.close());

interface Photo {
  /** Pixels per side. */
  width: number;
  /** Modules per side, quiet zone included. */
  modules: number;
  rgba: Uint8ClampedArray;
  fills: { tile: string | null; modules: string | null };
  attrs: { shapeRendering: string | null; role: string | null; label: string | null };
}

/** `qrSvg(text)` as Chromium paints it, `scale` pixels a module, over a mid-grey canvas so white must come from the tile. */
async function photograph(text: string, scale = 4): Promise<Photo> {
  const shot = await page.evaluate(
    async ([text, scale]) => {
      const svg = sfQr.qrSvg(text, 'Floor plan');
      const modules = svg.viewBox.baseVal.width;
      const width = modules * scale;
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(width));
      const img = new Image();
      img.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = width;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, width, width);
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, width, width).data;
      let bytes = '';
      for (let i = 0; i < data.length; i += 0x8000) bytes += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return {
        width,
        modules,
        rgba: btoa(bytes),
        fills: { tile: svg.querySelector('rect')?.getAttribute('fill') ?? null, modules: svg.querySelector('path')?.getAttribute('fill') ?? null },
        attrs: { shapeRendering: svg.getAttribute('shape-rendering'), role: svg.getAttribute('role'), label: svg.getAttribute('aria-label') },
      };
    },
    [text, scale] as const,
  );
  return { ...shot, rgba: Uint8ClampedArray.from(atob(shot.rgba), (c) => c.charCodeAt(0)) };
}

/** The bytes a reader decodes from the photo, or undefined when it finds no code. */
function read(p: Photo): Uint8Array | undefined {
  const code = jsQR(p.rgba, p.width, p.width);
  return code ? Uint8Array.from(code.binaryData) : undefined;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const base = 'https://example.com/';

// Each case rasterises and decodes in Chromium: the browser tests' timeout, as template-check's.
describe('qrSvg in Chromium', { timeout: 30_000 }, () => {
  const addresses: [string, string][] = [
    ['a short address', 'https://example.com/'],
    ['a query and a fragment', 'https://intranet.example.com/floor-plans/pier-9?floor=3&wing=north#lobby'],
    ['non-ASCII text', 'https://例え.jp/café/plan'],
    [`the field's limit in ASCII (${MAX_URL_BYTES} bytes)`, base + 'a'.repeat(MAX_URL_BYTES - base.length)],
    [`the field's limit in three-byte characters (${MAX_URL_BYTES} bytes)`, base + '€'.repeat((MAX_URL_BYTES - base.length) / 3)],
  ];
  for (const [what, address] of addresses)
    it(`draws a code a reader decodes back to the address: ${what}`, async () => {
      expect(read(await photograph(address))).toEqual(utf8(address));
    });

  it('leaves a quiet zone of four white modules on every side', async () => {
    const scale = 4;
    const p = await photograph('https://example.com/', scale);
    const zone = 4 * scale;
    const white = (x: number, y: number) => {
      const i = (y * p.width + x) * 4;
      return p.rgba[i] === 255 && p.rgba[i + 1] === 255 && p.rgba[i + 2] === 255;
    };
    for (let y = 0; y < p.width; y++)
      for (let x = 0; x < p.width; x++) {
        const inZone = x < zone || y < zone || x >= p.width - zone || y >= p.width - zone;
        if (inZone) expect(white(x, y), `pixel ${x},${y}`).toBe(true);
      }
    // The finder pattern's corner module, right after the zone, is painted dark.
    const corner = (zone * p.width + zone) * 4;
    expect([p.rgba[corner], p.rgba[corner + 1], p.rgba[corner + 2]]).toEqual([0, 0, 0]);
  });

  it('is black on white whatever the page around it, crisp, and named for a screen reader', async () => {
    const p = await photograph('https://example.com/');
    expect(p.fills).toEqual({ tile: '#ffffff', modules: '#000000' });
    expect(p.attrs).toEqual({ shapeRendering: 'crispEdges', role: 'img', label: 'Floor plan' });
  });
});
