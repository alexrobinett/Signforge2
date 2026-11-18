/**
 * The template side of the frame protocol. A template calls `defineTemplate` once.
 *
 * The SDK:
 *  - fills `[data-sf="field"]` text and `[data-sf-src="field"]` image sources from the spot's data
 *  - exposes `--sf-duration` (and `data-orientation`) so CSS can time an outro to the spot's length
 *  - holds every animation paused until the player says play
 *  - reports ready only after fonts and images have decoded, so the first frame is complete
 *  - keeps the document hidden until the first `init`, and until the frame has its size (see `sized`)
 *
 * Text shown to people should use `ctx.timezone` and `ctx.locale` (the screen's), for example
 * through `formatter(ctx, { hour: 'numeric' })`, and the time from `now()`, never `new Date()`:
 * the screen corrects its clock from the server, and the device's own clock may be wrong.
 *
 * Brand (protocol 2). When the screen has a brand kit, `init` carries it as `theme`, and before
 * `prepare` the SDK sets on the root `--sf-primary`, `--sf-on-primary`, `--sf-accent`,
 * `--sf-on-accent`, `--sf-bg`, `--sf-surface`, `--sf-text`, `--sf-muted`, `--sf-radius` (square
 * 0, soft 12px, round 9999px) and, for each brand font, `--sf-font-display` / `--sf-font-body`;
 * it loads the fonts the template's styles use (as `sf-brand-display` and `sf-brand-body`, from
 * `data:` URLs, as a template's own fonts arrive), and an `<img data-sf-src="$brand.logo">` gets the logo for the brand's
 * background (onLight on a light one, when the kit has it). Write every brand value with a
 * fallback, `var(--sf-accent, #22d3ee)`: without a kit nothing is set and the template draws as
 * it is. `ready` waits for the fonts.
 *
 * New data (protocol 2). On `reset`, or an `init` after the first, the SDK stops the template,
 * restores the document exactly as it loaded, and initialises again, so `prepare` always starts
 * from clean markup. Look elements up inside the hooks, not once at the top of `main.ts`: a reset
 * replaces them. State a template keeps outside the DOM must be cleared in `stop`.
 */
import {
  BRAND_CSS_VARS,
  PROTOCOL_VERSION,
  type BrandShape,
  type FrameTheme,
  type HostMessage,
  type InitPayload,
  type TemplateMessage,
} from '@signforge/contract';

export interface TemplateContext extends Omit<InitPayload, 'assets' | 'theme'> {
  /** Image fields as object URLs; `$brand.logo` too when the brand kit has a logo. */
  assets: Record<string, string>;
  root: HTMLElement;
}

export interface TemplateHooks {
  /** Build anything the markup alone cannot. May be async; ready is reported after it resolves. */
  prepare?(ctx: TemplateContext): void | Promise<void>;
  /** Called on the frame the spot becomes visible. CSS and WAAPI animations start by themselves. */
  play?(ctx: TemplateContext): void;
  stop?(): void;
}

const send = (m: TemplateMessage) => parent.postMessage(m, '*');

let offsetMs = 0;
/** The screen's corrected time. Use it instead of `new Date()`. */
export const now = (): Date => new Date(Date.now() + offsetMs);

