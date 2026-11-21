// @vitest-environment happy-dom
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { qrSvg } from './qr';

/**
 * What a phone camera would see: the tile painted at `scale` pixels per module, light where nothing
 * is drawn, dark wherever a subpath of the path covers. Read from the SVG's own path, so a mistake in
 * how modules become drawing shows up here as a code that does not scan.
 */
function photograph(svg: SVGSVGElement, scale = 4): { width: number; dark: (x: number, y: number) => boolean; pixels: Uint8ClampedArray } {
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  if (w !== h || !w) throw new Error(`not a square tile: ${svg.getAttribute('viewBox')}`);
  const grid = Array.from({ length: w }, () => new Array<boolean>(w).fill(false));
  const d = svg.querySelector('path')?.getAttribute('d') ?? '';
  // Each subpath is an axis-aligned rectangle of whole modules: move, then relative lines.
  for (const sub of d.match(/M[^M]+/g) ?? []) {
    const [, x, y, rest] = /^M(\d+) (\d+)(.*)$/.exec(sub.trim()) ?? [];
    let cx = Number(x),
      cy = Number(y);
    const xs = [cx],
      ys = [cy];
    for (const [, axis, n] of (rest ?? '').matchAll(/([hv])(-?\d+)/g)) {
      if (axis === 'h') cx += Number(n);
      else cy += Number(n);
      xs.push(cx);
      ys.push(cy);
    }
    for (let gy = Math.min(...ys); gy < Math.max(...ys); gy++) for (let gx = Math.min(...xs); gx < Math.max(...xs); gx++) grid[gy]![gx] = true;
  }
  const width = w * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let py = 0; py < width; py++)
    for (let px = 0; px < width; px++) {
      const v = grid[Math.floor(py / scale)]![Math.floor(px / scale)] ? 0 : 255;
      pixels.set([v, v, v, 255], (py * width + px) * 4);
    }
  return { width, dark: (x, y) => grid[y]![x]!, pixels };
}

describe('qrSvg', () => {
  const urls = [
    'https://example.com/',
    'https://intranet.example.com/floor-plans/pier-9?floor=3&wing=north#lobby',
    `https://example.com/${'a'.repeat(280)}`,
  ];

  for (const url of urls) {
    it(`draws a code a reader decodes back to the address (${url.length} characters)`, () => {
      const { width, pixels } = photograph(qrSvg(url, 'Floor plan'));
      expect(jsQR(pixels, width, width)?.data).toBe(url);
    });
  }

  it('leaves a quiet zone of four light modules on every side', () => {
    const svg = qrSvg('https://example.com/', 'Floor plan');
    const { width, dark } = photograph(svg, 1);
    const edge = [0, 1, 2, 3, width - 4, width - 3, width - 2, width - 1];
    for (const i of edge)
      for (let j = 0; j < width; j++) {
        expect(dark(i, j)).toBe(false);
        expect(dark(j, i)).toBe(false);
      }
    // The finder pattern starts right after the zone.
    expect(dark(4, 4)).toBe(true);
  });

  it('is dark on white whatever the page around it, scaled crisply, and named for a screen reader', () => {
    const svg = qrSvg('https://example.com/', 'Floor plan');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#000000');
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Floor plan');
  });
});
