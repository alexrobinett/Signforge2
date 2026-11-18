import { describe, expect, it } from 'vitest';
import { validateManifest, type BrandKit, type Spot, type TemplateManifest } from '@signforge/contract';
import {
  brandWarnings,
  chooseBrandKit,
  compileScreen,
  contrastRatio,
  DEFAULT_BRAND_COLORS,
  FONTS,
  fontById,
  MAX_FONT_FAMILY_BYTES,
  onColor,
  type CompileInput,
} from '../src/index';
import { opts, org } from './fixtures';

/** Promo with an accent that follows the brand, inside list rows too. */
const branded: TemplateManifest = {
  id: 'branded',
  version: '1.0.0',
  name: 'Branded',
  fields: {
    title: { type: 'text', label: 'Title', default: 'Hello' },
    accent: { type: 'color', label: 'Accent', default: '$brand.accent' },
    panel: { type: 'color', label: 'Panel', default: '$brand.surface' },
    rows: { type: 'list', label: 'Rows', default: [{}], item: { tint: { type: 'color', label: 'Tint', default: '$brand.primary' } } },
  },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape'],
  uses: [],
  background: '#000',
  protocol: 2,
};

const kit = (id: string, accent: string, primary: string): BrandKit => ({
  id,
  colors: { primary, onPrimary: '#ffffff', accent, onAccent: '#000000', background: '#101010', surface: '#202020', text: '#f5f5f5', muted: '#a0a0a0' },
  shape: 'soft',
  fonts: {},
});
const red = kit('bk_red', '#ff0000', '#880000');
const blue = kit('bk_blue', '#0000ff', '#000088');

/** The fixture org with a spot on the branded template and two kits; the screen's choice is set per test. */
function brandedOrg(choice: Partial<NonNullable<CompileInput['brand']>> = {}): CompileInput {
  const input = org();
  input.templates['base/branded@1.0.0'] = { manifest: branded, html: 'd'.repeat(64) };
  input.files['d'.repeat(64)] = { size: 500, type: 'text/html' };
  input.spots.push({ id: 'hello', name: 'Hello', kind: 'template', template: 'base/branded@1.0.0', data: {}, assets: {}, durationMs: 8000 });
  input.playlists[0]!.items.push({ spot: 'hello' });
  input.brand = { kits: { bk_red: red, bk_blue: blue }, groups: {}, ...choice };
  return input;
}

const data = (spot: Spot | undefined) => (spot as Extract<Spot, { kind: 'template' }>).data;

