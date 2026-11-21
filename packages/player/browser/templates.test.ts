/**
 * The update lifecycle, against every shipped template: a template that is sent new data after its
 * first `init` (with or without `reset` first, as the editor will do) must end with exactly the
 * document a fresh load of that data gives. Lists must not append twice, weather must not stack
 * effects, and nothing from the old data may linger.
 *
 * Each template is built by the real `sf build` path and driven by a small host that speaks the
 * frame protocol as the player does. Time comes from the `clock` in `init`, fixed here, so the
 * clock, agenda and news draw the same thing in every frame.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { Frame, Page } from 'playwright';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  IMAGE_SAMPLE_CELL,
  PROTOCOL_VERSION,
  sampleAsset,
  type BrandColors,
  type FieldDef,
  type FrameTheme,
  type Orientation,
  type TemplateManifest,
} from '@signforge/contract';
import { buildTemplate } from '@signforge/cli/template';
import { useHarness } from './harness';

const h = useHarness();
const templatesDir = resolve(import.meta.dirname, '../../../templates');
const names = readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

/** The time every frame is told it is: a Tuesday afternoon in UTC. */
const NOW = Date.parse('2026-11-17T15:00:00Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

type Data = Record<string, unknown>;
/**
 * Two different sets of data per template; `assets` name the colour each image field is drawn in,
 * or colours separated by spaces for vertical stripes of them, 1 px wide on an 8x8 image, or on an
 * image of the size before a colon (`960x540: #000 #fff`: detail at the screen's own scale). After
 * `; `, a block of another colour on top: `960x540: #fff; #000 40,300,320,60` (x, y, width, height).
 */
const cases: Record<string, { a: Data; b: Data; assetsA?: Record<string, string>; assetsB?: Record<string, string> }> = {
  alert: { a: { severity: 'warning', qrUrl: 'https://example.com/a', showIssuedBy: false }, b: { severity: 'notice', showEndsAt: false } },
  agenda: {
    a: {
      subtitle: 'Main hall',
      events: [
        { title: 'Standup', start: at(1), end: at(2), allDay: false, location: 'Room 1' },
        { title: 'Review', start: at(26), end: at(27), allDay: false, location: 'Room 2' },
        { title: 'Holiday', start: '2026-11-20', end: '2026-11-21', allDay: true, location: '' },
      ],
    },
    b: { events: [{ title: 'Lunch', start: at(-0.5), end: at(1), allDay: false, location: 'Canteen' }], rows: 3 },
  },
  clock: { a: { greeting: 'Welcome', message: 'Doors open at 6', seconds: true }, b: { hour24: true } },
  'info-frame': {
    a: { look: 'night', rail: 'left', items: [{ title: 'Ferry runs late', published: '', source: '' }] },
    b: { look: 'pop', rail: 'off', ticker: 'top', showForecast: false, items: [] },
    assetsA: { photo: '#963' },
    assetsB: { photo: '#369' },
  },
  'room-status': {
    a: { look: 'corporate', events: [{ title: 'Design review', start: at(-0.5), end: at(0.5), allDay: false, organizer: 'Priya Shah' }] },
    b: { look: 'pop', showSchedule: false, events: [{ title: 'Hiring sync', start: at(1), end: at(2), allDay: false, organizer: '' }] },
  },
  'cstore-promo': {
    a: { promo: 'Buy any 3', product: 'Energy', price: '6' },
    b: { detail: 'All sizes' },
    assetsA: { imageLeft: '#f00', imageCenter: '#0f0', imageRight: '#00f' },
    assetsB: { imageLeft: '#ff0', imageCenter: '#0ff', imageRight: '#f0f' },
  },
  'menu-board': {
    a: { theme: 'light', items: Array.from({ length: 7 }, (_, i) => ({ name: `Dish ${i}`, description: 'Good', price: `$${i}`, tag: i ? '' : 'New' })) },
    b: {
      theme: 'dark',
      items: [
        { name: 'Soup', description: 'Hot', price: '$4', tag: '' },
        { name: 'Bread', description: '', price: '$2', tag: 'V' },
      ],
    },
  },
  news: {
    a: { items: [] },
    b: { source: 'Wire', items: [1, 2, 3].map((i) => ({ title: `Headline ${i}`, published: at(-i), source: 'Wire' })) },
  },
  'photo-promo': { a: { body: 'Picked this morning' }, b: { headline: 'Two for one' }, assetsA: { photo: '#963' }, assetsB: { photo: '#369' } },
  // a by day on the sun's arc, b an hour after sunset with the moon's phase drawn.
  weather: {
    a: { code: 61, isDay: 1, sunrise: NOW / 1000 - 3600, sunset: NOW / 1000 + 7200 },
    b: { code: 71, isDay: 0, temp: 30, sunrise: NOW / 1000 - 11 * 3600, sunset: NOW / 1000 - 3600 },
  },
};

/** examples/demo/brand.json, with the on-colours the brand tools derive for it. */
const DEMO_KIT: BrandColors = {
  primary: '#1d4ed8',
  onPrimary: '#ffffff',
  accent: '#f97316',
  onAccent: '#000000',
  background: '#0b1020',
  surface: '#18213a',
  text: '#f8fafc',
  muted: '#a5b4cb',
};

/** A light kit: white ground, dark text, an amber accent. */
const LIGHT_KIT: BrandColors = {
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
const noDemoAndLight = (light: BrandColors): [string, FrameTheme | undefined][] => [
  ['no kit', undefined],
  ['the demo kit', { colors: DEMO_KIT, shape: 'soft', fonts: {} }],
  ['a light kit', { colors: light, shape: 'soft', fonts: {} }],
];

const built = new Map<string, { html: string; manifest: TemplateManifest }>();
/** `imageSample` from @signforge/media, as a script for the host page: an image's sample, made as the CMS makes it. */
let sampler = '';
beforeAll(async () => {
  for (const name of names) built.set(name, await buildTemplate(join(templatesDir, name)));
  const entry = createRequire(import.meta.url).resolve('@signforge/media/sample');
  sampler = (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'SFSample', logLevel: 'silent' })).outputFiles[0]!
    .text;
}, 60_000);

/** The template's defaults with `over` on top, as the compiler hands a spot to the player. */
function spotData(manifest: TemplateManifest, over: Data): Data {
  const out: Data = {};
  for (const [k, f] of Object.entries(manifest.fields) as [string, FieldDef][]) if ('default' in f && f.default !== undefined) out[k] = f.default;
  return { ...out, ...over };
}

interface Host {
  page: Page;
  open(frame: string, html: string): Promise<void>;
  /**
   * With `sampled`, each image goes with its sample (`sampleAsset`), as a screen sends an image
   * uploaded with one; `'broken'`, with a PNG header and nothing that decodes. A play lasts 8 s unless `durationMs` says otherwise.
   * An asset under `$brand.logo` is the kit's logo, sent in `theme`.
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
  ): Promise<void>;
  post(frame: string, type: 'play' | 'reset'): Promise<void>;
  /** Wait until the frame has sent `type` `count` times in all. */
  waitFor(frame: string, type: string, count: number): Promise<void>;
  /** The frame's whole document, with object URLs (which differ per load) made equal. */
  dom(frame: string): Promise<string>;
}

