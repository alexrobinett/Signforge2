/**
 * The parts of the brand kit pages (canvas boards SettingsBrandKits and Idea 11): a kit's tile,
 * the catalogue fonts as the CMS draws them, and the editor's fields: colours with a picker and a
 * hex field, the contrast of every pair with its verdict in words and a fix, fonts with samples,
 * the corner shape and the two logos. Each field calls back with the change; the store keeps it.
 */
import { choiceVariants } from '~/components/ui/choice';
import { BRAND_SHAPES, sessionBlobPath, type BrandColor, type BrandColors, type BrandShape } from '@signforge/contract';
import { FONTS, fontById, HEX_COLOR } from '@signforge/compiler';
import { WandSparklesIcon } from 'lucide-react';
import { AssetPicker } from '~/components/assets/asset-picker';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/select';
import type { AssetView } from '~/lib/assets';
import { kitPairs, pairFix, type KitDraft } from '~/lib/brand-kits';
import { cn } from '~/lib/utils';

/** Every catalogue font's faces, from the session blob route (the seed puts them there), so samples draw in them. */
export function CatalogueFonts() {
  const faces = FONTS.flatMap((f) =>
    f.files.map(
      (x) =>
        `@font-face{font-family:"${f.family}";font-weight:${x.weight};font-style:${x.style};font-display:swap;src:url(${sessionBlobPath(x.file)}) format("woff2")}`,
    ),
  ).join('');
  return (
    <style href="sf-catalogue-fonts" precedence="default">
      {faces}
    </style>
  );
}

/** A CSS font stack for a catalogue font, or the CMS's own type when the kit has none. */
export const fontStack = (id: string | null) => {
  const f = id ? fontById(id) : undefined;
  return f ? `"${f.family}", Geist, sans-serif` : undefined;
};

/** A kit at a glance: its background with its name in the display font, and its main colours. */
export function KitTile({ name, colors, displayFontId, className }: { name: string; colors: BrandColors; displayFontId: string | null; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('flex h-28 w-full max-w-56 shrink-0 flex-col justify-between rounded-sm p-3 ring-1 ring-border', className)}
      style={{ background: colors.background, color: colors.text }}
    >
      <span className="truncate text-2xl leading-none font-extrabold" style={{ fontFamily: fontStack(displayFontId) }}>
        {name}
      </span>
      <span className="flex gap-1">
        {(['primary', 'accent', 'surface', 'text'] as const).map((c) => (
          <span key={c} className="h-[18px] w-7 ring-1 ring-border" style={{ background: colors[c] }} />
        ))}
      </span>
    </div>
  );
}

const ROLES: { name: BrandColor; label: string; use: string }[] = [
  { name: 'primary', label: 'Primary', use: 'Filled grounds, buttons and badges' },
  { name: 'onPrimary', label: 'On primary', use: 'Text on primary' },
  { name: 'accent', label: 'Accent', use: 'Highlights, prices, tags' },
  { name: 'onAccent', label: 'On accent', use: 'Text on accent' },
  { name: 'background', label: 'Background', use: 'The whole screen' },
  { name: 'surface', label: 'Surface', use: 'Cards and rows on the background' },
  { name: 'text', label: 'Text', use: 'Copy on every ground' },
  { name: 'muted', label: 'Muted', use: 'Secondary text' },
];

/** `#rgb` as `#rrggbb`, which a colour input needs. */
const long = (hex: string) => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex).toLowerCase();

/**
 * The eight colours, each with a picker and a hex field. Beside each text colour, every pair it
 * is drawn in: its ratio, a verdict in words, and a one-click fix when it is below 4.5:1.
 */
