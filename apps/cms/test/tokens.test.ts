// The CMS's colour tokens (src/styles.css) meet WCAG 2 in both themes: text 4.5:1 on what it sits
// on, and field edges, focus rings, status glyphs and chart marks 3:1 (WCAG 1.4.11).
import { readFileSync } from 'node:fs';
import { contrastRatio } from '@signforge/compiler';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/** The custom properties of one block, with `var(--x)` resolved within it. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  const raw = Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  const resolve = (v: string): string => v.replace(/var\(--([a-z0-9-]+)\)/, (_, name: string) => resolve(raw[name] ?? ''));
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}

const STATUSES = ['online', 'updating', 'asleep', 'offline', 'needs-you'];
const TEXT_ON: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary', 'card'],
  ['primary', 'background'],
  ...STATUSES.map((s): [string, string] => [`status-${s}-foreground`, `status-${s}-muted`]),
  // The audit log's Who, on its rows and on a refused row's tint.
  ...['agent', 'device'].flatMap((a): [string, string][] => [
    [`actor-${a}`, 'card'],
    [`actor-${a}`, 'accent'],
  ]),
];
const EDGES_ON: [string, string][] = [
  ['input', 'card'],
  ['input', 'background'],
  ['ring', 'card'],
  ['ring', 'background'],
  ...STATUSES.map((s): [string, string] => [`status-${s}`, 'card']),
  ...[1, 2, 3, 4, 5].map((n): [string, string] => [`chart-${n}`, 'card']),
];

for (const [theme, selector] of [
  ['light', ':root'],
  ['dark', '.dark'],
] as const) {
  describe(`${theme} tokens`, () => {
    const t = tokens(selector);
    const hex = (name: string) => {
      const v = t[name];
      if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`--${name} is ${v ?? 'missing'}, not a hex colour`);
      return v;
    };
    const ratio = (a: string, b: string) => Math.round(contrastRatio(hex(a), hex(b)) * 100) / 100;

    // A status's word sits on its pill (-muted), never on its glyph colour: checked below.
    it('pair every X with X-foreground at 4.5:1', () => {
      const pairs = Object.keys(t).filter((k) => k.endsWith('-foreground') && !k.startsWith('status-') && k.slice(0, -'-foreground'.length) in t);
      expect(pairs.length).toBeGreaterThanOrEqual(10);
      for (const fg of pairs) {
        const bg = fg.slice(0, -'-foreground'.length);
        expect(ratio(fg, bg), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('give text 4.5:1 on what it sits on', () => {
      for (const [fg, bg] of TEXT_ON) expect(ratio(fg, bg), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it('give field edges, rings, status glyphs and chart marks 3:1', () => {
      for (const [fg, bg] of EDGES_ON) expect(ratio(fg, bg), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(3);
    });
  });
}

/** `hsl(h s% l%)` as hex, for the contrast check of org avatars. */
function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// An org's avatar is its hue (orgHues in src/lib/paths.ts) at the theme's saturation and lightness,
// so every hue on the wheel must hold its initials at 4.5:1 (review of #208, 6).
for (const [theme, selector] of [
  ['light', ':root'],
  ['dark', '.dark'],
] as const) {
  it(`${theme}: org avatars hold their initials at 4.5:1 at every hue`, () => {
    const t = tokens(selector);
    const pct = (name: string) => {
      const m = /^(\d+(?:\.\d+)?)%$/.exec(t[name] ?? '');
      if (!m) throw new Error(`--${name} is ${t[name] ?? 'missing'}, not a percentage`);
      return Number(m[1]) / 100;
    };
    const fg = t['org-foreground'] ?? '';
    for (let hue = 0; hue < 360; hue++) {
      const bg = hslHex(hue, pct('org-saturation'), pct('org-lightness'));
      expect(contrastRatio(fg, bg), `hue ${hue}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
