/**
 * Brand kits in the compiler: which kit a screen gets, the token defaults resolved from it, and
 * the contrast rules the CMS shows. Pure, like the rest of the compiler; the CMS and the brand
 * tools use the same functions, so what they show is what a publish does.
 */
import { BRAND_COLORS, BRAND_TOKEN, type BrandColor, type BrandColors } from '@signforge/contract';

/**
 * A screen's kit choices, as the compiler takes them. Kit ids name entries of `kits`; a kit that
 * could not be built (say its logo is not verified) is left out and reported as not available.
 */
export interface BrandChoice {
  /** The screen's own choice. */
  screen?: string;
  /** The choice of each of the screen's groups that made one, by group id. */
  groups: Record<string, string>;
  /** The org's default kit. */
  default?: string;
}

/**
 * The screen's own kit, else its groups' (when they agree), else the default. Groups that
 * disagree, with no choice of the screen's own, are a problem for that screen: the conflict is
 * explicit, never settled by an order nobody chose.
 */
export function chooseBrandKit(choice: BrandChoice): { kitId?: string; problem?: string } {
  if (choice.screen) return { kitId: choice.screen };
  const groups = Object.keys(choice.groups).sort();
  const kits = [...new Set(groups.map((g) => choice.groups[g]!))].sort();
  if (kits.length > 1) {
    const names = `${groups.slice(0, -1).join(', ')} and ${groups.at(-1)}`;
    return { problem: `groups ${names} choose different brand kits (${kits.join(', ')}); choose one for the screen` };
  }
  if (kits.length === 1) return { kitId: kits[0] };
  return choice.default ? { kitId: choice.default } : {};
}

/** Token values for a screen with no kit: a plain dark palette, so a token always becomes a value. */
export const DEFAULT_BRAND_COLORS: BrandColors = {
  primary: '#2563eb',
  onPrimary: '#ffffff',
  accent: '#f59e0b',
  onAccent: '#000000',
  background: '#0b0f17',
  surface: '#1a2130',
  text: '#f5f7fa',
  muted: '#a3acbb',
};

/** The brand colour a token names: `"$brand.accent"` is `accent`. Undefined if the value is no token. */
export function tokenName(value: unknown): string | undefined {
  return typeof value === 'string' ? BRAND_TOKEN.exec(value)?.[1] : undefined;
}

export const isBrandColor = (name: string): name is BrandColor => (BRAND_COLORS as readonly string[]).includes(name);

// ------------------------------------------------------------------ contrast

/** `#rgb` or `#rrggbb`. The brand tools store colours in this form so contrast can be measured. */
export const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function luminance(hex: string): number {
  if (!HEX_COLOR.test(hex)) throw new TypeError(`not a hex colour: ${hex}`);
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2 contrast ratio of two hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The minimum contrast for text on its fill (WCAG AA, normal text). */
export const MIN_CONTRAST = 4.5;

/**
 * Black or white, whichever contrasts more with `fill`. One of them always reaches 4.5:1 (the
 * worst case is about 4.58:1), so a derived on-colour never fails.
 */
export const onColor = (fill: string): string => (contrastRatio('#000000', fill) >= contrastRatio('#ffffff', fill) ? '#000000' : '#ffffff');

/** The pairs a template draws text with: foreground on fill. */
const PAIRS: [BrandColor, BrandColor][] = [
  ['onPrimary', 'primary'],
  ['onAccent', 'accent'],
  ['text', 'background'],
  ['text', 'surface'],
  ['muted', 'background'],
];

/** One warning per pair below 4.5:1. Warnings, not problems: a kit that fails one still publishes. */
export function brandWarnings(colors: BrandColors): string[] {
  return PAIRS.flatMap(([fg, bg]) => {
    if (!HEX_COLOR.test(colors[fg]) || !HEX_COLOR.test(colors[bg])) return [];
    const ratio = contrastRatio(colors[fg], colors[bg]);
    // Rounded down, so a pair just under the line never reads as 4.50.
    return ratio < MIN_CONTRAST ? [`${fg} on ${bg} is ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1, below ${MIN_CONTRAST}:1`] : [];
  });
}
