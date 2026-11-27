/**
 * Read an image's type and size from its first bytes, without decoding it. Pure byte parsing, so
 * it runs the same in a browser and in a Worker: the browser uses it to decide whether a file can
 * ship as it is, the server (`finalize_upload`) to check what was uploaded.
 *
 * Sizes are as displayed: a JPEG whose EXIF orientation turns it a quarter (orientations 5 to 8)
 * reports its width and height swapped, as a browser draws it.
 */

/** The image types an asset rendition may be. */
export const RENDITION_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'] as const;
export type RenditionType = (typeof RENDITION_TYPES)[number];

export interface RasterInfo {
  type: Exclude<RenditionType, 'image/svg+xml'>;
  /** As displayed, after the EXIF orientation. */
  width: number;
  height: number;
  /** EXIF orientation, 1 to 8; 1 when there is none. */
  orientation: number;
}
export interface SvgInfo {
  type: 'image/svg+xml';
  width: null;
  height: null;
  orientation: 1;
}
export type ImageInfo = RasterInfo | SvgInfo;

const u16be = (b: Uint8Array, i: number) => ((b[i]! << 8) | b[i + 1]!) >>> 0;
const u16le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8)) >>> 0;
const u24le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) >>> 0;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** The orientation tag (0x0112) in a TIFF structure, as EXIF holds it. 1 if absent or unreadable. */
function tiffOrientation(b: Uint8Array, start: number, end: number): number {
  if (end - start < 8) return 1;
  const order = ascii(b, start, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const le = order === 'II';
  const r16 = (i: number) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i: number) => (le ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i));
  const ifd = start + r32(start + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

const swaps = (orientation: number) => orientation >= 5;

function jpeg(b: Uint8Array): RasterInfo | null {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1]!;
    // Fill bytes before a marker.
    while (marker === 0xff && i + 2 < b.length) marker = b[++i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data before any frame header
    const len = u16be(b, i + 2);
    const seg = i + 4;
    if (marker === 0xe1 && ascii(b, seg, 6) === 'Exif\0\0') orientation = tiffOrientation(b, seg + 6, Math.min(b.length, i + 2 + len));
    // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (seg + 5 > b.length) return null;
      const h = u16be(b, seg + 1);
      const w = u16be(b, seg + 3);
      if (!w || !h) return null;
      return swaps(orientation) ? { type: 'image/jpeg', width: h, height: w, orientation } : { type: 'image/jpeg', width: w, height: h, orientation };
    }
    i += 2 + len;
  }
  return null;
}

function png(b: Uint8Array): RasterInfo | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width && height ? { type: 'image/png', width, height, orientation: 1 } : null;
}

function webp(b: Uint8Array): RasterInfo | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  let width = 0;
  let height = 0;
  let orientation = 1;
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    width = u16le(b, 26) & 0x3fff;
    height = u16le(b, 28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    width = u24le(b, 24) + 1;
    height = u24le(b, 27) + 1;
    if (b[20]! & 0x08) {
      // An EXIF chunk follows somewhere in the file; find it.
      let i = 12;
      while (i + 8 <= b.length) {
        const size = (u16le(b, i + 4) | (u16le(b, i + 6) << 16)) >>> 0;
        if (ascii(b, i, 4) === 'EXIF') {
          const start = ascii(b, i + 8, 6) === 'Exif\0\0' ? i + 14 : i + 8;
          orientation = tiffOrientation(b, start, Math.min(b.length, i + 8 + size));
          break;
        }
        i += 8 + size + (size & 1);
      }
    }
  } else return null;
  if (!width || !height) return null;
  return swaps(orientation) ? { type: 'image/webp', width: height, height: width, orientation } : { type: 'image/webp', width, height, orientation };
}

function svg(b: Uint8Array): SvgInfo | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b.subarray(0, 4096));
  } catch {
    // A multi-byte character cut at 4096 bytes is fine; anything else is not text.
    if (b.length <= 4096) return null;
    text = new TextDecoder('utf-8').decode(b.subarray(0, 4096));
  }
  const head = text.replace(/^﻿/, '').trimStart();
  if (!head.startsWith('<')) return null;
  return /<svg[\s>]/i.test(head) ? { type: 'image/svg+xml', width: null, height: null, orientation: 1 } : null;
}

/** The type and displayed size of a JPEG, PNG, WebP or SVG, read from its bytes. Null for anything else or a damaged header. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (bytes.length >= 8 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) return png(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webp(bytes);
  return svg(bytes);
}