export function defineTemplate(hooks: TemplateHooks = {}): void {
  // Nothing is drawn until the first init has the frame's size: see `sized`.
  let hidden: HTMLStyleElement | undefined = document.createElement('style');
  hidden.textContent = 'html{visibility:hidden!important}';
  document.head.appendChild(hidden);
  let ctx: TemplateContext | undefined;
  let urls: string[] = [];
  /** The brand font rules this init added to `<head>`. */
  let fontStyle: HTMLStyleElement | undefined;
  /** The document as it loaded, taken before the first init touches it. */
  let pristine: { body: HTMLElement; attrs: [string, string][] } | undefined;
  /** Counts inits and resets, so a prepare still running for older data never reports ready. */
  let generation = 0;

  /** Undo everything an init and its play did, so the next init starts from the loaded document. */
  const restore = () => {
    if (ctx) hooks.stop?.();
    ctx = undefined;
    generation++;
    document.getAnimations().forEach((a) => a.cancel());
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    fontStyle?.remove();
    fontStyle = undefined;
    if (!pristine) return;
    const root = document.documentElement;
    for (const a of [...root.attributes]) root.removeAttribute(a.name);
    for (const [k, v] of pristine.attrs) root.setAttribute(k, v);
    // A cloned script keeps its already-started flag, so the template's code does not run again.
    document.body.replaceWith(pristine.body.cloneNode(true));
  };

  addEventListener('message', async (e: MessageEvent<HostMessage>) => {
    // Only the player may drive a template; another frame on the page could otherwise forge an init.
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.sf !== PROTOCOL_VERSION) return;
    let run = -1;
    try {
      if (m.type === 'init') {
        const root = document.documentElement;
        if (pristine) restore();
        else pristine = { body: document.body.cloneNode(true) as HTMLElement, attrs: [...root.attributes].map((a) => [a.name, a.value]) };
        const clock = m.clock ?? { now: Date.now(), offsetMs: 0 };
        offsetMs = clock.offsetMs;
        run = ++generation;
        const assets: Record<string, string> = {};
        for (const [k, blob] of Object.entries(m.assets)) urls.push((assets[k] = URL.createObjectURL(blob)));
        if (hidden) {
          await sized();
          hidden?.remove();
          hidden = undefined;
          if (run !== generation) return;
        }
        if (m.theme) {
          const added = await applyTheme(m.theme, root);
          // Superseded while the fonts decoded: the reset's restore ran before these were added.
          if (run !== generation) return added.fontStyle?.remove();
          fontStyle = added.fontStyle;
          if (added.logo) urls.push((assets[BRAND_LOGO] = URL.createObjectURL(added.logo)));
        }
        ctx = {
          data: m.data,
          assets,
          durationMs: m.durationMs,
          orientation: m.orientation,
          viewport: m.viewport,
          timezone: m.timezone,
          locale: m.locale,
          clock,
          root,
        };
        root.style.setProperty('--sf-duration', `${m.durationMs}ms`);
        root.dataset.orientation = m.orientation;
        bind(ctx);
        await hooks.prepare?.(ctx);
        await settle();
        if (run !== generation) return;
        document.getAnimations().forEach((a) => a.pause());
        send({ sf: PROTOCOL_VERSION, type: 'ready' });
      } else if (m.type === 'play' && ctx) {
        document.getAnimations().forEach((a) => {
          a.currentTime = 0;
          a.play();
        });
        hooks.play?.(ctx);
      } else if (m.type === 'stop') {
        hooks.stop?.();
      } else if (m.type === 'reset') {
        restore();
        send({ sf: PROTOCOL_VERSION, type: 'loaded' });
      }
    } catch (err) {
      // An error from a prepare that a reset already superseded is not this play's error.
      if (run !== -1 && run !== generation) return;
      send({ sf: PROTOCOL_VERSION, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  addEventListener('error', (e) => send({ sf: PROTOCOL_VERSION, type: 'error', message: e.message }));
  send({ sf: PROTOCOL_VERSION, type: 'loaded' });
}

/** The `data-sf-src` value that takes the brand kit's logo. */
export const BRAND_LOGO = '$brand.logo';

const RADIUS: Record<BrandShape, string> = { square: '0px', soft: '12px', round: '9999px' };

/**
 * Set the theme's custom properties on the root and load its fonts. Returns the `@font-face`
 * rules it added to `<head>` (the caller removes them on reset) and the logo for the brand's
 * background.
 */
async function applyTheme(theme: FrameTheme, root: HTMLElement): Promise<{ fontStyle?: HTMLStyleElement; logo?: Blob }> {
  for (const [name, value] of Object.entries(theme.colors)) {
    const v = BRAND_CSS_VARS[name as keyof typeof theme.colors];
    if (v) root.style.setProperty(v, value);
  }
  root.style.setProperty(BRAND_CSS_VARS.radius, RADIUS[theme.shape] ?? RADIUS.soft);
  const logo = theme.logo && (theme.logo.onLight && isLight(theme.colors.background) ? theme.logo.onLight : theme.logo.onDark);
  // Only the families the template's styles use: an unused face still cost the Pi time.
  const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
  const varOf = { display: BRAND_CSS_VARS.fontDisplay, body: BRAND_CSS_VARS.fontBody } as const;
  const roles = (['display', 'body'] as const).filter((r) => theme.fonts[r]?.files.length && css.includes(varOf[r]));
  if (!roles.length) return { logo };
  // As data: URLs in @font-face, the way a template's own fonts arrive (the CSP allows font-src
  // data:). Faces made from bytes (`new FontFace(name, buffer)`) are a new typeface in every
  // document, and on the Pi one in three prepares of a large photo then took about a second to paint.
  const rules = await Promise.all(
    roles.flatMap((role) =>
      theme.fonts[role]!.files.map(async (f) => {
        const url = await dataUrl(f.data);
        return `@font-face{font-family:"sf-brand-${role}";src:url("${url}") format("woff2");font-weight:${f.weight};font-style:${f.style}}`;
      }),
    ),
  );
  const fontStyle = document.createElement('style');
  fontStyle.textContent = rules.join('');
  document.head.appendChild(fontStyle);
  for (const role of roles) root.style.setProperty(varOf[role], `sf-brand-${role}, sans-serif`);
  // Load now, inside prepare: a face is otherwise fetched only once text that uses it is laid out.
  await Promise.all(roles.flatMap((role) => theme.fonts[role]!.files.map((f) => document.fonts.load(`${f.style} ${f.weight} 16px sf-brand-${role}`))));
  return { fontStyle, logo };
}

/** A Blob as a `data:` URL, typed as WOFF2 whatever type the Blob carries. */
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(`data:font/woff2;base64,${String(r.result).slice(String(r.result).indexOf(',') + 1)}`);
    r.onerror = () => reject(r.error ?? new Error('could not read a brand font'));
    r.readAsDataURL(blob);
  });
}

/** Whether a `#rgb`/`#rrggbb` colour is light enough that dark text (and a logo for light) reads better on it. */
function isLight(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  // Black on it has more contrast than white: the WCAG crossover, at about 0.179.
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05);
}

