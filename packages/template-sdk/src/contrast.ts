/**
 * The text colour for a fill: `text` when it reaches 4.5:1 on `fill` (WCAG AA), or 3:1 when it is
 * `large` (WCAG: 24 px, or 18.66 px bold, on the screen), else black or white, whichever reads
 * better (one of them always reaches 4.5:1). For a fill the template does not choose: a kit may
 * set an on-colour by hand that fails its pair (the brand tools only warn), and a colour field
 * holds whatever the spot sets. Colours are `#rgb` or `#rrggbb`, as kits and the editor's colour
 * fields give them; a fill in any other form cannot be measured and keeps `text`.
 */
export function readableOn(fill: string, text: string, { large = false } = {}): string {
  const f = luminance(fill);
  if (f === undefined) return text;
  const t = luminance(text);
  if (t !== undefined && (Math.max(f, t) + 0.05) / (Math.min(f, t) + 0.05) >= (large ? 3 : 4.5)) return text;
  return (f + 0.05) / 0.05 > 1.05 / (f + 0.05) ? '#000000' : '#ffffff';
}

/**
 * WCAG relative luminance of a `#rgb`/`#rrggbb` colour. The SDK's `isLight` keeps its own copy:
 * it is in every template's bundle, and a bundle whose bytes change needs a new template version.
 * The compiler has a third, for the brand lint; the copies are ignored by the duplicate check.
 */
// jscpd:ignore-start
function luminance(color: string): number | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return undefined;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
// jscpd:ignore-end