describe('brand kits in the compiler', () => {
  it('compiles the same spots to different values on two screens with two kits, and freezes the kit into the manifest', async () => {
    const onRed = (await compileScreen(brandedOrg({ screen: 'bk_red' }), opts())).manifest!;
    const lobby = brandedOrg({ screen: 'bk_blue' });
    lobby.screen = { ...lobby.screen, id: 'lobby', name: 'Lobby' };
    const onBlue = (await compileScreen(lobby, opts())).manifest!;

    expect(data(onRed.spots.hello)).toEqual({ title: 'Hello', accent: '#ff0000', panel: '#202020', rows: [{ tint: '#880000' }] });
    expect(data(onBlue.spots.hello)).toEqual({ title: 'Hello', accent: '#0000ff', panel: '#202020', rows: [{ tint: '#000088' }] });
    expect(onRed.brand).toEqual(red);
    expect(onBlue.brand).toEqual(blue);
    expect(validateManifest(onRed)).toEqual([]);
    // The template's own manifest keeps its token defaults; the spots carry values only.
    expect(JSON.stringify(onRed.spots)).not.toContain('$brand');
  });

  it("keeps a spot's own value: an override is an ordinary field value", async () => {
    const input = brandedOrg({ screen: 'bk_red' });
    (input.spots.at(-1) as Extract<Spot, { kind: 'template' }>).data = { accent: '#00ff00' };
    expect(data((await compileScreen(input, opts())).manifest!.spots.hello)).toMatchObject({ accent: '#00ff00', panel: '#202020' });
  });

  it("uses the screen's kit, else its group's, else the org default", async () => {
    const pick = async (choice: Partial<NonNullable<CompileInput['brand']>>) => (await compileScreen(brandedOrg(choice), opts())).manifest!.brand?.id;
    expect(await pick({ screen: 'bk_red', groups: { front: 'bk_blue' }, default: 'bk_blue' })).toBe('bk_red');
    expect(await pick({ groups: { front: 'bk_blue' }, default: 'bk_red' })).toBe('bk_blue');
    expect(await pick({ default: 'bk_red' })).toBe('bk_red');
    // Two groups agreeing is no conflict.
    expect(await pick({ groups: { front: 'bk_blue', back: 'bk_blue' } })).toBe('bk_blue');
  });

  it('reports two groups with different kits as a problem for that screen only', async () => {
    const torn = brandedOrg({ groups: { front: 'bk_red', back: 'bk_blue' }, default: 'bk_red' });
    torn.groups = ['front', 'back'];
    const result = await compileScreen(torn, opts());
    expect(result.manifest).toBeUndefined();
    expect(result.problems).toEqual(['brand: groups back and front choose different brand kits (bk_blue, bk_red); choose one for the screen']);

    // Its neighbour, in one of those groups only, publishes.
    const calm = brandedOrg({ groups: { front: 'bk_red' }, default: 'bk_red' });
    calm.screen = { ...calm.screen, id: 'lobby', name: 'Lobby' };
    expect((await compileScreen(calm, opts())).problems).toEqual([]);

    // The screen's own choice settles it.
    torn.brand!.screen = 'bk_blue';
    expect((await compileScreen(torn, opts())).manifest!.brand?.id).toBe('bk_blue');
  });

  it('reports a chosen kit it was not given', async () => {
    expect((await compileScreen(brandedOrg({ screen: 'bk_gone' }), opts())).problems).toEqual(['brand: brand kit bk_gone is not available']);
  });

  it('fills tokens from a neutral palette when the screen has no kit, and carries no brand', async () => {
    const { manifest } = await compileScreen(brandedOrg(), opts());
    expect(manifest!.brand).toBeUndefined();
    expect(data(manifest!.spots.hello)).toMatchObject({ accent: DEFAULT_BRAND_COLORS.accent, panel: DEFAULT_BRAND_COLORS.surface });
  });

  it('reports a token that names no brand colour, as a problem of the spot', async () => {
    const input = brandedOrg({ screen: 'bk_red' });
    input.templates['base/branded@1.0.0']!.manifest = {
      ...branded,
      fields: { ...branded.fields, accent: { type: 'color', label: 'Accent', default: '$brand.sparkle' } },
    };
    expect((await compileScreen(input, opts())).problems).toEqual(['spot hello: field "accent" defaults to $brand.sparkle, which is not a brand colour']);
  });

  it('chooses with chooseBrandKit, which the CMS uses to show where a kit reaches', () => {
    expect(chooseBrandKit({ groups: { a: 'k1', b: 'k2' }, default: 'k1' })).toEqual({
      problem: 'groups a and b choose different brand kits (k1, k2); choose one for the screen',
    });
    expect(chooseBrandKit({ groups: {}, default: 'k1' })).toEqual({ kitId: 'k1' });
    expect(chooseBrandKit({ groups: {} })).toEqual({});
  });
});

describe('contrast', () => {
  it('measures WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#fff')).toBeCloseTo(1, 5);
    // A known pair: #767676 on white is the classic 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('derives an on-colour that reaches 4.5:1 on any fill', () => {
    for (const fill of ['#000000', '#ffffff', '#767676', '#777777', '#ff0000', '#00ff00', '#0000ff', '#ffcc00', '#336699']) {
      expect(contrastRatio(onColor(fill), fill), fill).toBeGreaterThanOrEqual(4.5);
    }
    expect(onColor('#ffcc00')).toBe('#000000');
    expect(onColor('#000088')).toBe('#ffffff');
  });

  it('warns about each pair below 4.5:1', () => {
    expect(brandWarnings(red.colors)).toEqual([]);
    expect(brandWarnings({ ...red.colors, onAccent: '#ff1010', muted: '#303030' })).toEqual([
      'onAccent on accent is 1.01:1, below 4.5:1',
      'muted on background is 1.44:1, below 4.5:1',
    ]);
  });
});

describe('the font catalogue', () => {
  it('holds a curated set of OFL fonts, each with its licence, under base ids, within the size cap', () => {
    expect(FONTS.length).toBeGreaterThanOrEqual(6);
    expect(FONTS.length).toBeLessThanOrEqual(8);
    for (const f of FONTS) {
      expect(f.id, f.id).toMatch(/^base\/[a-z0-9][a-z0-9-]*$/);
      expect(f.licence.spdx).toBe('OFL-1.1');
      expect(f.licence.copyright).toMatch(/^Copyright /);
      expect(f.licence.source).toMatch(/^https:\/\//);
      expect(
        f.files.reduce((n, x) => n + x.size, 0),
        f.id,
      ).toBeLessThanOrEqual(MAX_FONT_FAMILY_BYTES);
      expect(fontById(f.id)).toBe(f);
    }
    expect(FONTS.some((f) => f.roles.includes('display')) && FONTS.some((f) => f.roles.includes('body'))).toBe(true);
    expect(fontById('base/comic-sans')).toBeUndefined();
  });
});