export function ColourFields({
  draft,
  shown,
  disabled,
  onChange,
  onFix,
}: {
  draft: KitDraft;
  /** The colours as screens would get them: the draft's, else the saved ones while a hex is half typed. */
  shown: BrandColors;
  disabled: boolean;
  onChange: (name: BrandColor, value: string | null) => void;
  /** Gives the foreground of a failing pair its fix. */
  onFix: (fg: BrandColor, bg: BrandColor) => void;
}) {
  const pairs = kitPairs(shown);
  const failing = pairs.filter((p) => p.verdict !== 'Pass').map((p) => p.label);
  return (
    <div className="space-y-2">
      <ul className="flex flex-col">
        {ROLES.map(({ name, label, use }) => {
          const typed = draft.colors[name];
          const derived = typed === null;
          const bad = !derived && !HEX_COLOR.test(typed);
          const id = `kit-${name}`;
          return (
            <li key={name} className="grid grid-cols-[40px_minmax(0,1fr)_112px] items-center gap-x-3 gap-y-1 border-t py-2.5">
              <input
                type="color"
                aria-label={`${label} colour picker`}
                value={long(shown[name])}
                disabled={disabled}
                onChange={(e) => onChange(name, e.target.value)}
                className="size-10 cursor-pointer rounded-lg border border-input bg-card p-0.5 disabled:cursor-default"
              />
              <span className="flex min-w-0 flex-col">
                <label htmlFor={id} className="font-semibold">
                  {label}
                </label>
                <span id={`${id}-use`} className="text-xs text-muted-foreground">
                  {derived ? `${use}. Derived for 4.5:1 contrast` : use}
                </span>
              </span>
              <Input
                id={id}
                value={derived ? shown[name] : typed}
                disabled={disabled}
                spellCheck={false}
                maxLength={7}
                onChange={(e) => onChange(name, e.target.value.trim())}
                aria-invalid={bad || undefined}
                aria-describedby={`${id}-use${bad ? ` ${id}-bad` : ''}`}
                className="font-mono text-meta"
              />
              {bad && (
                <p id={`${id}-bad`} className="col-start-2 col-end-4 text-sm font-medium text-destructive">
                  A hex colour, such as #1f3fbf.
                </p>
              )}
              {(name === 'onPrimary' || name === 'onAccent') && !derived && !disabled && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="col-start-2 col-end-4 h-auto justify-self-start p-0"
                  onClick={() => onChange(name, null)}
                >
                  Derive it for contrast again
                </Button>
              )}
              {pairs
                .filter((p) => p.fg === name)
                .map((p) => {
                  const fix = p.verdict === 'Pass' ? undefined : pairFix(shown, p.fg, p.bg);
                  return (
                    <p key={p.label} className="col-start-2 col-end-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                      <span>{p.label}</span>
                      <span className={cn('font-semibold tabular-nums', p.verdict === 'Pass' ? 'text-status-online-foreground' : 'text-destructive')}>
                        {p.ratio} {p.verdict}
                      </span>
                      {fix && !disabled && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onFix(p.fg, p.bg)}
                          aria-label={`Fix ${p.label}: Use ${fix.hex} (${fix.ratio})`}
                        >
                          <WandSparklesIcon aria-hidden /> Use {fix.hex} ({fix.ratio})
                        </Button>
                      )}
                      {fix && (p.fg === 'onPrimary' || p.fg === 'onAccent') && (
                        <span className="w-full text-muted-foreground">
                          Templates draw this text in black or white instead, so screens stay readable, but not in your colour.
                        </span>
                      )}
                    </p>
                  );
                })}
            </li>
          );
        })}
      </ul>
      {/* One sentence for every verdict, said again only when which pairs fail changes, not on every ratio. */}
      <p role="status" className="sr-only">
        {failing.length ? `Below 4.5:1: ${failing.join(', ')}.` : 'Every pair reaches 4.5:1.'}
      </p>
      <p className="text-meta text-muted-foreground">A pair below 4.5:1 is a warning: the kit still publishes, but its text is hard to read across a room.</p>
    </div>
  );
}

const SAMPLE = { display: 'Aa 3/$7', body: 'Aa 9:21' };

