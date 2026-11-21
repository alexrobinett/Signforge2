/**
 * The text colour for a backdrop that is not one colour, such as text over a photo, given as RGBA
 * pixels (`ImageData.data`): `text` when it reads on every pixel (4.5:1, or 3:1 when `large`, as
 * `readableOn` asks), else black or white, whichever reads better on its worst pixel, when that
 * reads. Undefined when none does: light and dark under the same text leave neither black nor white
 * reading, and the text then needs a fill of its own. `text` is `#rgb` or `#rrggbb`; in any other
 * form it cannot be measured and does not read.
 *
 * Its own entry point, apart from `contrast`: any change to that file renames symbols in the bundle
 * of every template that imports it, and a bundle whose bytes change needs a new template version.
 */
export function readableOver(pixels: Uint8ClampedArray, text: string, { large = false } = {}): string | undefined {
  const min = large ? 3 : 4.5;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())?.[1];
  const [r, g, b] = (hex?.length === 3 ? [...hex].map((c) => c + c) : (hex?.match(/../g) ?? [])).map((c) => Number.parseInt(c, 16));
  const t = r === undefined ? undefined : luminance(r, g!, b!);
  let darkest = 1;
  let lightest = 0;
  let worst = t === undefined ? 0 : Number.POSITIVE_INFINITY;
  for (let i = 0; i < pixels.length; i += 4) {
    const l = luminance(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    darkest = Math.min(darkest, l);
    lightest = Math.max(lightest, l);
    if (t !== undefined) worst = Math.min(worst, (Math.max(l, t) + 0.05) / (Math.min(l, t) + 0.05));
  }
  if (worst >= min) return text;
  const black = (darkest + 0.05) / 0.05;
  const white = 1.05 / (lightest + 0.05);
  if (Math.max(black, white) < min) return undefined;
  return black >= white ? '#000000' : '#ffffff';
}

/** WCAG's linear value of each 8-bit sRGB channel value, looked up: a photo has tens of thousands of pixels. */
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));

/** WCAG relative luminance of 8-bit sRGB channels; `contrast` keeps its own copy, for the reason above. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * LINEAR[r]! + 0.7152 * LINEAR[g]! + 0.0722 * LINEAR[b]!;
}
