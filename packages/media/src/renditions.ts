/**
 * Scale an image into the two renditions a screen plays: one for landscape screens and one for
 * portrait. Browser only: it decodes with `createImageBitmap`, which applies the EXIF
 * orientation, and draws with `OffscreenCanvas`.
 *
 * The size follows the contract's `coverSize`, the rule `sf build` applies with sharp: the
 * smallest size that still covers the screen box, never larger than the original.
 *
 * - SVG ships as it is, for both orientations.
 * - A raster image that needs no scaling and no rotation ships as it is, if it is a JPEG, PNG or WebP.
 * - Anything else is drawn and encoded: a JPEG as JPEG, every other type (PNG, WebP, AVIF, GIF, ...)
 *   as WebP, which keeps transparency.
 *
 * Each raster rendition with no transparent pixel gets its sample (`imageSample`), made from the
 * rendition's own bytes decoded again, as a screen decodes them: an encoder's ringing is detail
 * the screen shows.
 */
import { coverSize, SCREEN_BOX } from '@signforge/contract';
import { readImageInfo, type RenditionType } from './image-info';
import { imageSample } from './sample';

export type Orientation = keyof typeof SCREEN_BOX;
export const ORIENTATIONS = ['landscape', 'portrait'] as const satisfies readonly Orientation[];

export interface Rendition {
  orientation: Orientation;
  blob: Blob;
  type: RenditionType;
  /** Null for SVG. */
  width: number | null;
  height: number | null;
  size: number;
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: string;
  /** True when the original bytes are shipped unchanged. */
  original: boolean;
  /** Its sample, a PNG; none for SVG or an image with any transparent pixel. */
  sample?: { blob: Blob; size: number; sha256: string };
}

export interface RenditionOptions {
  /** Encoder quality for JPEG and WebP, 0 to 1. Default 0.85, as `sf build` uses. */
  quality?: number;
  /** Refuse files larger than this before decoding. Default 50 MB. */
  maxSourceBytes?: number;
}

export interface Renditions {
  source: { type: string; width: number | null; height: number | null; size: number };
  landscape: Rendition;
  portrait: Rendition;
}

export class MediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaError';
  }
}

const SHIP_AS_IS = new Set<string>(['image/jpeg', 'image/png', 'image/webp']);

/** Lowercase hex SHA-256, with Web Crypto. */
export async function sha256Hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new MediaError('hashing needs a secure context (https or localhost)');
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Make the landscape and portrait renditions of an image file. */
export async function makeRenditions(file: Blob, options: RenditionOptions = {}): Promise<Renditions> {
  const quality = options.quality ?? 0.85;
  const maxSourceBytes = options.maxSourceBytes ?? 50 * 1024 * 1024;
  if (file.size > maxSourceBytes)
    throw new MediaError(`the file is ${(file.size / 1e6).toFixed(1)} MB; the most an image may be is ${(maxSourceBytes / 1e6).toFixed(0)} MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readImageInfo(bytes);

  if (info?.type === 'image/svg+xml') {
    const blob = new Blob([bytes], { type: info.type });
    const sha256 = await sha256Hex(bytes);
    const make = (orientation: Orientation): Rendition => ({
      orientation,
      blob,
      type: info.type,
      width: null,
      height: null,
      size: blob.size,
      sha256,
      original: true,
    });
    return { source: { type: info.type, width: null, height: null, size: file.size }, landscape: make('landscape'), portrait: make('portrait') };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new MediaError('the file is not an image this browser can read', { cause: e });
  }
  try {
    const sourceType = info?.type ?? file.type ?? '';
    const outType = sourceType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const make = async (orientation: Orientation): Promise<Rendition> => {
      const size = coverSize(bitmap.width, bitmap.height, SCREEN_BOX[orientation]);
      if (!size.scaled && info && info.orientation === 1 && SHIP_AS_IS.has(info.type)) {
        const blob = new Blob([bytes], { type: info.type });
        const shipped = {
          orientation,
          blob,
          type: info.type,
          width: info.width,
          height: info.height,
          size: blob.size,
          sha256: await sha256Hex(bytes),
          original: true,
        };
        return withSample(shipped);
      }
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new MediaError('this browser cannot draw images off screen');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await canvas.convertToBlob({ type: outType, quality });
      // A browser that cannot encode WebP falls back to PNG; the blob's own type says which it made.
      const type = blob.type as RenditionType;
      if (!SHIP_AS_IS.has(type)) throw new MediaError(`this browser encoded ${type || 'an unknown type'}`);
      return withSample({ orientation, blob, type, width: size.width, height: size.height, size: blob.size, sha256: await sha256Hex(blob), original: false });
    };
    const [landscape, portrait] = await Promise.all([make('landscape'), make('portrait')]);
    return { source: { type: sourceType, width: bitmap.width, height: bitmap.height, size: file.size }, landscape, portrait };
  } finally {
    bitmap.close();
  }
}

/**
 * A photo for a model to read (the agent's fill, #263): upright, its longer edge at most `edge`
 * pixels, as a base64 JPEG on white. The API passes it on without decoding it, so it is made small
 * here, where the CPU is the person's.
 */
export async function scaledPhoto(file: Blob, edge: number, quality = 0.85): Promise<{ mediaType: 'image/jpeg'; data: string }> {
  const info = readImageInfo(new Uint8Array(await file.arrayBuffer()));
  if (!info || info.type === 'image/svg+xml') throw new MediaError('the file is not a JPEG, PNG or WebP photo');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new MediaError('the file is not an image this browser can read', { cause: e });
  }
  try {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new MediaError('this browser cannot draw images off screen');
    // JPEG has no transparency: a flyer's transparent parts read as paper, not black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mediaType: 'image/jpeg', data: btoa(text) };
  } finally {
    bitmap.close();
  }
}

/** The rendition with its sample, when it has no transparent pixel. */
async function withSample(r: Rendition): Promise<Rendition> {
  const bitmap = await createImageBitmap(r.blob, { imageOrientation: 'from-image' });
  try {
    const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
    if (!g) throw new MediaError('this browser cannot draw images off screen');
    g.drawImage(bitmap, 0, 0);
    const sample = imageSample(g.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
    if (!sample) return r;
    const canvas = new OffscreenCanvas(sample.width, sample.height);
    canvas.getContext('2d')!.putImageData(new ImageData(sample.data, sample.width, sample.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { ...r, sample: { blob, size: blob.size, sha256: await sha256Hex(blob) } };
  } finally {
    bitmap.close();
  }
}
