// readImageInfo against real files encoded by sharp (libjpeg, libpng, libwebp).
import { describe, expect, it } from 'vitest';
import { readImageInfo } from '../src/image-info';
import { jpegWithOrientation, png, rotatedPhoto, webpAlpha, webpLossless, webpLossy } from './fixtures';

const info = (b: Buffer) => readImageInfo(new Uint8Array(b));

describe('readImageInfo', () => {
  // sharp encodes a 4K photo here: 0.3 s on a laptop, 2.9 to 3.7 s in CI beside the other packages'
  // tests, and once over the default 5 s. Ten times that, so a busy machine is never a failure.
  it('reads a JPEG, turning the size by its EXIF orientation', { timeout: 60_000 }, async () => {
    expect(info(await rotatedPhoto())).toEqual({ type: 'image/jpeg', width: 3840, height: 2160, orientation: 6 });
    for (const o of [1, 2, 3, 4]) expect(info(await jpegWithOrientation(64, 32, o))).toEqual({ type: 'image/jpeg', width: 64, height: 32, orientation: o });
    for (const o of [5, 6, 7, 8]) expect(info(await jpegWithOrientation(64, 32, o))).toEqual({ type: 'image/jpeg', width: 32, height: 64, orientation: o });
  });

  it('reads PNG and every kind of WebP', async () => {
    expect(info(await png(70, 30))).toEqual({ type: 'image/png', width: 70, height: 30, orientation: 1 });
    expect(info(await webpLossy(70, 30))).toEqual({ type: 'image/webp', width: 70, height: 30, orientation: 1 });
    expect(info(await webpLossless(71, 31))).toEqual({ type: 'image/webp', width: 71, height: 31, orientation: 1 });
    expect(info(await webpAlpha(72, 32))).toEqual({ type: 'image/webp', width: 72, height: 32, orientation: 1 });
  });

  it('recognises SVG and refuses anything else', () => {
    const svg = '﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(readImageInfo(new TextEncoder().encode(svg))).toEqual({ type: 'image/svg+xml', width: null, height: null, orientation: 1 });
    expect(readImageInfo(new TextEncoder().encode('<html><body>no</body></html>'))).toBeNull();
    expect(readImageInfo(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4]))).toBeNull();
    expect(readImageInfo(new Uint8Array([0x80, 0x81, 0xfe]))).toBeNull();
  });
});