/** A page of frames, each the size of a 1080p screen at half scale in `orientation`, or with `full`, at its own size. */
async function host(orientation: Orientation = 'landscape', full = false): Promise<Host> {
  const page = await h.blankPage();
  const [long, short] = full ? [1920, 1080] : [960, 540];
  const size = orientation === 'landscape' ? { width: long, height: short } : { width: short, height: long };
  await page.setViewportSize(size);
  await page.addScriptTag({ content: sampler });
  await page.evaluate(() => {
    const w = window as unknown as { frames_: Record<string, HTMLIFrameElement>; msgs: Record<string, string[]> };
    w.frames_ = {};
    w.msgs = {};
    addEventListener('message', (e) => {
      const name = Object.keys(w.frames_).find((k) => w.frames_[k]!.contentWindow === e.source);
      if (name) w.msgs[name]!.push(e.data?.type === 'error' ? `error:${e.data.message}` : String(e.data?.type));
    });
  });
  const sf = PROTOCOL_VERSION;
  const waitFor = async (frame: string, type: string, count: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const m = await page.evaluate((frame) => (window as unknown as { msgs: Record<string, string[]> }).msgs[frame] ?? [], frame);
      const err = m.find((x) => x.startsWith('error:'));
      if (err) throw new Error(`${frame}: ${err}`);
      if (m.filter((x) => x === type).length >= count) return;
      if (Date.now() > deadline) throw new Error(`${frame} sent ${JSON.stringify(m)}, not ${count} × ${type}`);
      await page.waitForTimeout(50);
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
    async init(frame, data, assets = {}, now = NOW, theme, sampled = false, durationMs = 8000, timezone = 'UTC') {
      const samples = sampled ? Object.fromEntries(Object.keys(assets).map((field) => [field, sampleAsset(field)])) : {};
      const broken = sampled === 'broken';
      await page.evaluate(
        async ({ frame, data, assets, samples, broken, sf, now, theme, orientation, size, durationMs, timezone }) => {
          const w = window as unknown as {
            frames_: Record<string, HTMLIFrameElement>;
            SFSample: typeof import('@signforge/media/sample');
          };
          const png = (c: HTMLCanvasElement) => new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
          const blobs: Record<string, Blob> = {};
          for (const [field, spec] of Object.entries(assets)) {
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
            blobs[field] = await png(c);
            const key = samples[field];
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
          const { '$brand.logo': logo, ...images } = blobs;
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
            theme: theme && logo ? { ...theme, logo: { onDark: logo } } : theme,
          };
          w.frames_[frame]!.contentWindow!.postMessage(init, '*');
        },
        { frame, data, assets, samples, broken, sf, now, theme, orientation, size, durationMs, timezone },
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

describe('template time', () => {
  // Wednesday 2031-01-01 09:30 UTC: years from the machine's own clock, so the device time cannot pass for it.
  const later = Date.parse('2031-01-01T09:30:00Z');

  it('clock, agenda and news show the time from init, not the device clock', async () => {
    const hst = await host();
    const text = async (i: number, sel: string) => (await hst.page.mainFrame().childFrames()[i]!.locator(sel).first().textContent())?.trim();

    await hst.open('fresh', built.get('clock')!.html);
    await hst.init('fresh', spotData(built.get('clock')!.manifest, {}), {}, later);
    await hst.waitFor('fresh', 'ready', 1);
    expect(await text(0, '#hm')).toBe('9:30');
    expect(await text(0, '#date')).toBe('Wednesday, January 1');

    await hst.open('reset', built.get('agenda')!.html);
    await hst.init('reset', spotData(built.get('agenda')!.manifest, { events: [] }), {}, later);
    await hst.waitFor('reset', 'ready', 1);
    expect(await text(1, '#today')).toBe('Wednesday, January 1');

    await hst.open('again', built.get('news')!.html);
    const items = [{ title: 'Story', published: '2031-01-01T08:30:00Z', source: 'Wire' }];
    await hst.init('again', spotData(built.get('news')!.manifest, { items }), {}, later);
    await hst.waitFor('again', 'ready', 1);
    expect(await text(2, '#clock')).toBe('9:30 AM');
    expect(await text(2, '#age')).toBe('1 hour ago');
  });
});

/**
 * Each text in `scope` (weather's forecast card, the whole of the look kit's test template) that
 * reads below AA (4.5:1, 3:1 for large text), measured from what is painted: the box screenshotted
 * with its text and again with the text hidden, at rest. Each
 * glyph pixel is compared with the pixel under it, so opacity on the text or a parent, and anything
 * drawn over the card, count. A text's ratio is its 90th-percentile pixel: the cores of its strokes,
 * not their anti-aliased edges. Text that leaves no pixel of its own reads at 1:1.
 */
async function paintedContrast(page: Page, f: Frame, scope = '.info'): Promise<string[]> {
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

describe('weather: the sun and moon follow sunrise, sunset and the screen clock (#70)', () => {
  // Sunrise 12:00 UTC, sunset 22:00 UTC (Unix seconds, as Open-Meteo sends them with timeformat=unixtime).
  const sunrise = Date.parse('2026-11-17T12:00:00Z') / 1000;
  const sunset = Date.parse('2026-11-17T22:00:00Z') / 1000;
  const clock = (iso: string) => Date.parse(iso);

  /**
   * One weather frame; `scene(data, at)` inits it with the clock at `at` and returns what it draws once
   * its intro is over: the orb's centre as a fraction of the frame, and the stage's scene classes.
   */
  async function weather() {
    const t = built.get('weather')!;
    const hst = await host();
    await hst.open('fresh', t.html);
    let inits = 0;
    return async (data: Data, at: number) => {
      await hst.init('fresh', spotData(t.manifest, data), {}, at);
      await hst.waitFor('fresh', 'ready', ++inits);
      return hst.page
        .mainFrame()
        .childFrames()[0]!
        .evaluate(() => {
          // Every animation to just after the intro: the orb at rest, before the outro.
          for (const a of document.getAnimations()) a.currentTime = 1500;
          const r = document.querySelector('.orb')!.getBoundingClientRect();
          const stage = document.getElementById('stage')!;
          return {
            x: (r.left + r.width / 2) / innerWidth,
            y: (r.top + r.height / 2) / innerHeight,
            classes: [...stage.classList].filter((c) => ['day', 'night', 'dawn', 'dusk'].includes(c)).sort(),
            sun: getComputedStyle(document.querySelector('.orb .rays')!).display !== 'none',
            glow: getComputedStyle(document.querySelector('.glow')!).backgroundImage !== 'none',
          };
        });
    };
  }

  it('places the sun low at sunrise, high at midday and low at sunset, with dawn and dusk skies around them', async () => {
    const scene = await weather();
    const data = { code: 0, sunrise, sunset };
    const rise = await scene(data, clock('2026-11-17T12:05:00Z'));
    const noon = await scene(data, clock('2026-11-17T17:00:00Z'));
    const set = await scene(data, clock('2026-11-17T21:55:00Z'));

    for (const s of [rise, noon, set]) expect(s.sun).toBe(true);
    expect(rise.y).toBeGreaterThan(0.8);
    expect(set.y).toBeGreaterThan(0.8);
    expect(noon.y).toBeLessThan(0.35);
    // East to west: rises on the left, sets on the right.
    expect(rise.x).toBeLessThan(noon.x);
    expect(noon.x).toBeLessThan(set.x);
    expect(rise.classes).toEqual(['dawn', 'day']);
    expect(noon.classes).toEqual(['day']);
    expect(set.classes).toEqual(['day', 'dusk']);
    expect(rise.glow).toBe(true);
    expect(set.glow).toBe(true);
    expect(noon.glow).toBe(false);
  });

  it('carries the moon across the night, from sunset to the next sunrise', async () => {
    const scene = await weather();
    const data = { code: 0, sunrise, sunset };
    const early = await scene(data, clock('2026-11-17T22:30:00Z'));
    const middle = await scene(data, clock('2026-11-18T05:00:00Z'));
    // Before the next sunrise, with the same (yesterday's) data: the times repeat a day later.
    const late = await scene(data, clock('2026-11-18T11:40:00Z'));

    for (const s of [early, middle, late]) {
      expect(s.sun).toBe(false);
      expect(s.classes).toContain('night');
    }
    expect(early.y).toBeGreaterThan(0.7);
    expect(late.y).toBeGreaterThan(0.7);
    expect(middle.y).toBeLessThan(0.35);
    expect(early.x).toBeLessThan(middle.x);
    expect(middle.x).toBeLessThan(late.x);
    expect(middle.classes).toEqual(['night']);
    expect(late.classes).toEqual(['dawn', 'night']);
  });

  it('a spot left playing across sunset goes from day to dusk to night with no new data', async () => {
    const scene = await weather();
    const data = { code: 2, sunrise, sunset };
    const seen = [];
    // The player prepares every play afresh with the screen's time, from the same snapshot.
    for (const at of ['2026-11-17T20:30:00Z', '2026-11-17T21:50:00Z', '2026-11-17T22:15:00Z', '2026-11-17T23:30:00Z'])
      seen.push((await scene(data, clock(at))).classes);
    expect(seen).toEqual([['day'], ['day', 'dusk'], ['dusk', 'night'], ['night']]);
  });

  it('every text in the forecast card reads (AA) as painted, at every time of day, in every condition, with and without a kit', async () => {
    const t = built.get('weather')!;
    const hst = await host();
    await hst.open('fresh', t.html);
    const light: BrandColors = {
      primary: '#0f766e',
      onPrimary: '#ffffff',
      accent: '#b45309',
      onAccent: '#ffffff',
      background: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
    };
    const kits = noDemoAndLight(light);
    const phases: [string, Data, string][] = [
      ['day', { isDay: 1 }, '2026-11-17T17:00:00Z'],
      ['night', { isDay: 0 }, '2026-11-17T17:00:00Z'],
      ['dawn', { sunrise, sunset }, '2026-11-17T11:50:00Z'],
      ['midday', { sunrise, sunset }, '2026-11-17T17:00:00Z'],
      ['dusk', { sunrise, sunset }, '2026-11-17T22:10:00Z'],
      ['midnight', { sunrise, sunset }, '2026-11-18T05:00:00Z'],
    ];
    const codes = [0, 2, 3, 45, 63, 71, 95];
    const found: string[] = [];
    let inits = 0;
    for (const [kit, theme] of kits)
      for (const [phase, data, at] of phases)
        for (const code of codes) {
          await hst.init('fresh', spotData(t.manifest, { ...data, code }), {}, clock(at), theme);
          await hst.waitFor('fresh', 'ready', ++inits);
          const low = await paintedContrast(hst.page, hst.page.mainFrame().childFrames()[0]!);
          for (const l of low) found.push(`${kit}, ${phase}, code ${code}: ${l}`);
        }
    expect(found).toEqual([]);
    // 252 screenshots: 17 s on a laptop, 55 s on CI's runner beside the CMS e2e (run 44578336166).
  }, 120_000);

  it('without sunrise and sunset, follows isDay as before, whatever the clock says', async () => {
    const scene = await weather();
    const day = await scene({ code: 0, isDay: 1 }, clock('2026-11-18T03:00:00Z'));
    const day2 = await scene({ code: 0, isDay: 1 }, clock('2026-11-17T21:55:00Z'));
    const night = await scene({ code: 0, isDay: 0 }, clock('2026-11-17T17:00:00Z'));
    expect(day.classes).toEqual(['day']);
    expect(day.sun).toBe(true);
    expect(night.classes).toEqual(['night']);
    expect(night.sun).toBe(false);
    expect(day2).toEqual(day);
    expect(day.glow).toBe(false);
    // The sun's old fixed place: right of centre, halfway down.
    expect(day.x).toBeCloseTo(0.765, 2);
    expect(day.y).toBeCloseTo(0.5, 2);
  });
});

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

describe('template update lifecycle', () => {
  it('covers every shipped template', () => {
    expect(Object.keys(cases).sort()).toEqual(names);
  });

  for (const name of names) {
    it(`${name}: new data after the first init leaves the same document as a fresh load`, async () => {
      const t = built.get(name)!;
      const c = cases[name]!;
      await expectSameAsFresh(await host(), t.html, spotData(t.manifest, c.a), spotData(t.manifest, c.b), c.assetsA, c.assetsB);
    });
  }
});

/** WCAG 2 contrast of two computed `rgb(r, g, b)` colours. */
function contrast(a: string, b: string): number {
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

describe('text on a brand colour (#57, #69, #92)', () => {
  const demo = DEMO_KIT;
  // A kit may set its on-colours by hand; the brand tools only warn when a pair fails.
  const poor: BrandColors = { ...demo, onPrimary: '#2563eb', onAccent: '#ffffff' };
  // A light kit whose accent is the default palette's amber, which reads on dark only.
  const light: BrandColors = {
    primary: '#1d4ed8',
    onPrimary: '#ffffff',
    accent: '#f59e0b',
    onAccent: '#000000',
    background: '#ffffff',
    surface: '#f1f5f9',
    text: '#0f172a',
    muted: '#475569',
  };
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
  const menu = { items: [{ name: 'Soup', description: 'Hot', price: '$4', tag: 'New' }] };
  /**
   * Each template's spot, given the accent `$brand.accent` resolves to and `blocks`, the photos that
   * are one colour under photo-promo's eyebrow and the other everywhere else (`blockPhotos`).
   */
  const spots = (accent: string, blocks: string[]): [template: string, data: Data, photo?: string, sampled?: boolean | 'broken'][] => [
    ['news', { accent, items: [{ title: 'Story', published: at(-1), source: 'Wire' }] }],
    ['agenda', { accent, events: [...(cases.agenda!.b.events as unknown[]), ...(cases.agenda!.a.events as unknown[])] }],
    ['clock', { accent }],
    ['cstore-promo', {}],
    // The copy sits on a shade of the kit's background over the photo, whatever the photo is: light,
    // dark, mid-tone, or light and dark under the same text, in broad stripes and in stripes 1 px
    // wide at the screen's scale, which a photo measured at less than its painted detail averages
    // to grey. Each with the photo's sample, which photo-promo reads in place of the photo, and
    // without one, as a photo uploaded before samples is.
    // Photos painted at twice their size or less are measured from their sample, and the blocks
    // only from the cells under the eyebrow: any other cells give another answer.
    ...['#ffffff', '#000000', '#808080', '#000000 #ffffff', '960x540: #000000 #ffffff', ...blocks].flatMap((photo): [string, Data, string, boolean][] => [
      ['photo-promo', {}, photo, true],
      ['photo-promo', {}, photo, false],
    ]),
    // A sample that does not decode: the photo is measured instead.
    ['photo-promo', {}, blocks[0]!, 'broken'],
    ['menu-board', { accent, ...menu }],
    ['menu-board', { accent, ...menu, theme: 'light' }],
  ];
  // Text on a fill: 4.5:1 as axe checks it, 3:1 for cstore-promo's large points figure.
  const onFill: [template: string, text: string, fill: string, min: number][] = [
    ['news', '.badge', '.badge', 4.5],
    ['cstore-promo', '.badge small', '.badge .disc', 4.5],
    ['cstore-promo', '.badge b', '.badge .disc', 3],
    ['photo-promo', '.tag', '.tag', 4.5],
    ['menu-board', '.items .tag', '.items .tag', 4.5],
  ];
  // Accent-coloured text on whatever is behind it.
  const onBackdrop: [template: string, text: string][] = [
    ['news', '.age'],
    ['agenda', '.today'],
    ['agenda', '.now .mon'],
    ['agenda', '.event:not(.now) .mon'],
    ['clock', '.greeting'],
    ['cstore-promo', '.l1'],
    ['photo-promo', '.eyebrow'],
    ['menu-board', '.price'],
  ];

  const blocks = new Map<Orientation, Promise<string[]>>();
  /**
   * Two 960x540 photos for `orientation`, white with a black block where photo-promo's eyebrow is
   * measured and black with a white one: the photo under the text through the push-in, mapped as
   * main.ts maps it, and three cells more on each side, as the sample knows the photo's size only to
   * the cell.
   */
  function blockPhotos(orientation: Orientation): Promise<string[]> {
    const made =
      blocks.get(orientation) ??
      (async () => {
        const hst = await host(orientation);
        const t = built.get('photo-promo')!;
        await hst.open('fresh', t.html);
        await hst.init('fresh', spotData(t.manifest, {}), { photo: '960x540: #808080' });
        await hst.waitFor('fresh', 'ready', 1);
        const [x, y, x1, y1] = await hst.page
          .mainFrame()
          .childFrames()[0]!
          .evaluate(() => {
            const eyebrow = document.querySelector<HTMLElement>('.eyebrow')!;
            const text = document.createRange();
            text.selectNodeContents(eyebrow);
            const { left, width } = text.getBoundingClientRect();
            const top = document.querySelector('.copy')!.getBoundingClientRect().top + eyebrow.offsetTop;
            const height = eyebrow.offsetHeight;
            const push = Number(getComputedStyle(document.querySelector('.photo')!).getPropertyValue('--push'));
            const [vw, vh, nw, nh] = [innerWidth, innerHeight, 960, 540];
            const scale = Math.max(vw / nw, vh / nh);
            const at = (p: number, size: number, natural: number, s: number) => (size / 2 + (p - size / 2) / s - (size - natural * scale) / 2) / scale;
            return [
              Math.min(at(left, vw, nw, 1), at(left, vw, nw, push)),
              Math.min(at(top, vh, nh, 1), at(top, vh, nh, push)),
              Math.max(at(left + width, vw, nw, 1), at(left + width, vw, nw, push)),
              Math.max(at(top + height, vh, nh, 1), at(top + height, vh, nh, push)),
            ];
          });
        const m = 3 * IMAGE_SAMPLE_CELL;
        const rect = [Math.floor(x!) - m, Math.floor(y!) - m, Math.ceil(x1! - x!) + 2 * m, Math.ceil(y1! - y!) + 2 * m].join(',');
        return [`960x540: #ffffff; #000000 ${rect}`, `960x540: #000000; #ffffff ${rect}`];
      })();
    blocks.set(orientation, made);
    return made;
  }

  /** Run `check` on each spot of `spots(accent)` under `theme`, in a frame of its own, ready and on top. */
  async function eachSpot(
    orientation: Orientation,
    theme: FrameTheme | undefined,
    accent: string,
    check: (name: string, f: Frame, page: Page) => Promise<void>,
  ) {
    const hst = await host(orientation);
    for (const [i, [name, data, photo, sampled]] of spots(accent, await blockPhotos(orientation)).entries()) {
      const t = built.get(name)!;
      const frame = `f${i}`;
      await hst.open(frame, t.html);
      await hst.init(frame, spotData(t.manifest, data), photo ? { photo } : {}, NOW, theme, sampled);
      await hst.waitFor(frame, 'ready', 1);
      const label = `${name}${data.theme ? ` (${data.theme})` : ''}${photo ? ` (photo ${photo}${sampled === 'broken' ? ', broken sample' : sampled ? ', sampled' : ''})` : ''}`;
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
      it(`text on a fill reads under ${label}, ${orientation}`, async () => {
        const found: string[] = [];
        await eachSpot(orientation, theme, accent, async (name, f) => {
          for (const [, text, fill, min] of onFill.filter(([n]) => name.startsWith(n))) {
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
        /** photo-promo's eyebrow over each photo, with the photo's sample and without. */
        const eyebrows = new Map<string, string[]>();
        await eachSpot(orientation, theme, accent, async (name, f, page) => {
          if (name.startsWith('photo-promo')) {
            const eyebrow = await f.evaluate(() => {
              const el = document.querySelector('.eyebrow')!;
              return `${getComputedStyle(el).color}${el.classList.contains('scrim') ? ' on the scrim' : ''}`;
            });
            const photo = name.replace(/, (sampled|broken sample)/, '');
            eyebrows.set(photo, [...(eyebrows.get(photo) ?? []), eyebrow]);
          }
          for (const [, text] of onBackdrop.filter(([n]) => name.startsWith(n))) {
            const { color, pixels, large } = await textOnBackdrop(f, page, text);
            const min = large ? 3 : 4.5;
            const ratio = worst(color, pixels);
            if (ratio < min) found.push(`${name} ${text}: ${color} is ${ratio.toFixed(2)}:1 on its backdrop, below ${min}:1`);
            const reads = worst(rgb(accent), pixels);
            if (theme && color !== rgb(accent) && reads >= min + 0.1)
              found.push(`${name} ${text}: ${color}, not the accent, which reads at ${reads.toFixed(2)}:1`);
          }
        });
        // The sample stands in for the photo, and a broken one leaves the photo: the same eyebrow every way.
        for (const [photo, seen] of eyebrows)
          if (new Set(seen).size > 1) found.push(`${photo} .eyebrow differs: ${seen.join(', ')} (sampled, unsampled${seen[2] ? ', broken sample' : ''})`);
        expect(found).toEqual([]);
      });
    }
});

describe('the look kit (#190)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  /** Each look's font families, as looks.css names them. */
  const faces: Record<(typeof looks)[number], string[]> = {
    pop: ['lk-pop', 'lk-body'],
    poster: ['lk-poster', 'lk-body'],
    night: ['lk-night', 'lk-night-mono', 'lk-body'],
    corporate: ['lk-corporate'],
  };
  const light: BrandColors = {
    primary: '#1d4ed8',
    onPrimary: '#ffffff',
    accent: '#f59e0b',
    onAccent: '#000000',
    background: '#ffffff',
    surface: '#f1f5f9',
    text: '#0f172a',
    muted: '#475569',
  };
  const kits = noDemoAndLight(light);
  const photo = { photo: '#808080' };
  let t: { html: string; manifest: TemplateManifest };
  beforeAll(async () => {
    t = await buildTemplate(resolve(import.meta.dirname, '../../template-looks/looks-test'));
  }, 60_000);

  /**
   * One frame of the test template at a screen's own size; `play(data, theme)` inits it and waits
   * for ready. The Pi shows 1080p at scale 1: at half that size, a 20 px label is 10 px, and Linux
   * paints the cores of its strokes lighter (Corporate's meta line read 3.90:1 on CI's runner).
   */
  async function kitFrame(orientation: Orientation = 'landscape') {
    const hst = await host(orientation, true);
    await hst.open('fresh', t.html);
    let inits = 0;
    const frame = () => hst.page.mainFrame().childFrames()[0]!;
    return {
      hst,
      frame,
      async play(data: Data, theme?: FrameTheme, durationMs?: number) {
        await hst.init('fresh', spotData(t.manifest, data), photo, NOW, theme, false, durationMs);
        await hst.waitFor('fresh', 'ready', ++inits);
        return frame();
      },
    };
  }

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const k = await kitFrame(orientation);
      const found: string[] = [];
      for (const [kit, theme] of kits)
        for (const look of looks)
          for (const shown of [true, false]) {
            const f = await k.play({ look, showPhoto: shown, showBody: shown }, theme);
            for (const l of await paintedContrast(k.hst.page, f, '.stage')) found.push(`${look}, ${kit}${shown ? '' : ', photo and body off'}: ${l}`);
          }
      expect(found).toEqual([]);
    }, 120_000);

  it('a look decodes only its own faces, and they are loaded by ready', async () => {
    for (const look of looks) {
      // A frame of its own: a screen loads every spot in a new frame, and a face stays loaded in its document.
      const f = await (await kitFrame()).play({ look });
      const status = await f.evaluate(() => [...document.fonts].map((ff) => [ff.family.replaceAll('"', ''), ff.status] as const));
      const loaded = [...new Set(status.filter(([, s]) => s !== 'unloaded').map(([family]) => family))].sort();
      expect(loaded, look).toEqual([...faces[look]].sort());
      expect(
        status.filter(([family, s]) => faces[look].includes(family) && s === 'loading'),
        look,
      ).toEqual([]);
    }
  });

  it('the accent keeps its colour where it reads and gives way to black or white where it does not', async () => {
    const k = await kitFrame();
    const seen: Record<string, string[]> = {};
    for (const [kit, theme] of kits) {
      const f = await k.play({ look: 'poster' }, theme);
      seen[kit] = await f.evaluate(() => ['.figure', '.figure-label', '.eyebrow'].map((s) => getComputedStyle(document.querySelector(s)!).color));
    }
    expect(seen).toEqual({
      // Poster's red as large text, its darker red as small text, ink on the red fill.
      'no kit': ['rgb(232, 64, 28)', 'rgb(194, 51, 15)', 'rgb(17, 17, 17)'],
      // The demo kit's orange reads on its dark background (6.71:1).
      'the demo kit': ['rgb(249, 115, 22)', 'rgb(249, 115, 22)', 'rgb(255, 255, 255)'],
      // Amber on white is 2.15:1: black, large and small.
      'a light kit': ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)'],
    });
  });

  it('marks each toggle on the root, removes what is off, and the layout reflows with the type stepped up', async () => {
    const k = await kitFrame();
    const measure = (f: Frame) =>
      f.evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 2000;
        const root = document.documentElement;
        const copy = document.querySelector('.copy')!;
        // Glyphs overhang a tight leading by a few pixels; text cut by a clamp overflows by a whole line (news's ellipsize).
        const clamped = [...document.querySelectorAll<HTMLElement>('.headline, .body, .figure-label')].filter(
          (el) => el.scrollHeight > el.clientHeight + Number.parseFloat(getComputedStyle(el).fontSize) / 2,
        );
        return {
          marks: ['eyebrow', 'body', 'meta', 'photo', 'crawl'].map((m) => `${m}=${root.getAttribute(`data-${m}`)}`),
          present: ['.eyebrow', '.body', '.meta', '.photo', '.ticker'].filter((s) => document.querySelector(s)),
          headline: Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize),
          copyWidth: copy.getBoundingClientRect().width,
          overflow: [...(copy.scrollHeight > copy.clientHeight + 1 ? ['.copy'] : []), ...clamped.map((el) => el.className)],
        };
      });
    for (const look of looks) {
      const on = await measure(await k.play({ look }));
      const off = await measure(await k.play({ look, showEyebrow: false, showBody: false, showMeta: false, showPhoto: false, showCrawl: false }));
      expect(on.marks, look).toEqual(['eyebrow=on', 'body=on', 'meta=on', 'photo=on', 'crawl=on']);
      expect(on.present, look).toEqual(['.eyebrow', '.body', '.meta', '.photo', '.ticker']);
      expect(off.marks, look).toEqual(['eyebrow=off', 'body=off', 'meta=off', 'photo=off', 'crawl=off']);
      expect(off.present, look).toEqual([]);
      expect(off.copyWidth, look).toBeGreaterThan(on.copyWidth * 1.5);
      const step = Number(await (await k.play({ look })).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lk-step')));
      expect(off.headline / on.headline, look).toBeCloseTo(step, 2);
      expect([...on.overflow, ...off.overflow], look).toEqual([]);
    }
  });

  it('every element has an intro and, timed from --sf-duration, an outro, moving only transform and opacity', async () => {
    const k = await kitFrame();
    // Not 8 s, the stylesheet's fallback for --sf-duration: the outros must follow the play's own length.
    const durationMs = 11_000;
    for (const look of looks) {
      const f = await k.play({ look }, undefined, durationMs);
      const { props, ends } = await f.evaluate((durationMs) => {
        const props = new Set<string>();
        for (const a of document.getAnimations())
          for (const k of (a.effect as KeyframeEffect).getKeyframes())
            for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
        // The photo's own intro and outro, or in Poster the ink block's, which uncovers it and covers it again.
        const moving = ['.badge', '.live', '.rule', '.headline', '.body', '.facts', '.meta', '.tag', '.ticker', '.photo', '.cover'];
        const ends = moving.map((sel) => {
          const timed = document
            .querySelector(sel)!
            .getAnimations()
            .map((a) => a.effect!.getComputedTiming().endTime as number)
            .filter(Number.isFinite);
          return `${sel} ${timed
            .map(Math.round)
            .sort((a, b) => a - b)
            .map((ms) => (ms === durationMs ? 'outro at the end' : ms <= 2000 ? 'intro' : `${ms} ms`))
            .join(', ')}`;
        });
        return { props: [...props].sort(), ends };
      }, durationMs);
      expect(props, look).toEqual(['opacity', 'transform']);
      const both = (sel: string) => `${sel} intro, outro at the end`;
      const photo = look === 'poster' ? ['.photo ', both('.cover')] : [both('.photo'), '.cover '];
      expect(ends, look).toEqual([...['.badge', '.live', '.rule', '.headline', '.body', '.facts', '.meta', '.tag', '.ticker'].map(both), ...photo]);
    }
  });

  // A photo drifting across a portrait screen's width took the test template over 1% of frames
  // dropped on the Pi (spike/pi-perf/RESULTS.md, The look kit): still in portrait until one measures under.
  it('drifts the photo in landscape, and holds it still in portrait', async () => {
    const drifting: Record<string, number[]> = {};
    for (const orientation of ['landscape', 'portrait'] as const) {
      const k = await kitFrame(orientation);
      for (const look of looks) {
        const f = await k.play({ look });
        (drifting[orientation] ??= []).push(await f.evaluate(() => document.querySelector('.lk-drift')!.getAnimations().length));
      }
    }
    expect(drifting).toEqual({ landscape: [1, 1, 1, 1], portrait: [0, 0, 0, 0] });
  });

  it('with reduced motion, shows the final frame with nothing animating and the crawl cut to one line', async () => {
    const k = await kitFrame();
    await k.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    const long = 'Tours from 9 to 11 in the lobby · The roof terrace opens at noon · Bring your badge · Coffee and pastries all morning on the ground floor';
    for (const look of looks) {
      const f = await k.play({ look, crawl: long });
      await k.hst.post('fresh', 'play');
      const still = await f.evaluate(() => ({
        animations: document.getAnimations().length,
        moved: [...document.querySelectorAll<HTMLElement>('.stage *')]
          .filter((el) => !el.classList.contains('lk-cover'))
          .filter((el) => getComputedStyle(el).opacity !== '1' || getComputedStyle(el).transform !== 'none')
          .map((el) => el.className),
        crawl: [...document.querySelectorAll('#crawl > *')].map((el) => getComputedStyle(el).display),
        cut: (() => {
          const strip = document.getElementById('crawl')!;
          return getComputedStyle(strip).textOverflow === 'ellipsis' && strip.scrollWidth > strip.clientWidth;
        })(),
      }));
      expect(still, look).toEqual({ animations: 0, moved: [], crawl: ['inline', 'none'], cut: true });
    }
  });

  it("the crawl holds its text twice and slides by exactly one copy at the look's speed", async () => {
    const k = await kitFrame();
    for (const look of looks) {
      const f = await k.play({ look });
      const c = await f.evaluate(() => {
        const strip = document.getElementById('crawl')!;
        const [a, b] = [...strip.children] as HTMLElement[];
        const s = getComputedStyle(strip);
        return {
          copies: [a!.textContent === b!.textContent, b!.getAttribute('aria-hidden')],
          shift: Number.parseFloat(s.getPropertyValue('--lk-crawl-shift')),
          copyWidth: b!.getBoundingClientRect().left - a!.getBoundingClientRect().left,
          seconds: Number.parseFloat(s.getPropertyValue('--lk-crawl-s')),
          speed: Number.parseFloat(s.getPropertyValue('--lk-crawl-speed')),
        };
      });
      expect(c.copies, look).toEqual([true, 'true']);
      expect(c.shift, look).toBeCloseTo(-c.copyWidth, 0);
      // The frame is 1920x1080: 1vmin is 10.8 px.
      expect(c.copyWidth / c.seconds, look).toBeCloseTo(c.speed * 10.8, 1);
    }
  });

  it('new data after the first init leaves the same document as a fresh load', async () => {
    const a = spotData(t.manifest, { look: 'pop', showPhoto: false }),
      b = spotData(t.manifest, { look: 'night', showCrawl: false });
    await expectSameAsFresh(await host('landscape', true), t.html, a, b, photo, photo);
  });
});

describe('alert (#200)', () => {
  const severities = ['emergency', 'warning', 'advisory', 'notice'] as const;
  const light: BrandColors = { ...DEMO_KIT, background: '#ffffff', surface: '#f1f5f9', text: '#0f172a', muted: '#475569', accent: '#f59e0b' };
  const kits = noDemoAndLight(light);
  const qrUrl = 'https://example.com/updates';
  /** Each text field at its `maxLength`, in words of an ordinary length. */
  const long = (n: number) => 'Leave by the stairs and wait outside '.repeat(20).slice(0, n).trimEnd();
  const longCopy = () => {
    const fields = built.get('alert')!.manifest.fields;
    const max = (f: string) => (fields[f] as { maxLength: number }).maxLength;
    return Object.fromEntries(['headline', 'instructions', 'issuedBy', 'endsAt', 'qrLabel'].map((f) => [f, long(max(f))]));
  };
  /** Every toggle state that changes the layout: all on, the QR code off, the foot line off, and all off. */
  const toggles: [string, Data][] = [
    ['all on', {}],
    ['QR off', { showQr: false }],
    ['issued-by and ends-at off', { showIssuedBy: false, showEndsAt: false }],
    ['all off', { showQr: false, showIssuedBy: false, showEndsAt: false }],
  ];

  async function alertFrame(orientation: Orientation = 'landscape') {
    const hst = await host(orientation, true);
    const t = built.get('alert')!;
    await hst.open('fresh', t.html);
    let inits = 0;
    return {
      hst,
      async play(data: Data, theme?: FrameTheme, durationMs?: number) {
        await hst.init('fresh', spotData(t.manifest, { qrUrl, ...data }), {}, NOW, theme, false, durationMs);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.page.mainFrame().childFrames()[0]!;
      },
    };
  }

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every severity reads as painted, in its own colours whatever the kit, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      const found: string[] = [];
      const grounds: Record<string, string[]> = {};
      for (const [kit, theme] of kits)
        for (const severity of severities)
          for (const [state, over] of [toggles[0]!, toggles[3]!]) {
            const f = await k.play({ severity, ...over }, theme);
            for (const l of await paintedContrast(k.hst.page, f, '.stage')) found.push(`${severity}, ${kit}, ${state}: ${l}`);
            (grounds[kit] ??= []).push(await f.evaluate(() => getComputedStyle(document.querySelector('.stage')!).backgroundColor));
          }
      expect(found).toEqual([]);
      // A kit never recolours a severity.
      expect(grounds['the demo kit']).toEqual(grounds['no kit']);
      expect(grounds['a light kit']).toEqual(grounds['no kit']);
      expect([...new Set(grounds['no kit'])]).toEqual(['rgb(153, 27, 27)', 'rgb(245, 158, 11)', 'rgb(253, 224, 71)', 'rgb(30, 58, 138)']);
    }, 120_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every field at its longest fits, with nothing overlapping, in every toggle state, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      const found: string[] = [];
      for (const [copy, text] of [
        ['short copy', {}],
        ['long copy', longCopy()],
      ] as const)
        for (const [state, over] of toggles) {
          const f = await k.play({ ...text, ...over });
          const problems = await f.evaluate(() => {
            for (const a of document.getAnimations()) a.currentTime = 2000;
            const body = document.querySelector('.body')!;
            const out: string[] = [];
            if (body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth) out.push('the copy overflows');
            const box = body.getBoundingClientRect();
            // Each line box: the foot line's two parts are inline, and share a line.
            const parts = ['.headline', '.instructions', '.issued', '.ends', '.qr'].flatMap((sel) =>
              [...(document.querySelector(sel)?.getClientRects() ?? [])].map((r) => [sel, r] as const),
            );
            for (const [sel, r] of parts) if (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom) out.push(`${sel} outside`);
            for (const [i, [a, ra]] of parts.entries())
              for (const [b, rb] of parts.slice(i + 1))
                if (a !== b && ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) out.push(`${a} overlaps ${b}`);
            return out;
          });
          for (const p of problems) found.push(`${copy}, ${state}: ${p}`);
        }
      expect(found).toEqual([]);
    }, 120_000);

  it('marks each toggle on the root and removes what is off; without the QR code the type steps up', async () => {
    const k = await alertFrame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['qr', 'issued-by', 'ends-at'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.qr', '.issued', '.ends'].filter((s) => document.querySelector(s)),
        headline: Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize),
        qr: document.querySelector('#qr svg')?.getAttribute('aria-label'),
      }));
    const on = await read(await k.play({}));
    expect(on).toEqual({ marks: ['qr=on', 'issued-by=on', 'ends-at=on'], present: ['.qr', '.issued', '.ends'], headline: on.headline, qr: 'Scan for updates' });
    const off = await read(await k.play({ showQr: false, showIssuedBy: false, showEndsAt: false }));
    expect(off).toEqual({ marks: ['qr=off', 'issued-by=off', 'ends-at=off'], present: [], headline: off.headline, qr: undefined });
    expect(off.headline / on.headline).toBeCloseTo(1.12, 2);
    // No address, no code; no end, no "Ends at".
    expect((await read(await k.play({ qrUrl: '' }))).marks[0]).toBe('qr=off');
    expect((await read(await k.play({ endsAt: '' }))).marks[2]).toBe('ends-at=off');
  });

  it('steps the type down until long copy fits', async () => {
    const k = await alertFrame();
    const size = async (data: Data) => (await k.play(data)).evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize));
    expect(await size(longCopy())).toBeLessThan(await size({}));
  });

  it('emergency and warning drop in hard, advisory and notice fade, and only emergency pulses, at most once every 2 s', async () => {
    const k = await alertFrame();
    // Not the default 60 s: the outros must follow the play's own length.
    const durationMs = 20_000;
    const seen: Record<string, unknown> = {};
    for (const severity of severities) {
      const f = await k.play({ severity }, undefined, durationMs);
      seen[severity] = await f.evaluate((durationMs) => {
        const props = new Set<string>();
        const ambient: string[] = [];
        for (const a of document.getAnimations()) {
          const effect = a.effect as KeyframeEffect;
          for (const kf of effect.getKeyframes())
            for (const p of Object.keys(kf)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
          const t = effect.getComputedTiming();
          if (t.iterations === Number.POSITIVE_INFINITY) ambient.push(`${(effect.target as Element).getAttribute('class')} every ${t.duration} ms`);
        }
        const timed = (sel: string) =>
          document
            .querySelector(sel)!
            .getAnimations()
            .map(
              (a) => `${(a as CSSAnimation).animationName} ${Math.round(a.effect!.getComputedTiming().endTime as number) === durationMs ? 'outro' : 'intro'}`,
            );
        return {
          props: [...props].sort(),
          band: timed('.band'),
          outros: ['.band', '.icon', '.label', '.headline', '.instructions', '.meta', '.qr'].map((s) => timed(s).at(-1)),
          ambient: ambient.sort(),
        };
      }, durationMs);
    }
    const hard = (ambient: string[]) => ({
      props: ['opacity', 'transform'],
      band: ['alert-drop intro', 'alert-drop outro'],
      outros: ['alert-drop outro', 'alert-pop outro', 'alert-slide outro', 'alert-rise outro', 'alert-rise outro', 'alert-fade outro', 'alert-fade outro'],
      ambient,
    });
    const calm = {
      props: ['opacity', 'transform'],
      band: ['alert-fade intro', 'alert-fade outro'],
      outros: ['alert-fade outro', 'alert-fade outro', 'alert-fade outro', 'alert-soft outro', 'alert-soft outro', 'alert-fade outro', 'alert-fade outro'],
      ambient: [],
    };
    // 2000 ms a cycle is 0.5 Hz: one flash every 2 s, under WCAG 2.3.1's 3 a second.
    expect(seen).toEqual({ emergency: hard(['beat every 2000 ms', 'glow every 2000 ms']), warning: hard([]), advisory: calm, notice: calm });
  });

  it('with reduced motion, shows the final frame with nothing animating', async () => {
    const k = await alertFrame();
    await k.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const severity of severities) {
      const f = await k.play({ severity });
      await k.hst.post('fresh', 'play');
      const still = await f.evaluate(() => ({
        animations: document.getAnimations().length,
        moved: [...document.querySelectorAll<HTMLElement>('.stage *')]
          .filter((el) => !el.classList.contains('glow'))
          .filter((el) => getComputedStyle(el).opacity !== '1' || getComputedStyle(el).transform !== 'none')
          .map((el) => el.className),
      }));
      expect(still, severity).toEqual({ animations: 0, moved: [] });
    }
  });
});