/** A role's font from the catalogue, with a sample in it. */
export function FontField({
  use: role,
  value,
  disabled,
  onChange,
}: {
  /** Headlines or running text. */
  use: 'display' | 'body';
  value: string | null;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const id = `kit-font-${role}`;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <label htmlFor={id} className="font-medium">
        {role === 'display' ? 'Display font' : 'Body font'}
      </label>
      <span
        aria-hidden
        className={cn('text-2xl leading-tight', role === 'display' ? 'font-extrabold' : 'font-normal')}
        style={{ fontFamily: fontStack(value) }}
      >
        {SAMPLE[role]}
      </span>
      <NativeSelect id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">The template's own</option>
        {FONTS.filter((f) => f.roles.includes(role)).map((f) => (
          <option key={f.id} value={f.id}>
            {f.family}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

const SHAPE_WORD: Record<BrandShape, string> = { square: 'Square', soft: 'Soft', round: 'Round' };
const SHAPE_RADIUS: Record<BrandShape, string> = { square: '0', soft: '6px', round: '14px' };

export function ShapeField({ value, disabled, onChange }: { value: BrandShape; disabled: boolean; onChange: (s: BrandShape) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 font-medium">Corners</legend>
      <div className="flex flex-wrap gap-2">
        {BRAND_SHAPES.map((s) => (
          <label key={s} className={choiceVariants({ className: 'flex h-10 items-center gap-2 rounded-lg px-3 text-sm' })}>
            <input type="radio" name="kit-shape" checked={value === s} disabled={disabled} onChange={() => onChange(s)} className="sr-only" />
            <span aria-hidden className="size-4 border-2 border-current" style={{ borderRadius: SHAPE_RADIUS[s] }} />
            {SHAPE_WORD[s]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The two logos, each on the ground it is for, chosen from the library (SVG or PNG). */
export function LogoFields({
  draft,
  colors,
  assets,
  picking,
  disabled,
  onPick,
  onChange,
}: {
  draft: KitDraft;
  colors: BrandColors;
  assets: AssetView[];
  picking: 'dark' | 'light' | null;
  disabled: boolean;
  onPick: (which: 'dark' | 'light' | null) => void;
  onChange: (which: 'dark' | 'light', assetId: string | null) => void;
}) {
  const logos = [
    { which: 'dark', label: 'Logo on dark', assetId: draft.logoOnDarkAssetId, ground: colors.background, ink: colors.text },
    { which: 'light', label: 'Logo on light', assetId: draft.logoOnLightAssetId, ground: '#ffffff', ink: colors.primary },
  ] as const;
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Logo</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        {logos.map((l) => {
          const asset = assets.find((a) => a.id === l.assetId);
          const blocked = l.which === 'light' && !draft.logoOnDarkAssetId;
          return (
            <div key={l.which} className="flex flex-col gap-2">
              <span className="text-sm">{l.label}</span>
              <div className="grid h-20 place-items-center overflow-hidden rounded-lg p-3 ring-1 ring-border" style={{ background: l.ground, color: l.ink }}>
                {asset ? (
                  <img src={sessionBlobPath(asset.sha256)} alt={`${l.label}: ${asset.name}`} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="max-w-full truncate text-xl font-extrabold" style={{ fontFamily: fontStack(draft.displayFontId) }}>
                    {draft.name || 'Your logo'}
                  </span>
                )}
              </div>
              {!disabled && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={blocked}
                    onClick={() => onPick(l.which)}
                    aria-label={`${asset ? 'Replace' : 'Choose'} the ${l.label.toLowerCase()}`}
                  >
                    {asset ? 'Replace' : 'Choose'}
                  </Button>
                  {asset && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => onChange(l.which, null)}>
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-meta text-muted-foreground">
        An SVG or PNG from the library. Templates show the dark one on dark grounds, and the light one, if you add it, on light grounds.
      </p>
      <AssetPicker
        assets={assets}
        logos
        open={picking !== null}
        onOpenChange={(o) => onPick(o ? picking : null)}
        onPick={(a) => picking && onChange(picking, a.id)}
      />
    </div>
  );
}