function bind(ctx: TemplateContext): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-sf]')) {
    const v = ctx.data[el.dataset.sf!];
    if (v !== undefined) el.textContent = String(v);
  }
  for (const el of document.querySelectorAll<HTMLImageElement>('[data-sf-src]')) {
    const url = ctx.assets[el.dataset.sfSrc!];
    if (url) el.src = url;
  }
}

/**
 * Wait until the frame's compositor has the frame's size. A new frame starts drawing at 0x0 and
 * gets its size a moment later, on the first commit after it; whatever the compositor tiles before
 * that commit takes effect keeps the smallest tiles (32x256 px), and on a Pi 4 a full-screen layer
 * then rasters as ~700 tiles, about a second of GPU time. So the document stays hidden, with nothing
 * to raster, until the size is known and two frames have carried it to the compositor.
 */
async function sized(): Promise<void> {
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  while (!innerWidth || !innerHeight) await frame();
  await frame();
  await frame();
}

/** Wait until fonts are loaded, every image is decoded, and the browser has painted the result. */
async function settle(): Promise<void> {
  await document.fonts.ready;
  await Promise.all([...document.images].filter((i) => i.src).map((i) => i.decode().catch(() => undefined)));
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/** An Intl date formatter in the screen's time zone and locale. */
export function formatter(ctx: Pick<TemplateContext, 'timezone' | 'locale'>, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(ctx.locale, { timeZone: ctx.timezone, ...options });
}

/** Calendar-day key (`YYYY-MM-DD`) of an instant in the screen's time zone. */
export function dayKey(ctx: Pick<TemplateContext, 'timezone'>, date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