/**
 * What is wrong with a template's layout at rest: text past the screen, past its clamp or cut by a
 * box around it, painted over, and texts that overlap. Each text is its lines' boxes, cut to every
 * box that clips it. `marks` are other things that count as text (room status's now line and pin);
 * with `inside`, each text must also stay within its nearest ancestor matching it (a card).
 */
const faults = (f: Frame, { marks = '', inside = '' } = {}) =>
  f.evaluate(
    ({ marks, inside }) => {
      for (const a of document.getAnimations()) a.currentTime = 2000;
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
        if (!own.length) continue;
        const s = getComputedStyle(el);
        const em = Number.parseFloat(s.fontSize);
        // A clamp or an ellipsis is a cut the layout means; any other box that clips cuts the text.
        // A crawl slides through its window: the window's cut is meant too.
        const meant = (p: Element) =>
          getComputedStyle(p).webkitLineClamp !== 'none' || getComputedStyle(p).textOverflow === 'ellipsis' || Boolean(el.closest('.lk-crawl'));
        if (s.display !== 'inline' && clips(el) && !meant(el)) {
          if (el.scrollHeight > el.clientHeight + em / 2) found.push(`${name(el)} runs ${el.scrollHeight - el.clientHeight}px past its box`);
          if (el.scrollWidth > el.clientWidth + 1) found.push(`${name(el)} runs ${el.scrollWidth - el.clientWidth}px wide`);
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
            if (!meant(p) && (b.b - c.b > em / 2 || c.t - b.t > em / 2 || b.r - c.r > 1 || c.l - b.l > 1)) found.push(`${name(el)} is cut by ${name(p)}`);
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
          if (top && over && !el.contains(top) && !top.contains(el) && x >= over.left && x <= over.right && y >= over.top && y <= over.bottom)
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
      if (marks) for (const el of document.querySelectorAll(marks)) texts.push({ el, boxes: [...el.getClientRects()].map(box) });
      for (let i = 0; i < texts.length; i++)
        for (let j = i + 1; j < texts.length; j++) {
          const [a, b] = [texts[i]!, texts[j]!];
          // One element inside the other, or two runs of one sentence.
          if (a.el.contains(b.el) || b.el.contains(a.el) || a.el.parentElement === b.el.parentElement) continue;
          const meet = a.boxes.some((p) => b.boxes.some((q) => Math.min(p.r, q.r) - Math.max(p.l, q.l) > 1 && Math.min(p.b, q.b) - Math.max(p.t, q.t) > 1));
          if (meet) found.push(`${name(a.el)} meets ${name(b.el)}`);
        }
      return [...new Set(found)];
    },
    { marks, inside },
  );

describe('room status (#199)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  const t = () => built.get('room-status')!;
  /** A booking `from` to `to` hours after NOW (15:00 UTC, the screen's zone), as the calendar feed writes it. */
  const booking = (title: string, from: number, to: number, organizer = '') => ({ title, start: at(from), end: at(to), allDay: false, organizer });
  const today = [booking('Stand-up', -5, -4.5), booking('Design review', 0.5, 1.5, 'Priya Shah'), booking('Hiring sync', 2, 2.5)];

  /** One frame at a screen's own size; `show` inits it with the template's defaults under `data` and waits for ready. */
  async function room(orientation: Orientation = 'landscape') {
    const hst = await host(orientation, true);
    await hst.open('fresh', t().html);
    let inits = 0;
    return {
      hst,
      async show(data: Data, theme?: FrameTheme, now = NOW, timezone = 'UTC') {
        await hst.init('fresh', spotData(t().manifest, data), {}, now, theme, false, 8000, timezone);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.page.mainFrame().childFrames()[0]!;
      },
    };
  }

  /** What the room says: its state, the status word, how long, the line under it and the schedule's place holder. */
  const says = (f: Frame) =>
    f.evaluate(() => {
      const text = (sel: string) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
      return {
        state: document.querySelector<HTMLElement>('.stage')!.dataset.state,
        word: text('.word'),
        for: text('.for'),
        line: text('.line'),
        org: text('.org'),
        next: text('.next'),
        freeDay: text('.free-day'),
        allDay: text('.allday'),
      };
    });

  it('works out free or busy, until when and for how long from the screen clock', async () => {
    const r = await room();
    const seen: Record<string, unknown> = {};
    const cases: [string, Data][] = [
      ['between meetings', { events: today }],
      ['in a meeting', { events: [booking('Design review', -0.25, 0.75, 'Priya Shah'), booking('Hiring sync', 2, 2.5)], showOrganiser: true }],
      // A corridor screen names no one unless the spot asks.
      ['in a meeting, the organiser left off', { events: [booking('Design review', -0.25, 0.75, 'Priya Shah')] }],
      // Busy until the last of meetings that follow straight on.
      ['in back-to-back meetings', { events: [booking('Design review', -0.25, 0.75), booking('Hiring sync', 0.75, 1.5), booking('Retro', 3, 3.5)] }],
      // With the next meeting not shown, the time left still says where it runs to.
      [
        'in back-to-back meetings, the next one off',
        { events: [booking('Design review', -0.25, 0.75), booking('Hiring sync', 0.75, 1.5), booking('Retro', 3, 3.5)], showNext: false },
      ],
      ['after the last meeting', { events: [booking('Stand-up', -5, -4.5)] }],
      ['with no events', { events: [] }],
      ['with only tomorrow booked', { events: [booking('Retro', 20, 21)] }],
      [
        'on a day with an all-day event',
        { events: [{ title: 'Offsite', start: '2026-11-17', end: '2026-11-18', allDay: true, organizer: '' }, booking('Hiring sync', 2, 2.5)] },
      ],
      // The note stays when the schedule is off: "Available" alone would hide it.
      [
        'with the schedule off on a day with an all-day event',
        { events: [{ title: 'Closed for cleaning', start: '2026-11-17', end: '2026-11-18', allDay: true, organizer: '' }], showSchedule: false },
      ],
    ];
    for (const [name, data] of cases) seen[name] = await says(await r.show({ look: 'corporate', ...data }));
    expect(seen).toEqual({
      'between meetings': {
        state: 'free',
        word: 'Available',
        for: 'Free for 30 min',
        line: 'Free until 3:30 PM, then Design review',
        org: null,
        next: null,
        freeDay: null,
        allDay: null,
      },
      'in a meeting': {
        state: 'busy',
        word: 'In use',
        for: 'Left, until 3:45 PM 45 min',
        line: 'Until 3:45 PM · Design review',
        org: 'Booked by Priya Shah',
        next: 'Next at 5:00 PM: Hiring sync',
        freeDay: null,
        allDay: null,
      },
      'in a meeting, the organiser left off': {
        state: 'busy',
        word: 'In use',
        for: 'Left, until 3:45 PM 45 min',
        line: 'Until 3:45 PM · Design review',
        org: null,
        next: null,
        freeDay: null,
        allDay: null,
      },
      'in back-to-back meetings': {
        state: 'busy',
        word: 'In use',
        for: 'Left, until 4:30 PM 1 hr 30 min',
        line: 'Until 3:45 PM · Design review',
        org: null,
        next: 'Next at 3:45 PM: Hiring sync',
        freeDay: null,
        allDay: null,
      },
      'in back-to-back meetings, the next one off': {
        state: 'busy',
        word: 'In use',
        for: 'Left, until 4:30 PM 1 hr 30 min',
        line: 'Until 3:45 PM · Design review',
        org: null,
        next: null,
        freeDay: null,
        allDay: null,
      },
      'after the last meeting': {
        state: 'free',
        word: 'Available',
        for: null,
        line: 'Nothing else booked today',
        org: null,
        next: null,
        freeDay: 'Free for the rest of the day',
        allDay: null,
      },
      'with no events': {
        state: 'free',
        word: 'Available',
        for: null,
        line: 'Nothing booked today',
        org: null,
        next: null,
        freeDay: 'Free all day',
        allDay: null,
      },
      'with only tomorrow booked': {
        state: 'free',
        word: 'Available',
        for: null,
        line: 'Nothing booked today',
        org: null,
        next: null,
        freeDay: 'Free all day',
        allDay: null,
      },
      'on a day with an all-day event': {
        state: 'free',
        word: 'Available',
        for: 'Free for 2 hr',
        line: 'Free until 5:00 PM, then Hiring sync',
        org: null,
        next: null,
        freeDay: null,
        allDay: 'All day: Offsite',
      },
      'with the schedule off on a day with an all-day event': {
        state: 'free',
        word: 'Available',
        for: null,
        line: 'Nothing booked today',
        org: null,
        next: null,
        freeDay: null,
        allDay: 'All day: Closed for cleaning',
      },
    });
  });

  /** A booking between two instants, as the feed writes it. */
  const between = (title: string, start: string, end: string) => ({ title, start, end, allDay: false, organizer: '' });
  /** Days in New York across a change of clocks and across midnight, each at the time it is told. */
  const zoned: [name: string, now: string, events: Data[]][] = [
    // 1:30 EDT on the day the clocks go back, a meeting at 1:15 EST: 45 minutes away, not 15 before.
    ['the clocks going back', '2026-11-01T05:30:00Z', [between('Night shift', '2026-11-01T06:15:00Z', '2026-11-01T07:00:00Z')]],
    // 1:50 EST on the day they go forward, a meeting at 3:10 EDT: 20 minutes away.
    ['the clocks going forward', '2026-03-08T06:50:00Z', [between('Early start', '2026-03-08T07:10:00Z', '2026-03-08T08:00:00Z')]],
    // 23:30, in a meeting from 22:30 to 1:00 tomorrow.
    ['a meeting into tomorrow', '2026-11-18T04:30:00Z', [between('Late shift', '2026-11-18T03:30:00Z', '2026-11-18T06:00:00Z')]],
    // 0:30, in a meeting from 23:00 yesterday to 1:30.
    ['a meeting from yesterday', '2026-11-18T05:30:00Z', [between('Late shift', '2026-11-18T04:00:00Z', '2026-11-18T06:30:00Z')]],
  ];

  it('counts across a change of clocks and across midnight in the screen zone', async () => {
    const r = await room();
    const seen: Record<string, unknown> = {};
    for (const [name, now, events] of zoned) {
      const { line, for: left } = await says(await r.show({ look: 'corporate', events }, undefined, Date.parse(now), 'America/New_York'));
      seen[name] = { line, left };
    }
    expect(seen).toEqual({
      'the clocks going back': { line: 'Free until 1:15 AM, then Night shift', left: 'Free for 45 min' },
      'the clocks going forward': { line: 'Free until 3:10 AM, then Early start', left: 'Free for 20 min' },
      'a meeting into tomorrow': { line: 'Until 1:00 AM · Late shift', left: 'Left, until 1:00 AM 1 hr 30 min' },
      'a meeting from yesterday': { line: 'Until 1:30 AM · Late shift', left: 'Left, until 1:30 AM 1 hr' },
    });
  });

  /** Copy at its longest: the room and floor at their maxLength, and titles and an organiser longer than any feed sends often. */
  const long = 'Quarterly planning with the North region store managers, the regional finance team and the new hires from the spring intake, with lunch';
  const longest = { room: 'Conference room on the north wing', floor: 'Mezzanine, west' };
  const days: [string, Data][] = [
    ['free', { ...longest, events: [booking('Stand-up', -5, -4.5), booking(long, 0.5, 1.5, 'Priya Shah'), booking(long, 2, 2.5), booking('Booked', 3, 3.25)] }],
    [
      'busy',
      {
        ...longest,
        events: [
          booking('Stand-up', -5, -4.5),
          booking(long, -0.25, 0.75, 'Maximiliana Featherstonehaugh-Vandermolen of the Regional Planning Office'),
          booking(long, 0.75, 1.5),
          ...Array.from({ length: 8 }, (_, i) => booking(`Interview ${i + 1}`, 1.5 + i * 0.25, 1.75 + i * 0.25)),
        ],
      },
    ],
    // A double-booked room: a meeting inside the one on now, and two later that overlap.
    [
      'overlapping',
      {
        ...longest,
        events: [booking(long, -0.5, 1, 'Priya Shah'), booking('Interview', 0, 0.5), booking('Hiring sync', 1, 2), booking('Vendor demo', 1.25, 2.5)],
      },
    ],
    ['empty', { ...longest, events: [] }],
  ];
  const toggles = ['showSchedule', 'showNext', 'showClock', 'showFacts', 'showNowLine', 'showOrganiser'];
  const allOn: Data = Object.fromEntries(toggles.map((t) => [t, true]));
  const allOff: Data = Object.fromEntries(toggles.map((t) => [t, false]));
  /** Every toggle on, each one off on its own, and all of them off. */
  const toggleSets: Data[] = [allOn, ...toggles.map((t) => ({ ...allOn, [t]: false })), allOff];

  /** The layout's faults, the now line and Pop's pin counted as text, and a schedule drawn empty. */
  const roomFaults = async (f: Frame) => [
    ...(await faults(f, { marks: '.nowline, .pin-pill' })),
    ...(await f.evaluate(() => {
      const schedule = document.querySelector('.schedule');
      return schedule && !schedule.querySelector('.item, .block, .free-day') ? ['an empty schedule'] : [];
    })),
  ];

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text fits and nothing overlaps, the now line included, in every look and toggle, ${orientation}`, async () => {
      const r = await room(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const [day, data] of days)
          for (const set of toggleSets) {
            const off =
              Object.keys(set)
                .filter((k) => !set[k])
                .join(', ') || 'all on';
            for (const fault of await roomFaults(await r.show({ look, ...data, ...set }))) found.push(`${look}, ${day}, ${off}: ${fault}`);
          }
      // The timeline's hours across a change of clocks and from midnight.
      for (const look of looks)
        for (const [day, now, events] of zoned)
          for (const fault of await roomFaults(await r.show({ look, ...allOn, events }, undefined, Date.parse(now), 'America/New_York')))
            found.push(`${look}, ${day}: ${fault}`);
      expect(found).toEqual([]);
    }, 300_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const r = await room(orientation);
      const found: string[] = [];
      for (const [kit, theme] of noDemoAndLight(LIGHT_KIT))
        for (const look of looks)
          for (const [day, data] of days)
            for (const set of day === 'empty' ? [allOn] : [allOn, allOff]) {
              const f = await r.show({ look, ...data, ...set }, theme);
              for (const l of await paintedContrast(r.hst.page, f, '.stage')) found.push(`${look}, ${kit}, ${day}${set === allOff ? ', all off' : ''}: ${l}`);
            }
      expect(found).toEqual([]);
    }, 300_000);

  it('marks each toggle on the root, removes what is off, and steps the type up into a screen without the schedule', async () => {
    const r = await room();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['schedule', 'next', 'clock', 'facts', 'now-line', 'organiser'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.schedule', '.next', '.clock', '.facts', '.nowline, .pin, .bar', '.org'].filter((s) => document.querySelector(s)),
        line: Number.parseFloat(getComputedStyle(document.querySelector('.line .title')!).fontSize),
      }));
    const busy = { events: [booking('Design review', -0.25, 0.75, 'Priya Shah'), booking('Hiring sync', 2, 2.5)] };
    for (const look of looks) {
      const on = await read(await r.show({ look, ...busy, ...allOn }));
      const off = await read(await r.show({ look, ...busy, ...allOff }));
      expect(on.marks, look).toEqual(['schedule=on', 'next=on', 'clock=on', 'facts=on', 'now-line=on', 'organiser=on']);
      expect(on.present, look).toEqual(['.schedule', '.next', '.clock', '.facts', '.nowline, .pin, .bar', '.org']);
      expect(off.marks, look).toEqual(['schedule=off', 'next=off', 'clock=off', 'facts=off', 'now-line=off', 'organiser=off']);
      expect(off.present, look).toEqual([]);
      const step = Number(await (await r.show({ look })).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lk-step')));
      expect(off.line / on.line, look).toBeCloseTo(step, 2);
    }
  });

  it('shows the time from the screen clock, in 12 or 24 hours', async () => {
    const r = await room();
    const clock = async (data: Data) => (await r.show(data)).evaluate(() => document.querySelector('.time')!.textContent);
    expect(await clock({})).toBe('3:00 PM');
    expect(await clock({ hour24: true })).toBe('15:00');
  });

  it('every element has an intro and an outro timed from --sf-duration, moving only transform and opacity, within the cap', async () => {
    const r = await room();
    const durationMs = 11_000;
    const full = { events: Array.from({ length: 25 }, (_, i) => booking(`Slot ${i}`, -6 + i * 0.5, -5.75 + i * 0.5)) };
    for (const look of looks) {
      await r.hst.init('fresh', spotData(t().manifest, { look, ...full }), {}, NOW, undefined, false, durationMs);
      await r.hst.waitFor('fresh', 'ready', looks.indexOf(look) + 1);
      const f = r.hst.page.mainFrame().childFrames()[0]!;
      const seen = await f.evaluate((durationMs) => {
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
          if (ends.length && !ends.includes(durationMs)) unended.push(el.className);
        }
        return { props: [...props].sort(), moving: moving.size, unended };
      }, durationMs);
      expect(seen.props, look).toEqual(['opacity', 'transform']);
      expect(seen.moving, look).toBeLessThanOrEqual(50);
      expect(seen.unended, look).toEqual([]);
    }
  });

  it('with reduced motion, shows the final frame with nothing animating', async () => {
    const r = await room();
    await r.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const look of looks) {
      const f = await r.show({ look, events: today });
      await r.hst.post('fresh', 'play');
      expect(await f.evaluate(() => document.getAnimations().length), look).toBe(0);
    }
  });
});

describe('info frame (#201)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  const t = () => built.get('info-frame')!;
  const demo: FrameTheme = { colors: DEMO_KIT, shape: 'soft', fonts: {} };
  const headlines = (n: number, title: string) => Array.from({ length: n }, (_, i) => ({ title: `${title} ${i + 1}`, published: '', source: '' }));
  const news = { items: headlines(3, 'Council approves the riverside park') };
  /** Every text field at its `maxLength`, figures at their widest, and headlines longer than feeds send. */
  const sentence = 'Any large coffee with a fresh almond croissant or a cinnamon bun, at all six Harbor stores, while they last. ';
  const longest: Data = {
    captionTitle: sentence.slice(0, 64),
    captionLine: sentence.slice(0, 80),
    price: '$1,299.9',
    city: 'Llanfairpwllgwyngyllgogo',
    crawlLabel: 'Neighborhood',
    temp: -104,
    high: 118,
    low: -100,
    code: 95,
    ...Object.fromEntries(
      [1, 2, 3].flatMap((i) => [
        [`day${i}High`, 118],
        [`day${i}Low`, -100],
        [`day${i}Code`, 85],
      ]),
    ),
    items: headlines(30, sentence.repeat(2).slice(0, 190)),
  };

  /**
   * One frame at a screen's own size; `show` inits it with the template's defaults under `data`, a
   * photo, and the demo kit with a logo unless `theme` says otherwise, and waits for ready.
   */
  async function frame(orientation: Orientation = 'landscape') {
    const hst = await host(orientation, true);
    await hst.open('fresh', t().html);
    let inits = 0;
    return {
      hst,
      async show(data: Data, theme: FrameTheme | null = demo, now = NOW, timezone = 'UTC') {
        await hst.init('fresh', spotData(t().manifest, data), { photo: '#963', '$brand.logo': '#fff' }, now, theme ?? undefined, false, 15_000, timezone);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.page.mainFrame().childFrames()[0]!;
      },
    };
  }

  const toggles = ['showClock', 'showWeather', 'showForecast', 'showCaption', 'showLogo'];
  /** Every rail, crawl and toggle setting: 3 × 3 × 32. */
  const settings: Data[] = ['right', 'left', 'off'].flatMap((rail) =>
    ['bottom', 'top', 'off'].flatMap((ticker) =>
      Array.from({ length: 32 }, (_, bits) => ({ rail, ticker, ...Object.fromEntries(toggles.map((k, i) => [k, Boolean(bits & (1 << i))])) })),
    ),
  );
  const named = (set: Data) =>
    [`rail ${set.rail}`, `crawl ${set.ticker}`, ...toggles.filter((k) => !set[k]).map((k) => `${k.slice(4).toLowerCase()} off`)].join(', ');
  /** Faults of the layout: the logo and the weather glyphs count as text, and every text stays on its card. */
  const layoutFaults = (f: Frame) => faults(f, { marks: '.logo, .glyph', inside: '.card' });

  for (const orientation of ['landscape', 'portrait'] as const)
    for (const look of looks)
      it(`${look}, ${orientation}: in every rail, crawl and toggle setting, at the longest copy, every text fits and nothing overlaps`, async () => {
        const r = await frame(orientation);
        const found: string[] = [];
        for (const set of settings) for (const fault of await layoutFaults(await r.show({ look, ...longest, ...set }))) found.push(`${named(set)}: ${fault}`);
        expect(found).toEqual([]);
      }, 600_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`the defaults fit at the look's own size, nothing shrunk, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, ...news });
        for (const fault of await layoutFaults(f)) found.push(`${look}: ${fault}`);
        const shrunk = await f.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[style*="--if-"]')]
            .filter((el) => ['--if-fit', '--if-title-fit'].some((v) => el.style.getPropertyValue(v) && Number(el.style.getPropertyValue(v)) !== 1))
            .map((el) => el.className),
        );
        for (const el of shrunk) found.push(`${look}: ${el} is shrunk`);
      }
      expect(found).toEqual([]);
    }, 120_000);

  /** Each rail and crawl place with everything on, the chip and the corner logo, each toggle off alone, and all off. */
  const contrastSets: Data[] = [
    { rail: 'right', ticker: 'bottom' },
    { rail: 'left', ticker: 'top' },
    { rail: 'off', ticker: 'bottom' },
    ...toggles.map((k) => ({ rail: 'right', ticker: 'bottom', [k]: false })),
    { rail: 'right', ticker: 'bottom', ...Object.fromEntries(toggles.map((k) => [k, false])) },
  ];
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look and layout, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const [kit, theme] of noDemoAndLight(LIGHT_KIT))
        for (const look of looks)
          for (const set of contrastSets) {
            const f = await r.show({ look, ...news, ...set }, theme ?? null);
            for (const l of await paintedContrast(r.hst.page, f, '.stage'))
              found.push(`${look}, ${kit}, ${named({ ...Object.fromEntries(toggles.map((k) => [k, true])), ...set })}: ${l}`);
          }
      expect(found).toEqual([]);
    }, 600_000);

  it("keeps the canvas's rules: a logo-only rail is dropped, the clock and the weather go onto the photo without one, and type grows into what is left", async () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      const r = await frame(orientation);
      const read = (f: Frame) =>
        f.evaluate(() => {
          const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
          const size = (sel: string) => Number.parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);
          return {
            rail: document.documentElement.dataset.rail,
            ticker: document.documentElement.dataset.ticker,
            parts: ['.rail', '.rail-logo', '.chip', '.chip-time', '.chip-weather', '.corner-logo', '.ticker', '.forecast', '.caption'].filter((s) =>
              document.querySelector(s),
            ),
            clock: document.querySelector('.rail-time') ? size('.rail-time') : 0,
            temp: document.querySelector('.now .temp-now') ? size('.now .temp-now') : 0,
            railAt: box('.rail') && { x: box('.rail')!.x - box('.panel')!.x, y: box('.rail')!.y - box('.panel')!.y },
            tickerAbove: box('.ticker') ? box('.ticker')!.y < box('.main')!.y : undefined,
          };
        });
      for (const look of looks) {
        const where = `${look}, ${orientation}`;
        const all = await read(await r.show({ look, ...news }));
        expect(all, where).toMatchObject({
          rail: 'right',
          ticker: 'bottom',
          parts: ['.rail', '.rail-logo', '.ticker', '.forecast', '.caption'],
          tickerAbove: false,
        });
        // The rail is after the photo: to its right in landscape, under it in portrait. Left is before it.
        expect(orientation === 'landscape' ? all.railAt!.x > 0 : all.railAt!.y > 0, where).toBe(true);
        const left = await read(await r.show({ look, ...news, rail: 'left', ticker: 'top' }));
        expect(orientation === 'landscape' ? left.railAt!.x < 0 : left.railAt!.y < 0, where).toBe(true);
        expect(left.tickerAbove, where).toBe(true);
        expect((await read(await r.show({ look, ...news, showClock: false, showWeather: false }))).parts, `${where}, logo only`).toEqual([
          '.corner-logo',
          '.ticker',
          '.caption',
        ]);
        expect((await read(await r.show({ look, ...news, rail: 'off' }))).parts, `${where}, rail off`).toEqual([
          '.chip',
          '.chip-time',
          '.chip-weather',
          '.corner-logo',
          '.ticker',
          '.caption',
        ]);
        expect((await read(await r.show({ look, ...news, rail: 'off', showWeather: false }))).parts, `${where}, rail off`).toEqual([
          '.chip',
          '.chip-time',
          '.corner-logo',
          '.ticker',
          '.caption',
        ]);
        // No headlines, or no kit logo: what is empty is off.
        expect((await read(await r.show({ look, ticker: 'top' }, null))).parts, `${where}, nothing to crawl`).toEqual(['.rail', '.forecast', '.caption']);
        expect((await read(await r.show({ look, ...news, ticker: 'off' }))).ticker, where).toBe('off');
        expect((await read(await r.show({ look, ...news, showForecast: false }))).temp, `${where}: the weather grows without the forecast`).toBeGreaterThan(
          all.temp,
        );
        expect((await read(await r.show({ look, ...news, showWeather: false }))).clock, `${where}: the clock grows without the weather`).toBeGreaterThan(
          all.clock,
        );
      }
    }
  }, 300_000);

  it('marks each toggle on the root and removes what is off', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['clock', 'weather', 'forecast', 'caption', 'logo'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.rail-time', '.weather', '.forecast', '.caption', '.logo'].filter((s) => document.querySelector(s)),
      }));
    for (const look of looks) {
      expect(await read(await r.show({ look, ...news })), look).toEqual({
        marks: ['clock=on', 'weather=on', 'forecast=on', 'caption=on', 'logo=on'],
        present: ['.rail-time', '.weather', '.forecast', '.caption', '.logo'],
      });
      expect(await read(await r.show({ look, ...news, showClock: false, showForecast: false, showCaption: false, showLogo: false })), look).toEqual({
        marks: ['clock=off', 'weather=on', 'forecast=off', 'caption=off', 'logo=off'],
        present: ['.weather'],
      });
    }
  });

  it('shows the time and date from the screen clock, in 12 or 24 hours, and the next three days from its zone', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        time: document.querySelector('.rail-time .time')!.textContent,
        ap: document.querySelector('.rail-time .ap')?.textContent ?? null,
        date: document.querySelector('.date')!.textContent,
        days: [...document.querySelectorAll('.dname')].map((d) => d.textContent),
      }));
    expect(await read(await r.show({ look: 'pop' }))).toEqual({ time: '3:00', ap: null, date: 'Tuesday, November 17', days: ['Wed', 'Thu', 'Fri'] });
    expect(await read(await r.show({ look: 'corporate' }))).toEqual({ time: '3:00', ap: 'PM', date: 'Tuesday, November 17', days: ['Wed', 'Thu', 'Fri'] });
    expect(await read(await r.show({ look: 'corporate', hour24: true }))).toEqual({
      time: '15:00',
      ap: '',
      date: 'Tuesday, November 17',
      days: ['Wed', 'Thu', 'Fri'],
    });
    expect(await read(await r.show({ look: 'night', hour24: true }))).toEqual({ time: '15:00', ap: null, date: 'Tue, Nov 17', days: ['Wed', 'Thu', 'Fri'] });
    // 22:30 on Tuesday in New York, then 0:30 on Wednesday: the days follow the screen's zone, not UTC's.
    const ny = (at: string) => r.show({ look: 'pop', hour24: true }, demo, Date.parse(at), 'America/New_York');
    expect(await read(await ny('2026-11-18T03:30:00Z'))).toEqual({ time: '22:30', ap: null, date: 'Tuesday, November 17', days: ['Wed', 'Thu', 'Fri'] });
    expect(await read(await ny('2026-11-18T05:30:00Z'))).toEqual({ time: '00:30', ap: null, date: 'Wednesday, November 18', days: ['Thu', 'Fri', 'Sat'] });
  });

  it('turns the minute with the screen clock, writing the time at most once a second', async () => {
    const hst = await host('landscape', true);
    // The frame's clock is Playwright's, stepped by hand: no test time passes on its own.
    await hst.page.clock.install({ time: NOW });
    await hst.page.clock.pauseAt(NOW);
    await hst.open('fresh', t().html);
    // 15:00:59.5 on the screen.
    await hst.init('fresh', spotData(t().manifest, { look: 'corporate', ...news }), { photo: '#963' }, NOW + 59_500, undefined, false, 300_000);
    const f = hst.page.mainFrame().childFrames()[0]!;
    const ready = async () => (await hst.page.evaluate(() => (window as unknown as { msgs: Record<string, string[]> }).msgs.fresh!)).includes('ready');
    for (let i = 0; i < 500 && !(await ready()); i++) await hst.page.clock.runFor(16);
    expect(await f.evaluate(() => document.querySelector('.rail-time .time')!.textContent)).toBe('3:00');
    await hst.post('fresh', 'play');
    await f.evaluate(() => {
      const w = window as unknown as { writes: number };
      w.writes = 0;
      new MutationObserver((m) => (w.writes += m.length)).observe(document.querySelector('.rail-time')!, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    const step = async (ms: number) => {
      await hst.page.clock.runFor(ms);
      return f.evaluate(() => [document.querySelector('.rail-time .time')!.textContent, (window as unknown as { writes: number }).writes]);
    };
    // The minute turns half a second in; then nothing until the next one, a minute on.
    expect(await step(600)).toEqual(['3:01', 1]);
    expect(await step(59_000)).toEqual(['3:01', 1]);
    expect(await step(1_000)).toEqual(['3:02', 2]);
  });

  it('names the weather from its code, day and night, and each look draws the forecast its way', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        line: document.querySelector('.wline')!.textContent,
        cond: document.querySelector('.cond')?.textContent ?? null,
        glyph: Boolean(document.querySelector('.now .glyph svg')),
        days: [...document.querySelectorAll('.day')].map((d) => d.textContent),
      }));
    const week = { day1Code: 0, day2Code: 63, day3Code: 75 };
    expect(await read(await r.show({ look: 'pop', ...week }))).toEqual({
      line: 'Partly cloudy · H 78° L 61°',
      cond: null,
      glyph: true,
      days: ['Wed75°60°', 'Thu70°57°', 'Fri73°58°'],
    });
    expect(await read(await r.show({ look: 'poster', code: 0, isDay: 0, ...week }))).toEqual({
      line: 'High 78° · low 61° · Atlanta',
      cond: 'Clear night',
      glyph: false,
      days: ['WedClear75° / 60°', 'ThuRain70° / 57°', 'FriSnow73° / 58°'],
    });
    expect(await read(await r.show({ look: 'night', code: 95, ...week }))).toEqual({
      line: 'Thunderstorm · h78 l61',
      cond: null,
      glyph: true,
      days: ['Wed75°', 'Thu70°', 'Fri73°'],
    });
    expect(await read(await r.show({ look: 'corporate', code: 71, ...week }))).toEqual({
      line: 'Snow · High 78° · Low 61°',
      cond: null,
      glyph: true,
      days: ['Wed75°60°', 'Thu70°57°', 'Fri73°58°'],
    });
  });

  it('crawls every headline at the look speed times the spot speed', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => {
        const strip = document.querySelector<HTMLElement>('.lk-crawl')!;
        return { s: Number.parseFloat(strip.style.getPropertyValue('--lk-crawl-s')), text: strip.firstElementChild!.textContent };
      });
    const normal = await read(await r.show({ look: 'poster', ...news }));
    expect(normal.text).toBe('Council approves the riverside park 1  —  Council approves the riverside park 2  —  Council approves the riverside park 3');
    expect((await read(await r.show({ look: 'poster', ...news, crawlSpeed: 'slow' }))).s / normal.s).toBeCloseTo(1 / 0.7, 2);
    expect((await read(await r.show({ look: 'poster', ...news, crawlSpeed: 'fast' }))).s / normal.s).toBeCloseTo(1 / 1.4, 2);
  });

  it("keeps Poster's photo unpainted until play, under its ink block, and every other look's painted at ready", async () => {
    const r = await frame();
    const hidden = (f: Frame) => f.evaluate(() => getComputedStyle(document.querySelector('.photo')!).visibility === 'hidden');
    for (const look of looks) expect(await hidden(await r.show({ look })), look).toBe(look === 'poster');
    const f = await r.show({ look: 'poster' });
    await r.hst.post('fresh', 'play');
    await f.waitForFunction(() => getComputedStyle(document.querySelector('.photo')!).visibility === 'visible');
  });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every element has an intro and an outro timed from --sf-duration, moving only transform and opacity, within the cap; in ${orientation}, ${orientation === 'portrait' ? 'only the crawl loops' : 'the ambient motion loops'}`, async () => {
      const r = await frame(orientation);
      const durationMs = 13_000;
      for (const [i, look] of looks.entries()) {
        await r.hst.init('fresh', spotData(t().manifest, { look, ...longest }), { photo: '#963', '$brand.logo': '#fff' }, NOW, demo, false, durationMs);
        await r.hst.waitFor('fresh', 'ready', i + 1);
        const f = r.hst.page.mainFrame().childFrames()[0]!;
        const seen = await f.evaluate((durationMs) => {
          const props = new Set<string>();
          const moving = new Set<Element>();
          const looping = new Set<string>();
          const unended: string[] = [];
          for (const a of document.getAnimations()) {
            const effect = a.effect as KeyframeEffect;
            for (const k of effect.getKeyframes())
              for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
            moving.add(effect.target!);
            if (effect.getComputedTiming().iterations === Number.POSITIVE_INFINITY) looping.add(effect.target!.className);
          }
          for (const el of document.querySelectorAll('.lk-text, .lk-fade, .lk-badge, .lk-photo, .lk-cover, .lk-draw')) {
            const ends = el.getAnimations().map((a) => Math.round(a.effect!.getComputedTiming().endTime as number));
            if (ends.length && !ends.includes(durationMs)) unended.push(el.className);
          }
          return { props: [...props].sort(), moving: moving.size, looping: [...looping].sort(), unended };
        }, durationMs);
        expect(seen.props, look).toEqual(['opacity', 'transform']);
        expect(seen.moving, look).toBeLessThanOrEqual(50);
        expect(seen.unended, look).toEqual([]);
        if (orientation === 'portrait') expect(seen.looping, look).toEqual(['lk-crawl']);
        else expect(seen.looping.length, look).toBeGreaterThan(1);
      }
    });

  it('with reduced motion, shows the final frame with nothing animating, the crawl one line', async () => {
    const r = await frame();
    await r.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const look of looks) {
      const f = await r.show({ look, ...news });
      await r.hst.post('fresh', 'play');
      expect(await f.evaluate(() => document.getAnimations().length), look).toBe(0);
    }
  });
});
