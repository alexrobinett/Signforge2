import { describe, expect, it } from 'vitest';
import { assetFacts, type AssetView, librarySummary, matching, usageText } from '../src/lib/assets';

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: 'ast_1',
  name: 'raspberries-cup.jpg',
  kind: 'image',
  status: 'verified',
  sha256: 'a'.repeat(64),
  type: 'image/jpeg',
  size: 412_000,
  width: 1920,
  height: 1080,
  renditions: [],
  createdAt: 0,
  updatedAt: 0,
  usageCount: 0,
  ...over,
});

describe('assetFacts', () => {
  it('gives the pixel size, type and weight of what a landscape screen gets', () => {
    expect(assetFacts(asset())).toBe('1920×1080 · JPEG · 412 KB');
    expect(assetFacts(asset({ type: 'image/webp', size: 2_450_000 }))).toBe('1920×1080 · WebP · 2.5 MB');
  });

  it('has no pixel size for an SVG', () => {
    expect(assetFacts(asset({ type: 'image/svg+xml', width: null, height: null, size: 900 }))).toBe('SVG · 900 B');
  });
});

describe('usageText', () => {
  it('counts spots', () => {
    expect(usageText(0)).toBe('Not used');
    expect(usageText(1)).toBe('Used by 1 spot');
    expect(usageText(3)).toBe('Used by 3 spots');
  });
});

describe('librarySummary', () => {
  it('says how many there are and how many are in use', () => {
    expect(librarySummary([asset(), asset({ usageCount: 2 }), asset()])).toBe('3 images · 1 in use');
    expect(librarySummary([asset()])).toBe('1 image · none in use');
  });

  it('names uploads that did not pass', () => {
    expect(librarySummary([asset(), asset({ status: 'rejected' }), asset({ status: 'pending' })])).toBe('3 images · none in use · 2 not usable');
  });
});

describe('matching', () => {
  const all = [asset({ id: 'a', name: 'Raspberries cup.jpg' }), asset({ id: 'b', name: 'Lobby logo.svg' })];

  it('keeps names that contain the search, in any case', () => {
    expect(matching(all, 'RASP').map((a) => a.id)).toEqual(['a']);
    expect(matching(all, ' logo ').map((a) => a.id)).toEqual(['b']);
  });

  it('keeps everything for an empty search', () => {
    expect(matching(all, undefined)).toEqual(all);
    expect(matching(all, '  ')).toEqual(all);
  });
});
