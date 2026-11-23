/**
 * The harness every template's browser tests use: one headless Chromium per test file, a small host
 * page that speaks the frame protocol as the player does, and the checks the templates share (painted
 * contrast, text on a brand colour, layout and motion). Each template is built by the real `sf build`
 * path. Time comes from the `clock` in `init`, fixed here, so every frame draws the same thing.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, sampleAsset, type BrandColors, type FieldDef, type FrameTheme, type Orientation, type TemplateManifest } from '@signforge/contract';
import { buildTemplate, type BuiltTemplate } from '@signforge/template-build';

/** The time every frame is told it is: a Tuesday afternoon in UTC. */
export const NOW = Date.parse('2026-11-17T15:00:00Z');
export const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

export type Data = Record<string, unknown>;

/** examples/demo/brand.json, with the on-colours the brand tools derive for it. */
export const DEMO_KIT: BrandColors = {
  primary: '#1d4ed8',
  onPrimary: '#ffffff',
  accent: '#f97316',
  onAccent: '#000000',
  background: '#0b1020',
  surface: '#18213a',
  text: '#f8fafc',
  muted: '#a5b4cb',
};

/** A light kit whose accent is the default palette's amber, which reads on dark only. */
export const LIGHT_KIT: BrandColors = {
  primary: '#1d4ed8',
  onPrimary: '#ffffff',
  accent: '#f59e0b',
  onAccent: '#000000',
  background: '#ffffff',
  surface: '#f1f5f9',
  text: '#0f172a',
  muted: '#475569',
};

/** No kit, the demo kit and `light`: the kits a template's painted contrast is measured under. */
export const noDemoAndLight = (light: BrandColors): [string, FrameTheme | undefined][] => [
  ['no kit', undefined],
  ['the demo kit', { colors: DEMO_KIT, shape: 'soft', fonts: {} }],
  ['a light kit', { colors: light, shape: 'soft', fonts: {} }],
];

/** Two sets of data for the update lifecycle check, as `init` takes them (see `useTemplate`). */
export interface Update {
  a: Data;
  b: Data;
  assetsA?: Record<string, string>;
  assetsB?: Record<string, string>;
  /** Host the frames at a screen's own size, not at half of it. */
  full?: boolean;
}

let browser: Browser;
const contexts: BrowserContext[] = [];
/** `imageSample` from @signforge/media, as a script for the host page: an image's sample, made as the CMS makes it. */
let sampler = '';

/**
 * Register the hooks for one test file: Chromium, and the template in `dir` built as `sf build`
 * builds it, returned once the file's tests start. Every template's tests start with the update
 * lifecycle, so this registers it: `update.b` sent after `update.a` (with `reset` between, and
 * without) must leave exactly the document a fresh load of `b` gives. Lists must not append twice,
 * effects must not stack, and nothing from the old data may linger.
 */
export function useTemplate(dir: URL, update: Update): () => BuiltTemplate {
  // CI's two-core runner is many times slower than a laptop (docs/ci.md): the default 5 s is not enough for a page of frames.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  let built: BuiltTemplate | undefined;
  beforeAll(async () => {
    browser = await chromium.launch();
    built = await buildTemplate(fileURLToPath(dir));
    const entry = createRequire(import.meta.url).resolve('@signforge/media/sample');
    sampler = (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'SFSample', logLevel: 'silent' })).outputFiles[0]!
      .text;
  }, 60_000);
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close()));
  });
  afterAll(async () => {
    await browser?.close();
  });
  const t = () => built!;

  describe('update lifecycle', () => {
    it('new data after the first init leaves the same document as a fresh load', async () => {
      const { a, b, assetsA, assetsB, full = false } = update;
      await expectSameAsFresh(await host('landscape', full), t().html, spotData(t().manifest, a), spotData(t().manifest, b), assetsA, assetsB);
    });
  });
  return t;
}

/** The template's defaults with `over` on top, as the compiler hands a spot to the player. */
export function spotData(manifest: TemplateManifest, over: Data): Data {
  const out: Data = {};
  for (const [k, f] of Object.entries(manifest.fields) as [string, FieldDef][]) if ('default' in f && f.default !== undefined) out[k] = f.default;
  return { ...out, ...over };
}

