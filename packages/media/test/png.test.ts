import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/png';

describe('encodePng', () => {
  it('writes pixels a decoder reads back exactly, transparency included', async () => {
    const width = 3;
    const height = 2;
    const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37) % 256);
    const { data, info } = await sharp(Buffer.from(await encodePng(rgba, width, height)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([width, height, 4]);
    expect([...data]).toEqual([...rgba]);
  });
});
