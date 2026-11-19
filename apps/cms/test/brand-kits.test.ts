import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@signforge/compiler';
import type { AssetView } from '../src/lib/assets';
import { type BrandKitView, draftColors, duplicateInput, kitDraftOf, kitPairs, pairFix, updateInput, withDraftKit } from '../src/lib/brand-kits';

/** Northside's dark kit from the design boards, with the accent's text set by hand to white. */
const northside = {
  primary: '#1f3fbf',
  onPrimary: '#ffffff',
  accent: '#f5c518',
  onAccent: '#ffffff',
  background: '#0f1115',
  surface: '#1f2430',
  text: '#ffffff',
  muted: '#a3acbd',
};

describe('kitPairs', () => {
  it('gives every pair a template draws text with, its ratio (rounded down, so a pair just under 4.5 never reads 4.5) and a verdict in words', () => {
    expect(kitPairs(northside).map((p) => [p.label, p.ratio, p.verdict])).toEqual([
      ['On primary on primary', '8.3:1', 'Pass'],
      ['On accent on accent', '1.6:1', 'Fail'],
      ['Text on background', '18.8:1', 'Pass'],
      ['Text on surface', '15.5:1', 'Pass'],
      ['Muted on background', '8.2:1', 'Pass'],
    ]);
  });

  it('says a pair between 3:1 and 4.5:1 is for large text only', () => {
    const pair = kitPairs({ ...northside, muted: '#6b7280' }).find((p) => p.fg === 'muted');
    expect([pair?.ratio, pair?.verdict]).toEqual(['3.9:1', 'Large text only']);
  });
});

describe('pairFix', () => {
  it('gives an on-colour the derived black or white, as the tools derive it', () => {
    expect(pairFix(northside, 'onAccent', 'accent')).toEqual({ hex: '#000000', ratio: '12.8:1' });
  });

  it('moves text only as far toward black or white as 4.5:1 needs, so it keeps its colour', () => {
    const fix = pairFix({ ...northside, muted: '#6b7280' }, 'muted', 'background');
    expect(fix.hex).not.toBe('#ffffff');
    expect(contrastRatio(fix.hex, northside.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fix.hex, northside.background)).toBeLessThan(5);
  });
});

/** A kit as `list_brand_kits` gives it: its accent's text derived, its primary's set by hand. */
const view: BrandKitView = {
  id: 'bk_1',
  name: 'Northside',
  colors: { ...northside, onAccent: '#000000' },
  derived: ['onAccent'],
  shape: 'soft',
  displayFont: { id: 'base/archivo', family: 'Archivo' },
  bodyFont: null,
  logo: { onDarkAssetId: 'ast_dark', onLightAssetId: null },
  isDefault: true,
  groupIds: [],
  screenIds: [],
  reach: [],
  conflicts: [],
  warnings: [],
  version: 3,
  createdAt: 0,
  updatedAt: 0,
};

describe('a kit draft', () => {
  it('derives an on-colour left to the tools, as screens will get it', () => {
    const d = kitDraftOf(view);
    expect(d.colors.onAccent).toBeNull();
    expect(draftColors({ ...d, colors: { ...d.colors, accent: '#1f3fbf' } })?.onAccent).toBe('#ffffff');
  });

  it('has no colours to draw while a hex is half typed', () => {
    const d = kitDraftOf(view);
    expect(draftColors({ ...d, colors: { ...d.colors, primary: '#1f3f' } })).toBeNull();
  });

  it('saves every field with the version it was read at, null for a derived on-colour or a cleared font', () => {
    expect(updateInput(view, kitDraftOf(view))).toEqual({
      brandKitId: 'bk_1',
      name: 'Northside',
      colors: { ...northside, onAccent: null },
      shape: 'soft',
      displayFontId: 'base/archivo',
      bodyFontId: null,
      logoOnDarkAssetId: 'ast_dark',
      logoOnLightAssetId: null,
      ifVersion: 3,
    });
  });

  it('duplicates a kit under a new name, leaving out what create_brand_kit derives or does not take as null', () => {
    expect(duplicateInput(view, 'key-1')).toEqual({
      name: 'Northside copy',
      colors: { primary: '#1f3fbf', onPrimary: '#ffffff', accent: '#f5c518', background: '#0f1115', surface: '#1f2430', text: '#ffffff', muted: '#a3acbd' },
      shape: 'soft',
      displayFontId: 'base/archivo',
      logoOnDarkAssetId: 'ast_dark',
      idempotencyKey: 'key-1',
    });
  });
});

describe('withDraftKit', () => {
  const logo: AssetView = {
    id: 'ast_logo',
    name: 'logo.png',
    kind: 'image',
    status: 'verified',
    sha256: 'a'.repeat(64),
    type: 'image/png',
    size: 900,
    width: 400,
    height: 100,
    renditions: [
      { orientation: 'landscape', sha256: 'a'.repeat(64), type: 'image/png', size: 900, width: 400, height: 100 },
      { orientation: 'portrait', sha256: 'b'.repeat(64), type: 'image/png', size: 800, width: 300, height: 75 },
    ],
    createdAt: 0,
    updatedAt: 0,
    usageCount: 0,
  };
  const preview = { templates: {}, files: { ['c'.repeat(64)]: { size: 10, type: 'text/html' } }, dataSources: [] };

  it('gives the preview screen the draft kit, with its catalogue fonts and the logo for the orientation', () => {
    const d = { ...kitDraftOf(view), displayFontId: 'base/oswald', bodyFontId: null, logoOnDarkAssetId: 'ast_logo' };
    const out = withDraftKit({ preview, kitId: 'bk_1', draft: d, assets: [logo], orientation: 'portrait' })!;
    const kit = out.brand?.kits.bk_1;
    expect(out.brand?.screen).toBe('bk_1');
    expect(kit?.colors).toEqual({ ...northside, onAccent: '#000000' });
    expect(kit?.fonts.display?.family).toBe('Oswald');
    expect(kit?.fonts.body).toBeUndefined();
    expect(kit?.logo).toEqual({ onDark: 'b'.repeat(64) });
    expect(out.files['b'.repeat(64)]).toEqual({ size: 800, type: 'image/png' });
    for (const f of kit?.fonts.display?.files ?? []) expect(out.files[f.file]?.type).toBe('font/woff2');
    expect(out.files['c'.repeat(64)]).toEqual({ size: 10, type: 'text/html' });
  });

  it('is undefined while a colour is half typed, so the players keep the last kit they drew', () => {
    const d = kitDraftOf(view);
    expect(
      withDraftKit({ preview, kitId: 'bk_1', draft: { ...d, colors: { ...d.colors, text: '#ff' } }, assets: [], orientation: 'landscape' }),
    ).toBeUndefined();
  });
});
