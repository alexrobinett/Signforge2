/**
 * Test images made with sharp. The photo is 3840x2160 as displayed, with a colour in each
 * quadrant, stored rotated as a phone stores a portrait-held shot: 2160x3840 pixels with EXIF
 * orientation 6 ("turn 90° clockwise to display").
 */
import sharp from 'sharp';

export const QUADRANTS = { topLeft: [255, 0, 0], topRight: [0, 255, 0], bottomLeft: [0, 0, 255], bottomRight: [255, 255, 0] } as const;

/** A w x h raw RGB image with the four quadrant colours. */
async function quadrants(w: number, h: number) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y < h / 2 ? (x < w / 2 ? QUADRANTS.topLeft : QUADRANTS.topRight) : x < w / 2 ? QUADRANTS.bottomLeft : QUADRANTS.bottomRight;
      px.set(c, (y * w + x) * 3);
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
}

/** The 4K photo with EXIF orientation 6. */
export async function rotatedPhoto(): Promise<Buffer> {
  const displayed = await (await quadrants(3840, 2160)).png().toBuffer();
  // Stored = displayed turned 90° anticlockwise; orientation 6 turns it back.
  const stored = await sharp(displayed).rotate(-90).toBuffer();
  return sharp(stored).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
}

export async function png(w: number, h: number, alpha = false) {
  const img = await quadrants(w, h);
  return (alpha ? img.ensureAlpha(0.5) : img).png().toBuffer();
}
export const webpLossy = async (w: number, h: number) => (await quadrants(w, h)).webp({ quality: 80 }).toBuffer();
export const webpLossless = async (w: number, h: number) => (await quadrants(w, h)).webp({ lossless: true }).toBuffer();
export const webpAlpha = async (w: number, h: number) => (await quadrants(w, h)).ensureAlpha(0.5).webp({ quality: 80 }).toBuffer();
export const jpegWithOrientation = async (w: number, h: number, orientation: number) => (await quadrants(w, h)).withMetadata({ orientation }).jpeg().toBuffer();

/** The colour at (x, y) of an encoded image, as stored: no EXIF rotation applied. */
export async function pixel(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 3;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}
