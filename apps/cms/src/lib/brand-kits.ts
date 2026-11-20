/**
 * Brand kits as the CMS reads and edits them (`list_brand_kits` and the other brand tools in
 * packages/tools/src/brand.ts, the source of truth): the editor's draft, what saving or
 * duplicating sends, the contrast of each pair a template draws text with, in words, and a fix for
 * one that fails. The contrast maths is the compiler's, so the page says what the tools say.
 */
import { BRAND_PAIRS, brandFont, contrastRatio, HEX_COLOR, MIN_CONTRAST, onColor } from '@signforge/compiler';
import { assetFile } from '@signforge/compiler/draft';
import type { BrandColor, BrandColors, BrandKit, BrandShape, Orientation } from '@signforge/contract';
import type { AssetView } from './assets';
import type { SpotPreview } from './spots';

type FontRef = { id: string; family: string } | null;

/** One kit, as the brand tools give it. */
export interface BrandKitView {
  id: string;
  name: string;
  colors: BrandColors;
  /** On-colours derived for contrast rather than set by hand. */
  derived: ('onPrimary' | 'onAccent')[];
  shape: BrandShape;
  displayFont: FontRef;
  bodyFont: FontRef;
  logo: { onDarkAssetId: string; onLightAssetId: string | null } | null;
  isDefault: boolean;
  groupIds: string[];
  screenIds: string[];
  /** Screens that get this kit at the next publish: where an edit to it will show. */
  reach: string[];
  conflicts: { screenId: string; problem: string }[];
  /** Pairs below 4.5:1, in the tools' words. */
  warnings: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** What the kit editor edits. A null on-colour is derived (black or white, for 4.5:1); a null font is the template's. */
export interface KitDraft {
  name: string;
  colors: Omit<BrandColors, 'onPrimary' | 'onAccent'> & { onPrimary: string | null; onAccent: string | null };
  shape: BrandShape;
  displayFontId: string | null;
  bodyFontId: string | null;
  logoOnDarkAssetId: string | null;
  logoOnLightAssetId: string | null;
}

export const kitDraftOf = (k: BrandKitView): KitDraft => ({
  name: k.name,
  colors: {
    ...k.colors,
    onPrimary: k.derived.includes('onPrimary') ? null : k.colors.onPrimary,
    onAccent: k.derived.includes('onAccent') ? null : k.colors.onAccent,
  },
  shape: k.shape,
  displayFontId: k.displayFont?.id ?? null,
  bodyFontId: k.bodyFont?.id ?? null,
  logoOnDarkAssetId: k.logo?.onDarkAssetId ?? null,
  logoOnLightAssetId: k.logo?.onLightAssetId ?? null,
});

/** The draft's colours as screens would get them, or null while one is not a hex colour yet. */
export function draftColors(d: KitDraft): BrandColors | null {
  const { onPrimary, onAccent, ...fills } = d.colors;
  if (![...Object.values(fills), onPrimary ?? '#000', onAccent ?? '#000'].every((c) => HEX_COLOR.test(c))) return null;
  return { ...fills, onPrimary: onPrimary ?? onColor(fills.primary), onAccent: onAccent ?? onColor(fills.accent) };
}

/**
 * The colours the page judges and shows: the draft's, with a colour still being typed (not a hex
 * colour yet) shown as it was saved, so the other verdicts and their fixes stay true meanwhile.
 */
export function shownColors(d: KitDraft, saved: BrandColors): BrandColors {
  const shown = (name: BrandColor, typed: string) => (HEX_COLOR.test(typed) ? typed : saved[name]);
  const fills = {
    primary: shown('primary', d.colors.primary),
    accent: shown('accent', d.colors.accent),
    background: shown('background', d.colors.background),
    surface: shown('surface', d.colors.surface),
    text: shown('text', d.colors.text),
    muted: shown('muted', d.colors.muted),
  };
  return {
    ...fills,
    onPrimary: d.colors.onPrimary === null ? onColor(fills.primary) : shown('onPrimary', d.colors.onPrimary),
    onAccent: d.colors.onAccent === null ? onColor(fills.accent) : shown('onAccent', d.colors.onAccent),
  };
}

/** `update_brand_kit`'s input for saving the draft, with the version the draft started from as `ifVersion`. */
export const updateInput = (brandKitId: string, d: KitDraft, ifVersion: number) => ({
  brandKitId,
  name: d.name.trim(),
  colors: d.colors,
  shape: d.shape,
  displayFontId: d.displayFontId,
  bodyFontId: d.bodyFontId,
  logoOnDarkAssetId: d.logoOnDarkAssetId,
  logoOnLightAssetId: d.logoOnLightAssetId,
  ifVersion,
});

/** `create_brand_kit`'s input for a copy of `kit`: it takes no nulls, so what is derived or unset is left out. */
export function duplicateInput(kit: BrandKitView, idempotencyKey: string) {
  const d = kitDraftOf(kit);
  const present = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  return {
    name: `${kit.name} copy`,
    colors: present(d.colors),
    shape: d.shape,
    ...present({ displayFontId: d.displayFontId, bodyFontId: d.bodyFontId, logoOnDarkAssetId: d.logoOnDarkAssetId, logoOnLightAssetId: d.logoOnLightAssetId }),
    idempotencyKey,
  };
}

/**
 * A spot's preview input (`get_spot_preview`) wearing the draft instead of the saved kit, as the
 * publish would build it (packages/tools `toBrandKit`): catalogue fonts with their files, the
 * logo's file for the orientation (@signforge/compiler `assetFile`). Undefined while a colour is not a hex colour yet.
 */
export function withDraftKit(opts: {
  preview: SpotPreview['preview'];
  kitId: string;
  draft: KitDraft;
  assets: AssetView[];
  orientation: Orientation;
}): SpotPreview['preview'] | undefined {
  const { draft, orientation } = opts;
  const colors = draftColors(draft);
  if (!colors) return undefined;
  const files = { ...opts.preview.files };
  const assets = { asset: (id: string) => opts.assets.find((x) => x.id === id) };
  // An unverified logo shows while it is checked; the publish leaves such a kit out until it is.
  const logo = (assetId: string | null) => (assetId ? assetFile(assets, assetId, orientation, files).sha : undefined);
  const display = brandFont(draft.displayFontId, files);
  const body = brandFont(draft.bodyFontId, files);
  const onDark = logo(draft.logoOnDarkAssetId);
  const onLight = logo(draft.logoOnLightAssetId);
  const kit: BrandKit = {
    id: opts.kitId,
    colors,
    shape: draft.shape,
    fonts: { ...(display ? { display } : {}), ...(body ? { body } : {}) },
    ...(onDark ? { logo: { onDark, ...(onLight ? { onLight } : {}) } } : {}),
  };
  return { ...opts.preview, files, brand: { kits: { [kit.id]: kit }, groups: {}, screen: kit.id } };
}

/** What WCAG allows below 4.5:1: text of 24 px, or 18.7 px bold, and up. */
const LARGE_TEXT_CONTRAST = 3;

const WORD: Record<BrandColor, string> = {
  primary: 'primary',
  onPrimary: 'On primary',
  accent: 'accent',
  onAccent: 'On accent',
  background: 'background',
  surface: 'surface',
  text: 'Text',
  muted: 'Muted',
};

export interface KitPair {
  fg: BrandColor;
  bg: BrandColor;
  label: string;
  /** Rounded down to one place, so a pair just under 4.5:1 never reads 4.5. */
  ratio: string;
  verdict: 'Pass' | 'Large text only' | 'Fail';
}

const ratioText = (r: number) => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;

/** Each pair a template draws text with, as the brand tools warn about them (`brandWarnings`). */
export function kitPairs(colors: BrandColors): KitPair[] {
  return BRAND_PAIRS.map(([fg, bg]) => {
    const r = contrastRatio(colors[fg], colors[bg]);
    return {
      fg,
      bg,
      label: `${WORD[fg]} on ${WORD[bg]}`,
      ratio: ratioText(r),
      verdict: r >= MIN_CONTRAST ? 'Pass' : r >= LARGE_TEXT_CONTRAST ? 'Large text only' : 'Fail',
    };
  });
}

/** `a` moved toward `b` by `t` (0 to 1), as #rrggbb. */
function mix(a: string, b: string, t: number): string {
  const channels = (h: string) => {
    const x = h.length === 4 ? [...h.slice(1)].map((c) => c + c).join('') : h.slice(1);
    return [0, 2, 4].map((i) => Number.parseInt(x.slice(i, i + 2), 16));
  };
  const [p, q] = [channels(a), channels(b)];
  return `#${p
    .map((v, i) =>
      Math.round(v + ((q[i] ?? v) - v) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * The colour that makes `fg` read on `bg`. An on-colour gets the black or white the tools derive.
 * Other text moves toward that black or white in 5% steps, only as far as 4.5:1 needs, so a muted
 * grey stays a grey; at the end of the way it is the black or white, which always passes.
 */
export function pairFix(colors: BrandColors, fg: BrandColor, bg: BrandColor): { hex: string; ratio: string } {
  const target = onColor(colors[bg]);
  let hex = target;
  if (fg !== 'onPrimary' && fg !== 'onAccent')
    for (let step = 1; step <= 20; step++) {
      hex = mix(colors[fg], target, step / 20);
      if (contrastRatio(hex, colors[bg]) >= MIN_CONTRAST) break;
    }
  return { hex, ratio: ratioText(contrastRatio(hex, colors[bg])) };
}
