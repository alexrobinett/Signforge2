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
import jsQR from 'jsqr';
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
  announcement: {
    a: { look: 'pop', showFacts: false },
    b: { look: 'night', qrUrl: 'https://example.com/plan', facts: [{ label: 'When', value: 'Monday' }] },
    assetsA: { photo: '#963' },
    assetsB: { photo: '#369' },
  },
  clock: { a: { greeting: 'Welcome', message: 'Doors open at 6', seconds: true }, b: { hour24: true } },
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

/** A light kit whose accent is the default palette's amber, which reads on dark only. */
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
   * With `logo`, the theme carries a 4x1 logo of that colour.
   */
  init(
    frame: string,
    data: Data,
    assets?: Record<string, string>,
    now?: number,
    theme?: FrameTheme,
    sampled?: boolean | 'broken',
    durationMs?: number,
    logo?: string,
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
    async init(frame, data, assets = {}, now = NOW, theme, sampled = false, durationMs = 8000, logo) {
      const samples = sampled ? Object.fromEntries(Object.keys(assets).map((field) => [field, sampleAsset(field)])) : {};
      const broken = sampled === 'broken';
      await page.evaluate(
        async ({ frame, data, assets, samples, broken, sf, now, theme, orientation, size, durationMs, logo }) => {
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
          let logoPng: Blob | undefined;
          if (logo) {
            const c = document.createElement('canvas');
            [c.width, c.height] = [4, 1];
            const g = c.getContext('2d')!;
            g.fillStyle = logo;
            g.fillRect(0, 0, 4, 1);
            logoPng = await png(c);
          }
          const init = {
            sf,
            type: 'init',
            data,
            assets: blobs,
            durationMs,
            orientation,
            viewport: size,
            timezone: 'UTC',
            locale: 'en-US',
            clock: { now, offsetMs: now - Date.now() },
            theme: theme && logoPng ? { ...theme, logo: { onDark: logoPng } } : theme,
          };
          w.frames_[frame]!.contentWindow!.postMessage(init, '*');
        },
        { frame, data, assets, samples, broken, sf, now, theme, orientation, size, durationMs, logo },
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
        for (let y = t.rect.y; y < t.rect.y + t.rect.h; y++)
          for (let x = t.rect.x; x < t.rect.x + t.rect.w; x++) {
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

/**
 * One frame of `t` at a screen's own size; `play(data, theme)` inits it with `assets` and waits for
 * ready. The Pi shows 1080p at scale 1: at half that size, a 20 px label is 10 px, and Linux paints
 * the cores of its strokes lighter (the kit's Corporate meta line read 3.90:1 on CI's runner).
 */
async function screenFrame(t: { html: string; manifest: TemplateManifest }, orientation: Orientation, assets: Record<string, string>) {
  const hst = await host(orientation, true);
  await hst.open('fresh', t.html);
  let inits = 0;
  const frame = () => hst.page.mainFrame().childFrames()[0]!;
  return {
    hst,
    frame,
    async play(data: Data, theme?: FrameTheme, durationMs?: number, logo?: string) {
      await hst.init('fresh', spotData(t.manifest, data), assets, NOW, theme, false, durationMs, logo);
      await hst.waitFor('fresh', 'ready', ++inits);
      return frame();
    },
  };
}

describe('the look kit (#190)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  /** Each look's font families, as looks.css names them. */
  const faces: Record<(typeof looks)[number], string[]> = {
    pop: ['lk-pop', 'lk-body'],
    poster: ['lk-poster', 'lk-body'],
    night: ['lk-night', 'lk-night-mono', 'lk-body'],
    corporate: ['lk-corporate'],
  };
  const kits = noDemoAndLight(LIGHT_KIT);
  const photo = { photo: '#808080' };
  let t: { html: string; manifest: TemplateManifest };
  beforeAll(async () => {
    t = await buildTemplate(resolve(import.meta.dirname, '../../template-looks/looks-test'));
  }, 60_000);

  const kitFrame = (orientation: Orientation = 'landscape') => screenFrame(t, orientation, photo);

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

describe('announcement (#197)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  const kits = noDemoAndLight(LIGHT_KIT);
  const demo = kits[1]![1];
  const photo = { photo: '#808080' };
  const qrUrl = 'https://example.com/floor-plan';
  /** The kit's logo: only a kit with one shows it. */
  const logo = '#ff00ff';
  const t = () => built.get('announcement')!;
  /** Wide words, `n` characters: copy at a field's `maxLength`. */
  const words = (n: number) => 'Wwwwwww Wwwww '.repeat(30).slice(0, n);
  const long: Data = {
    eyebrow: 'W'.repeat(24),
    headline: words(80),
    body: words(280),
    meta: words(48),
    qrLabel: words(40),
    qrUrl: `https://example.com/${'w'.repeat(80)}`,
    facts: [1, 2, 3].map(() => ({ label: 'W'.repeat(16), value: words(32) })),
  };
  const toggles = ['Photo', 'Qr', 'Eyebrow', 'Body', 'Meta', 'Facts', 'Logo'];
  const allOff: Data = Object.fromEntries(toggles.map((n) => [`show${n}`, false]));
  /** Each toggle off alone, all off, and long copy (one unbroken word too) with the photo and without. */
  const variants: [string, Data][] = [
    ['all on', {}],
    ['long copy', long],
    ['long copy, photo off', { ...long, showPhoto: false }],
    ['an 80-letter word', { headline: 'W'.repeat(80) }],
    ...toggles.map((n): [string, Data] => [`${n.toLowerCase()} off`, { [`show${n}`]: false }]),
    ['all off', allOff],
    ['all off, long headline', { ...allOff, headline: long.headline }],
  ];

  /**
   * What is wrong with the layout at rest: a block off the screen, two blocks overlapping, text cut
   * sideways without an ellipsis, or clamped text showing more lines than its clamp.
   */
  const layoutProblems = (f: Frame) =>
    f.evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 3000;
      const out: string[] = [];
      const blocks = ['.eyebrow', '.logo', '.headline-box', '.body', '.facts', '.qr', '.meta', '.photo'].flatMap((sel) => {
        const el = document.querySelector(sel);
        return el ? [[sel, el.getBoundingClientRect()] as const] : [];
      });
      for (const [sel, r] of blocks)
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(`${sel} leaves the screen`);
      for (const [i, [a, ra]] of blocks.entries())
        for (const [b, rb] of blocks.slice(i + 1)) {
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 1 && h > 1) out.push(`${a} overlaps ${b}`);
        }
      for (const el of document.querySelectorAll<HTMLElement>('.stage :is(.pill, .headline, .body, dt, dd, .qr-label, .meta-in)')) {
        const s = getComputedStyle(el);
        const name = el.className || el.tagName;
        // By the glyphs' boxes: a space hanging past a right-aligned line's end widens scrollWidth but shows nothing.
        const text = document.createRange();
        text.selectNodeContents(el);
        const [g, box] = [text.getBoundingClientRect(), el.getBoundingClientRect()];
        if ((g.left < box.left - 1 || g.right > box.right + 1) && s.textOverflow !== 'ellipsis') out.push(`${name} is cut sideways`);
        const clamp = Number(s.getPropertyValue('-webkit-line-clamp'));
        const room = clamp * Number.parseFloat(s.lineHeight) + Number.parseFloat(s.paddingTop) + Number.parseFloat(s.paddingBottom);
        if (clamp && el.clientHeight > room + 1) out.push(`${name} shows more than its ${clamp} lines`);
      }
      return out;
    });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`nothing leaves the screen, overlaps or overflows its clamp, in every look and toggle, with long copy, ${orientation}`, async () => {
      const k = await screenFrame(t(), orientation, photo);
      const found: string[] = [];
      for (const look of looks)
        for (const [variant, data] of variants) {
          const f = await k.play({ look, qrUrl, ...data }, demo, undefined, logo);
          for (const p of await layoutProblems(f)) found.push(`${look}, ${variant}: ${p}`);
        }
      expect(found).toEqual([]);
    }, 180_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const k = await screenFrame(t(), orientation, photo);
      const found: string[] = [];
      for (const [kit, theme] of kits)
        for (const look of looks)
          for (const [variant, data] of [variants[0]!, ['photo and body off', { showPhoto: false, showBody: false }]] as const) {
            const f = await k.play({ look, qrUrl, ...data }, theme, undefined, logo);
            for (const l of await paintedContrast(k.hst.page, f, '.stage')) found.push(`${look}, ${kit}, ${variant}: ${l}`);
          }
      expect(found).toEqual([]);
    }, 180_000);

  it('marks each toggle on the root and removes what is off; the type steps up without the photo and the footer closes up without the QR code', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    const measure = (f: Frame) =>
      f.evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 3000;
        const root = document.documentElement;
        const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
        return {
          marks: ['photo', 'qr', 'eyebrow', 'body', 'meta', 'facts', 'logo'].map((m) => `${m}=${root.getAttribute(`data-${m}`)}`),
          present: ['.photo', '.qr', '.eyebrow', '.body', '.meta', '.facts', '.logo'].filter((s) => document.querySelector(s)),
          headline: Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize),
          headlineWidth: document.querySelector('.headline-box')!.getBoundingClientRect().width,
          footerTop: Math.min(top('.qr'), top('.meta')),
        };
      });
    for (const look of looks) {
      const on = await measure(await k.play({ look, qrUrl }, demo, undefined, logo));
      expect(on.marks, look).toEqual(['photo=on', 'qr=on', 'eyebrow=on', 'body=on', 'meta=on', 'facts=on', 'logo=on']);
      expect(on.present, look).toEqual(['.photo', '.qr', '.eyebrow', '.body', '.meta', '.facts', '.logo']);
      const off = await measure(await k.play({ look, qrUrl, ...allOff }, demo, undefined, logo));
      expect(off.marks, look).toEqual(['photo=off', 'qr=off', 'eyebrow=off', 'body=off', 'meta=off', 'facts=off', 'logo=off']);
      expect(off.present, look).toEqual([]);
      expect((await measure(await k.play({ look, qrUrl, showPhoto: false }))).headline, look).toBeGreaterThan(on.headline);
      const noQr = await measure(await k.play({ look, qrUrl, showQr: false }, demo, undefined, logo));
      // Night's code stands beside the headline, which takes its width; the others' sits in the footer, which closes up to the meta line.
      if (look === 'night') expect(noQr.headlineWidth, look).toBeGreaterThan(on.headlineWidth);
      else expect(noQr.footerTop, look).toBeGreaterThan(on.footerTop);
    }
  });

  it('leaves out what has nothing to show: no photo, no QR address, no logo in the kit, no facts, an empty line', async () => {
    const k = await screenFrame(t(), 'landscape', {});
    for (const look of looks) {
      const f = await k.play({ look, qrUrl: '', facts: [], eyebrow: '', body: '', meta: '' });
      const left = await f.evaluate(() => ({
        marks: ['photo', 'qr', 'eyebrow', 'body', 'meta', 'facts', 'logo'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.photo', '.qr', '.eyebrow', '.body', '.meta', '.facts', '.logo'].filter((s) => document.querySelector(s)),
      }));
      expect(left, look).toEqual({ marks: ['photo=off', 'qr=off', 'eyebrow=off', 'body=off', 'meta=off', 'facts=off', 'logo=off'], present: [] });
    }
  });

  it('the QR code is dark on white with its quiet zone in every look and kit, and reads back as its address', async () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      const k = await screenFrame(t(), orientation, photo);
      for (const [kit, theme] of kits)
        for (const look of looks) {
          const f = await k.play({ look, qrUrl: long.qrUrl }, theme);
          const { fills, clip } = await f.evaluate(() => {
            for (const a of document.getAnimations()) a.currentTime = 3000;
            const svg = document.querySelector('#qr svg')!;
            const r = svg.getBoundingClientRect();
            return {
              fills: [getComputedStyle(svg.querySelector('rect')!).fill, getComputedStyle(svg.querySelector('path')!).fill],
              clip: { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) },
            };
          });
          expect(fills, `${look}, ${kit}`).toEqual(['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
          const png = (await k.hst.page.screenshot({ clip })).toString('base64');
          const rgba = await k.hst.page.evaluate(async (png) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const g = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
            g.drawImage(img, 0, 0);
            return [...g.getImageData(0, 0, img.width, img.height).data];
          }, png);
          expect(jsQR(Uint8ClampedArray.from(rgba), clip.width, clip.height)?.data, `${look}, ${kit}, ${orientation}`).toBe(long.qrUrl);
        }
    }
  }, 120_000);

  it('every element has an intro and, timed from --sf-duration, an outro; only transform and opacity move, on fewer than 50 elements', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    const durationMs = 11_000;
    for (const look of looks) {
      const f = await k.play({ look, qrUrl }, demo, durationMs, logo);
      const m = await f.evaluate((durationMs) => {
        const props = new Set<string>();
        for (const a of document.getAnimations())
          for (const k of (a.effect as KeyframeEffect).getKeyframes())
            for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
        // Shown, and given a motion by the look: Poster's photo is uncovered by its ink block instead.
        const moving = [...document.querySelectorAll<HTMLElement>('.lk-text, .lk-fade, .lk-badge, .lk-photo, .lk-draw, .lk-cover')].filter(
          (el) => el.getClientRects().length && getComputedStyle(el).getPropertyValue('--lk-motion').trim() !== 'none',
        );
        const unmatched = moving.flatMap((el) => {
          const ends = el
            .getAnimations()
            .map((a) => Math.round(a.effect!.getComputedTiming().endTime as number))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
          return ends.length === 2 && ends[0]! <= 2000 && ends[1] === durationMs ? [] : [`${el.className}: ${ends.join(', ')}`];
        });
        return {
          props: [...props].sort(),
          unmatched,
          moving: moving.length,
          animated: new Set(document.getAnimations().map((a) => (a.effect as KeyframeEffect).target)).size,
        };
      }, durationMs);
      expect(m.props, look).toEqual(['opacity', 'transform']);
      expect(m.unmatched, look).toEqual([]);
      expect(m.moving, look).toBeGreaterThanOrEqual(10);
      expect(m.animated, look).toBeLessThanOrEqual(50);
    }
  });

  it('with reduced motion, shows the final frame with nothing animating', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    await k.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const look of looks) {
      const f = await k.play({ look, qrUrl }, demo, undefined, logo);
      await k.hst.post('fresh', 'play');
      const still = await f.evaluate(() => ({
        animations: document.getAnimations().length,
        hidden: [...document.querySelectorAll<HTMLElement>('.stage *')].filter((el) => getComputedStyle(el).opacity !== '1').map((el) => el.className),
      }));
      expect(still, look).toEqual({ animations: 0, hidden: [] });
    }
  });
});
