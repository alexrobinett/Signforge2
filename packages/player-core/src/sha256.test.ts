import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from './sha256';

const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('Sha256', () => {
  it('matches the published test vectors', () => {
    expect(new Sha256().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('gives the same digest however the input is split into chunks', () => {
    const data = randomBytes(300_007);
    for (const size of [1, 63, 64, 65, 4096, 100_000]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += size) h.update(data.subarray(i, i + size));
      expect(h.hex()).toBe(node(data));
    }
  });
});