export interface Host {
  page: Page;
  open(frame: string, html: string): Promise<void>;
  /**
   * With `sampled`, each image goes with its sample (`sampleAsset`), as a screen sends an image
   * uploaded with one; `'broken'`, with a PNG header and nothing that decodes. A play lasts 8 s unless `durationMs` says otherwise.
   * An asset under `$brand.logo`, or `logo` (a 4x1 logo of that colour), is the kit's logo, sent in `theme`.
   */
  init(
    frame: string,
    data: Data,
    assets?: Record<string, string>,
    now?: number,
    theme?: FrameTheme,
    sampled?: boolean | 'broken',
    durationMs?: number,
    timezone?: string,
    logo?: string,
  ): Promise<void>;
  post(frame: string, type: 'play' | 'reset' | 'stop'): Promise<void>;
  /** Wait until the frame has sent `type` `count` times in all. */
  waitFor(frame: string, type: string, count: number): Promise<void>;
  /** The frame's whole document, with object URLs (which differ per load) made equal. */
  dom(frame: string): Promise<string>;
}

/** A page of frames, each the size of a 1080p screen at half scale in `orientation`, or with `full`, at its own size. */
export async function host(orientation: Orientation = 'landscape', full = false): Promise<Host> {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  contexts.push(context);
  const page = await context.newPage();
  const [long, short] = full ? [1920, 1080] : [960, 540];
  const size = orientation === 'landscape' ? { width: long, height: short } : { width: short, height: long };
  await page.setViewportSize(size);
  await page.addScriptTag({ content: sampler });
  await page.evaluate(() => {
    const w = window as unknown as { frames_: Record<string, HTMLIFrameElement>; msgs: Record<string, string[]>; onMsg: Array<() => void> };
    w.frames_ = {};
    w.msgs = {};
    w.onMsg = [];
    addEventListener('message', (e) => {
      const name = Object.keys(w.frames_).find((k) => w.frames_[k]!.contentWindow === e.source);
      if (!name) return;
      w.msgs[name]!.push(e.data?.type === 'error' ? `error:${e.data.message}` : String(e.data?.type));
      for (const fn of [...w.onMsg]) fn();
    });
  });
  const sf = PROTOCOL_VERSION;
  const waitFor = async (frame: string, type: string, count: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(async () => {
        const m = await page.evaluate((f) => (window as unknown as { msgs: Record<string, string[]> }).msgs[f] ?? [], frame).catch(() => []);
        reject(new Error(`${frame} sent ${JSON.stringify(m)}, not ${count} × ${type}`));
      }, 10_000);
    });
    try {
      const err = await Promise.race([
        page.evaluate(
          ({ frame, type, count }) =>
            new Promise<string | null>((resolve) => {
              const w = window as unknown as { msgs: Record<string, string[]>; onMsg: Array<() => void> };
              const check = () => {
                const m = w.msgs[frame] ?? [];
                const e = m.find((x) => x.startsWith('error:'));
                if (e) return (resolve(e), true);
                if (m.filter((x) => x === type).length >= count) return (resolve(null), true);
                return false;
              };
              if (check()) return;
              const on = () => {
                if (check()) w.onMsg = w.onMsg.filter((fn) => fn !== on);
              };
              w.onMsg.push(on);
            }),
          { frame, type, count },
        ),
        timeout,
      ]);
      if (err) throw new Error(`${frame}: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    page,
    async open(frame, html) {
      await page.evaluate(
        ({ frame, html, size }) => {
          const w = window as unknown as { frames_: Record<string, HTMLIFrameElement>; msgs: Record<string, string[]> };
          const f = document.createElement('iframe');
          f.setAttribute('sandbox', 'allow-scripts');
          // Every frame on screen: Chromium throttles animation frames in an off-screen frame.
          f.style.cssText = `position:absolute;left:0;top:0;width:${size.width}px;height:${size.height}px;border:0`;
          w.frames_[frame] = f;
          w.msgs[frame] = [];
          f.srcdoc = html;
          document.body.appendChild(f);
        },
        { frame, html, size },
      );
      await waitFor(frame, 'loaded', 1);
    },
    async init(frame, data, assets = {}, now = NOW, theme, sampled = false, durationMs = 8000, timezone = 'UTC', logo) {
      const samples = sampled ? Object.fromEntries(Object.keys(assets).map((field) => [field, sampleAsset(field)])) : {};
      const broken = sampled === 'broken';
      await page.evaluate(
        async ({ frame, data, assets, samples, broken, sf, now, theme, orientation, size, durationMs, timezone, logo }) => {
          const w = window as unknown as {
            frames_: Record<string, HTMLIFrameElement>;
            SFSample: typeof import('@signforge/media/sample');
            blobCache?: Map<string, Blob>;
          };
          const cache = (w.blobCache ??= new Map());
          const png = (c: HTMLCanvasElement) => new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
          const blobs: Record<string, Blob> = {};
          for (const [field, spec] of Object.entries(assets)) {
            const key = samples[field];
            const cached = cache.get(spec);
            if (cached && !key) {
              blobs[field] = cached;
              continue;
            }
            const [, width = '8', height = '8', drawn = spec] = /^(\d+)x(\d+): (.*)$/.exec(spec) ?? [];
            const [colours = '', block] = drawn.split('; ');
            const c = document.createElement('canvas');
            c.width = Number(width);
            c.height = Number(height);
            const g = c.getContext('2d')!;
            const stripes = colours.split(' ');
            for (let x = 0; x < c.width; x++) {
              g.fillStyle = stripes[x % stripes.length]!;
              g.fillRect(x, 0, 1, c.height);
            }
            if (block) {
              const [colour, rect = ''] = block.split(' ');
              const [x = 0, y = 0, bw = 0, bh = 0] = rect.split(',').map(Number);
              g.fillStyle = colour!;
              g.fillRect(x, y, bw, bh);
            }
            const blob = cached ?? (await png(c));
            cache.set(spec, blob);
            blobs[field] = blob;
            if (!key) continue;
            if (broken) {
              blobs[key] = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' });
              continue;
            }
            const sample = w.SFSample.imageSample(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height)!;
            const sc = document.createElement('canvas');
            sc.width = sample.width;
            sc.height = sample.height;
            sc.getContext('2d')!.putImageData(new ImageData(sample.data, sample.width, sample.height), 0, 0);
            blobs[key] = await png(sc);
          }
          const { '$brand.logo': assetLogo, ...images } = blobs;
          let logoPng: Blob | undefined = assetLogo;
          if (logo) {
            const logoKey = `logo:${logo}`;
            logoPng = cache.get(logoKey);
            if (!logoPng) {
              const c = document.createElement('canvas');
              [c.width, c.height] = [4, 1];
              const g = c.getContext('2d')!;
              g.fillStyle = logo;
              g.fillRect(0, 0, 4, 1);
              logoPng = await png(c);
              cache.set(logoKey, logoPng);
            }
          }
          const init = {
            sf,
            type: 'init',
            data,
            assets: images,
            durationMs,
            orientation,
            viewport: size,
            timezone,
            locale: 'en-US',
            clock: { now, offsetMs: now - Date.now() },
            theme: theme && logoPng ? { ...theme, logo: { onDark: logoPng } } : theme,
          };
          w.frames_[frame]!.contentWindow!.postMessage(init, '*');
        },
        { frame, data, assets, samples, broken, sf, now, theme, orientation, size, durationMs, timezone, logo },
      );
    },
    post: (frame, type) =>
      page.evaluate(
        ({ frame, type, sf }) => {
          (window as unknown as { frames_: Record<string, HTMLIFrameElement> }).frames_[frame]!.contentWindow!.postMessage({ sf, type }, '*');
        },
        { frame, type, sf },
      ),
    waitFor,
    dom: async (frame) => {
      const f = page.mainFrame().childFrames()[frameOrder.get(frame)!]!;
      const html = await f.evaluate(() => document.documentElement.outerHTML);
      return html.replace(/blob:[^"')\s]+/g, 'blob:');
    },
  };
}

// Frames are created in a known order per page; map each name to its position among child frames.
const frameOrder = new Map<string, number>([
  ['fresh', 0],
  ['reset', 1],
  ['again', 2],
]);

/**
 * Each text in `scope` (weather's forecast card, the whole of the look kit's test template) that
 * reads below AA (4.5:1, 3:1 for large text), measured from what is painted: the box screenshotted
 * with its text and again with the text hidden, at rest. Each
 * glyph pixel is compared with the pixel under it, so opacity on the text or a parent, and anything
 * drawn over the card, count. A text's ratio is its 90th-percentile pixel: the cores of its strokes,
 * not their anti-aliased edges. Text that leaves no pixel of its own reads at 1:1.
 */
export async function paintedContrast(page: Page, f: Frame, scope = '.info'): Promise<string[]> {
  const { card, texts } = await f.evaluate((scope) => {
    for (const a of document.getAnimations()) a.currentTime = 2000;
    const box = document.querySelector(scope)!.getBoundingClientRect();
    const texts = [];
    for (const el of document.querySelectorAll<HTMLElement>(`${scope}, ${scope} *`)) {
      const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (!own.length) continue;
      const range = document.createRange();
      range.selectNode(own[0]!);
      range.setEndAfter(own.at(-1)!);
      const r = range.getBoundingClientRect();
      const s = getComputedStyle(el);
      const size = Number.parseFloat(s.fontSize);
      texts.push({
        name: el.id || el.className || el.tagName,
        rect: { x: Math.round(r.x - box.x), y: Math.round(r.y - box.y), w: Math.round(r.width), h: Math.round(r.height) },
        min: size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5,
      });
    }
    return { card: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, texts };
  }, scope);
  const withText = (await page.screenshot({ clip: card })).toString('base64');
  await f.evaluate((scope) => {
    const hide = document.createElement('style');
    hide.id = 'sf-test-hide';
    hide.textContent = `${scope}, ${scope} * { color: transparent !important; text-shadow: none !important; }`;
    document.head.append(hide);
  }, scope);
  const without = (await page.screenshot({ clip: card })).toString('base64');
  await f.evaluate(() => document.getElementById('sf-test-hide')!.remove());
  return page.evaluate(
    async ({ withText, without, texts }) => {
      const read = async (png: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const g = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
        g.drawImage(img, 0, 0);
        return { w: img.width, d: g.getImageData(0, 0, img.width, img.height).data };
      };
      const [a, b] = [await read(withText), await read(without)];
      const lum = (d: Uint8ClampedArray, i: number) => {
        const [r, g, bl] = [d[i]!, d[i + 1]!, d[i + 2]!].map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
      };
      const out: string[] = [];
      for (const t of texts) {
        const ratios: number[] = [];
        // Only what is on the screenshot: a crawl runs past its card, and its second copy may not have come in yet.
        const [x0, x1] = [Math.max(0, t.rect.x), Math.min(a.w, t.rect.x + t.rect.w)];
        const [y0, y1] = [Math.max(0, t.rect.y), Math.min(a.d.length / 4 / a.w, t.rect.y + t.rect.h)];
        if (x0 >= x1 || y0 >= y1) continue;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const i = (y * a.w + x) * 4;
            if (a.d[i] === b.d[i] && a.d[i + 1] === b.d[i + 1] && a.d[i + 2] === b.d[i + 2]) continue;
            const [hi, lo] = [lum(a.d, i), lum(b.d, i)].sort((p, q) => q - p);
            ratios.push((hi! + 0.05) / (lo! + 0.05));
          }
        ratios.sort((p, q) => p - q);
        const ratio = ratios.length ? ratios[Math.floor(ratios.length * 0.9)]! : 1;
        if (ratio < t.min) out.push(`${t.name}: ${ratio.toFixed(2)}:1, below ${t.min}:1`);
      }
      return out;
    },
    { withText, without, texts },
  );
}

/**
 * `b` after `a`, with a `reset` between (the editor's path: play, `reset`, wait for `loaded`, init)
 * and without one, must leave exactly the document a fresh load of `b` gives.
 */
async function expectSameAsFresh(hst: Host, html: string, a: Data, b: Data, assetsA?: Record<string, string>, assetsB?: Record<string, string>) {
  await hst.open('fresh', html);
  await hst.init('fresh', b, assetsB);
  await hst.waitFor('fresh', 'ready', 1);
  const fresh = await hst.dom('fresh');

  await hst.open('reset', html);
  await hst.init('reset', a, assetsA);
  await hst.waitFor('reset', 'ready', 1);
  await hst.post('reset', 'play');
  await hst.page.waitForTimeout(200);
  await hst.post('reset', 'reset');
  await hst.waitFor('reset', 'loaded', 2);
  await hst.init('reset', b, assetsB);
  await hst.waitFor('reset', 'ready', 2);
  expect(await hst.dom('reset')).toBe(fresh);

  // A second init with no reset in between is treated the same way.
  await hst.open('again', html);
  await hst.init('again', a, assetsA);
  await hst.waitFor('again', 'ready', 1);
  await hst.post('again', 'play');
  await hst.init('again', b, assetsB);
  await hst.waitFor('again', 'ready', 2);
  expect(await hst.dom('again')).toBe(fresh);
}

/** WCAG 2 contrast of two computed `rgb(r, g, b)` colours. */
export function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = c
      .match(/\d+(\.\d+)?/g)!
      .slice(0, 3)
      .map((v) => {
        const x = Number(v) / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** One spot for the brand-colour checks: its data, and a photo with whether it goes with its sample, as `init` takes them. */
export type BrandSpot = [data: Data, photo?: string, sampled?: boolean | 'broken'];

/**
 * Text on a brand colour (#57, #69, #92), in landscape and portrait, under no kit, the demo kit, a
 * kit with poor on-colours, a light kit, a borderline accent, mid-tone accents, an accent just over
 * 3:1 and a mid-tone background. `spots(accent, orientation)` are the template's spots, given the
 * accent `$brand.accent` resolves to. `onFill` is text on a fill (text, fill, the ratio it needs);
 * `onBackdrop` is accent-coloured text, measured on whatever is behind it. With `sameWithSample`,
 * that text's colour, and whether it is on its scrim, is the same with the photo's sample as
 * without one and with one that does not decode.
 */
export function brandColourTests(
  t: () => BuiltTemplate,
  opts: {
    spots: (accent: string, orientation: Orientation) => BrandSpot[] | Promise<BrandSpot[]>;
    onFill?: [text: string, fill: string, min: number][];
    onBackdrop: string[];
    sameWithSample?: string;
  },
) {
  const { spots, onFill = [], onBackdrop, sameWithSample } = opts;
  const demo = DEMO_KIT;
  // A kit may set its on-colours by hand; the brand tools only warn when a pair fails.
  const poor: BrandColors = { ...demo, onPrimary: '#2563eb', onAccent: '#ffffff' };
  const light = LIGHT_KIT;
  // An accent that just reaches 4.5:1 on the demo kit's background (4.69:1) and so passed when
  // measured there, where the text sits on something lighter: menu-board's card (2.94:1), the
  // tint of agenda's row happening now, cstore-promo's copy panel.
  const borderline: BrandColors = { ...demo, accent: '#d9531e' };
  // Mid-tone accents, which reach 3:1 but not 4.5:1 on the page: green on white (3.30:1) and blue
  // on the demo kit's dark background (3.66:1).
  const green: BrandColors = { ...light, accent: '#16a34a', surface: '#f8fafc' };
  const blue: BrandColors = { ...demo, accent: '#2563eb', onAccent: '#ffffff' };
  // An accent just over 3:1 on its background (3.05:1), which clock's glow, the accent itself,
  // pulls under 3:1 behind the greeting.
  const teal: BrandColors = { ...demo, accent: '#0f685b', onAccent: '#ffffff', background: '#0e020c' };
  // A mid-tone background, on which black and white both just reach 4.5:1: over a photo with light
  // and dark under the text, a shade of it leaves neither reading (#124).
  const slate: BrandColors = { ...demo, background: '#64748b', surface: '#475569', text: '#ffffff', muted: '#e2e8f0' };
  const kit = (colors: BrandColors): FrameTheme => ({ colors, shape: 'soft', fonts: {} });
  // `$brand.accent` as the compiler resolves it: the kit's accent, else DEFAULT_BRAND_COLORS.accent.
  const kits: [string, FrameTheme | undefined, string][] = [
    ['no kit', undefined, '#f59e0b'],
    ['the demo kit', kit(demo), demo.accent],
    ['a kit with poor on-colours', kit(poor), poor.accent],
    ['a light kit', kit(light), light.accent],
    ['a kit with a borderline accent', kit(borderline), borderline.accent],
    ['a light kit with a green accent', kit(green), green.accent],
    ['a dark kit with a blue accent', kit(blue), blue.accent],
    ['a kit whose accent just reaches 3:1 on its background', kit(teal), teal.accent],
    ['a kit with a mid-tone background', kit(slate), slate.accent],
  ];

  /** Run `check` on each spot under `theme`, in a frame of its own, ready and on top. */
  async function eachSpot(
    orientation: Orientation,
    theme: FrameTheme | undefined,
    accent: string,
    check: (name: string, f: Frame, page: Page) => Promise<void>,
  ) {
    const hst = await host(orientation);
    const { html, manifest } = t();
    for (const [i, [data, photo, sampled]] of (await spots(accent, orientation)).entries()) {
      const frame = `f${i}`;
      await hst.open(frame, html);
      await hst.init(frame, spotData(manifest, data), photo ? { photo } : {}, NOW, theme, sampled);
      await hst.waitFor(frame, 'ready', 1);
      const label = `${manifest.id}${data.theme ? ` (${data.theme})` : ''}${photo ? ` (photo ${photo}${sampled === 'broken' ? ', broken sample' : sampled ? ', sampled' : ''})` : ''}`;
      await check(label, hst.page.mainFrame().childFrames()[i]!, hst.page);
      // The frames overlap: the next one is measured on top.
      await hst.page.evaluate((frame) => {
        (window as unknown as { frames_: Record<string, HTMLIFrameElement> }).frames_[frame]!.style.visibility = 'hidden';
      }, frame);
    }
  }

  /**
   * The text colour of `sel`'s first match, the pixels behind its text (the intros run to their
   * end, the text and its shadow hidden, the page screenshotted), and whether it is large text on
   * a 1080p screen, twice the test frame's size (WCAG: 24 px, or 18.66 px bold).
   */
  async function textOnBackdrop(f: Frame, page: Page, sel: string): Promise<{ color: string; pixels: string[]; large: boolean }> {
    const { color, clip, px, weight } = await f.evaluate((sel) => {
      for (const a of document.getAnimations()) a.currentTime = 2000;
      const el = document.querySelector<HTMLElement>(sel)!;
      const style = getComputedStyle(el);
      const color = style.color;
      el.style.color = 'transparent';
      el.style.textShadow = 'none';
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      const clip = { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
      return { color, clip, px: parseFloat(style.fontSize), weight: Number(style.fontWeight) };
    }, sel);
    const png = (await page.screenshot({ clip })).toString('base64');
    const pixels = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const g = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      const out = new Set<string>();
      for (let i = 0; i < d.length; i += 4) out.add(`rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]})`);
      return [...out];
    }, png);
    const at1080 = px * (1080 / 540);
    return { color, pixels, large: at1080 >= 24 || (at1080 >= 18.66 && weight >= 700) };
  }

  /** `color`'s lowest contrast on any of `pixels`. */
  const worst = (color: string, pixels: string[]) => Math.min(...pixels.map((p) => contrast(color, p)));
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

  for (const orientation of ['landscape', 'portrait'] as const)
    for (const [label, theme, accent] of kits) {
      if (onFill.length)
        it(`text on a fill reads under ${label}, ${orientation}`, async () => {
          const found: string[] = [];
          await eachSpot(orientation, theme, accent, async (name, f) => {
            for (const [text, fill, min] of onFill) {
              const [fg, bg] = await f.evaluate(
                ({ text, fill }) => [getComputedStyle(document.querySelector(text)!).color, getComputedStyle(document.querySelector(fill)!).backgroundColor],
                { text, fill },
              );
              const ratio = contrast(fg!, bg!);
              if (ratio < min) found.push(`${name} ${text}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${min}:1`);
            }
          });
          expect(found).toEqual([]);
        });

      // A kit's accent is kept wherever it reads (4.5:1, or 3:1 on large text), and gives way to black or white where it does not. With no kit, cstore-promo's and
      // photo-promo's text is their own. 0.1 to spare: a template measures the ends of a gradient,
      // this test the pixels in the box.
      it(`accent text reads on its backdrop under ${label}, ${orientation}, in the accent where that reads`, async () => {
        const found: string[] = [];
        /** `sameWithSample` over each photo, with the photo's sample and without. */
        const seenWith = new Map<string, string[]>();
        await eachSpot(orientation, theme, accent, async (name, f, page) => {
          if (sameWithSample) {
            const seen = await f.evaluate((sel) => {
              const el = document.querySelector(sel)!;
              return `${getComputedStyle(el).color}${el.classList.contains('scrim') ? ' on the scrim' : ''}`;
            }, sameWithSample);
            const photo = name.replace(/, (sampled|broken sample)/, '');
            seenWith.set(photo, [...(seenWith.get(photo) ?? []), seen]);
          }
          for (const text of onBackdrop) {
            const { color, pixels, large } = await textOnBackdrop(f, page, text);
            const min = large ? 3 : 4.5;
            const ratio = worst(color, pixels);
            if (ratio < min) found.push(`${name} ${text}: ${color} is ${ratio.toFixed(2)}:1 on its backdrop, below ${min}:1`);
            const reads = worst(rgb(accent), pixels);
            if (theme && color !== rgb(accent) && reads >= min + 0.1)
              found.push(`${name} ${text}: ${color}, not the accent, which reads at ${reads.toFixed(2)}:1`);
          }
        });
        // The sample stands in for the photo, and a broken one leaves the photo: the same text every way.
        for (const [photo, seen] of seenWith)
          if (new Set(seen).size > 1)
            found.push(`${photo} ${sameWithSample} differs: ${seen.join(', ')} (sampled, unsampled${seen[2] ? ', broken sample' : ''})`);
        expect(found).toEqual([]);
      });
    }
}

/**
 * One frame of `t` at a screen's own size; `play(data, theme)` inits it with `assets` and waits for
 * ready. The Pi shows 1080p at scale 1: at half that size, a 20 px label is 10 px, and Linux paints
 * the cores of its strokes lighter (the kit's Corporate meta line read 3.90:1 on CI's runner).
 */
export async function screenFrame(t: { html: string; manifest: TemplateManifest }, orientation: Orientation, assets: Record<string, string>) {
  const hst = await host(orientation, true);
  await hst.open('fresh', t.html);
  let inits = 0;
  const frame = () => hst.page.mainFrame().childFrames()[0]!;
  return {
    hst,
    frame,
    async play(data: Data, theme?: FrameTheme, durationMs?: number, logo?: string) {
      await hst.init('fresh', spotData(t.manifest, data), assets, NOW, theme, false, durationMs, undefined, logo);
      await hst.waitFor('fresh', 'ready', ++inits);
      return frame();
    },
  };
}

/**
 * What is wrong with a template's layout at rest: text past the screen, past its clamp or cut by a
 * box around it, painted over (except by what `crosses` selects, drawn across text by design), and
 * texts that overlap, with the elements `also` selects (such as a now line) counted as text. Each
 * text is its lines' boxes, cut to every box that clips it. With `inside`, each text must also stay
 * within its nearest ancestor that matches it (a card).
 */
export const layoutFaults = (f: Frame, also = '', crosses = '', inside = '') =>
  f.evaluate(
    ({ also, crosses, inside }) => {
      // At rest: where the longest intro ends. An outro runs in reverse, and ambient motion never ends.
      const intros = document
        .getAnimations()
        .map((a) => a.effect!.getComputedTiming())
        .filter((t) => t.direction !== 'reverse' && Number.isFinite(Number(t.endTime)));
      const rest = Math.max(0, ...intros.map((t) => Number(t.endTime)));
      for (const a of document.getAnimations()) a.currentTime = rest;
      type Box = { l: number; t: number; r: number; b: number };
      const cut = (a: Box, b: Box): Box => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
      const box = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
      const clips = (el: Element) => getComputedStyle(el).overflow !== 'visible';
      const name = (el: Element) => `.${[...el.classList].filter((c) => !c.startsWith('lk-')).join('.') || el.tagName}`;
      const found: string[] = [];
      const texts: { el: Element; boxes: Box[] }[] = [];
      const screen = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      for (const el of document.querySelectorAll('.stage *')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        // A crawl is a strip meant to run past its band.
        if (!own.length || el.closest('.lk-crawl')) continue;
        const s = getComputedStyle(el);
        const em = Number.parseFloat(s.fontSize);
        // A clamp cuts vertically; a single-line ellipsis cuts horizontally. A clamped box still must not clip sideways.
        const clamped = (p: Element) => getComputedStyle(p).webkitLineClamp !== 'none';
        const ellipsised = (p: Element) => getComputedStyle(p).textOverflow === 'ellipsis' && getComputedStyle(p).whiteSpace === 'nowrap';
        if (s.display !== 'inline' && clips(el)) {
          if (!clamped(el) && !ellipsised(el) && el.scrollHeight > el.clientHeight + em / 2)
            found.push(`${name(el)} runs ${el.scrollHeight - el.clientHeight}px past its box`);
          if (!ellipsised(el) && el.scrollWidth > el.clientWidth + 1) found.push(`${name(el)} runs ${el.scrollWidth - el.clientWidth}px wide`);
        }
        // A line's box, not its glyphs' font box: display type set solid has glyph boxes that overlap the lines around them.
        const lineHeight = Number.parseFloat(s.lineHeight) || Number.POSITIVE_INFINITY;
        const range = document.createRange();
        range.setStartBefore(own[0]!);
        range.setEndAfter(own.at(-1)!);
        const boxes: Box[] = [];
        for (const line of range.getClientRects()) {
          let b = box(line);
          const middle = (b.t + b.b) / 2;
          const half = Math.min(b.b - b.t, lineHeight) / 2;
          b = { ...b, t: middle - half, b: middle + half };
          if (clips(el) && s.display !== 'inline') b = cut(b, box(el.getBoundingClientRect()));
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (!clips(p)) continue;
            const c = cut(b, box(p.getBoundingClientRect()));
            if (!clamped(p) && !ellipsised(p) && (b.b - c.b > em / 2 || c.t - b.t > em / 2)) found.push(`${name(el)} is cut by ${name(p)}`);
            if (!ellipsised(p) && (b.r - c.r > 1 || c.l - b.l > 1)) found.push(`${name(el)} is cut by ${name(p)}`);
            b = c;
          }
          if (b.r - b.l < 1 || b.b - b.t < 1) continue;
          const on = cut(b, screen);
          if (on.r - on.l < b.r - b.l - 1 || on.b - on.t < b.b - b.t - 1) found.push(`${name(el)} runs off the screen`);
          // Nothing painted over it: what is on top at the middle of the line is the text's own box. A hit
          // on a glyph's font box that reaches past its element's box (display type set solid) is no cover.
          const [x, y] = [(b.l + b.r) / 2, (b.t + b.b) / 2];
          const top = document.elementFromPoint(x, y);
          const over = top?.getBoundingClientRect();
          if (
            top &&
            over &&
            !el.contains(top) &&
            !top.contains(el) &&
            !(crosses && top.matches(crosses)) &&
            x >= over.left &&
            x <= over.right &&
            y >= over.top &&
            y <= over.bottom
          )
            found.push(`${name(el)} is covered by ${name(top)}`);
          boxes.push(b);
        }
        const card = inside && el.parentElement?.closest(inside);
        if (card) {
          const c = box(card.getBoundingClientRect());
          if (boxes.some((b) => b.l < c.l - 1 || b.r > c.r + 1 || b.t < c.t - 1 || b.b > c.b + 1)) found.push(`${name(el)} runs out of ${name(card)}`);
        }
        texts.push({ el, boxes });
      }
      if (also) for (const el of document.querySelectorAll(also)) texts.push({ el, boxes: [...el.getClientRects()].map(box) });
      for (let i = 0; i < texts.length; i++)
        for (let j = i + 1; j < texts.length; j++) {
          const [a, b] = [texts[i]!, texts[j]!];
          // One element inside the other.
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const meet = a.boxes.some((p) => b.boxes.some((q) => Math.min(p.r, q.r) - Math.max(p.l, q.l) > 1 && Math.min(p.b, q.b) - Math.max(p.t, q.t) > 1));
          if (meet) found.push(`${name(a.el)} meets ${name(b.el)}`);
        }
      return [...new Set(found)];
    },
    { also, crosses, inside },
  );

/**
 * How a template moves in a play of `durationMs`: the properties its animations change, whether
 * at most about 50 elements animate (the Rules' cap), and the kit-animated elements with no outro
 * ending as the spot ends: among those that animate at all, or with `every`, among all of them.
 */
export const motion = (f: Frame, durationMs: number, every = false) =>
  f.evaluate(
    ({ durationMs, every }) => {
      const props = new Set<string>();
      const moving = new Set<Element>();
      const unended: string[] = [];
      for (const a of document.getAnimations()) {
        const effect = a.effect as KeyframeEffect;
        for (const k of effect.getKeyframes())
          for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
        moving.add(effect.target!);
      }
      // Each element with a kit intro ends with an outro at the spot's end.
      for (const el of document.querySelectorAll('.lk-text, .lk-fade, .lk-badge, .lk-draw')) {
        const ends = el.getAnimations().map((a) => Math.round(a.effect!.getComputedTiming().endTime as number));
        if ((every || ends.length) && !ends.includes(durationMs)) unended.push(el.className);
      }
      return { props: [...props].sort(), withinCap: moving.size <= 50, unended };
    },
    { durationMs, every },
  );
