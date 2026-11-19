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
import { join, resolve } from 'node:path';
import type { Frame, Page } from 'playwright';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type BrandColors, type FieldDef, type FrameTheme, type TemplateManifest } from '@signforge/contract';
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
/** Two different sets of data per template; `assets` name a colour each image field is drawn in. */
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

const built = new Map<string, { html: string; manifest: TemplateManifest }>();
beforeAll(async () => {
  for (const name of names) built.set(name, await buildTemplate(join(templatesDir, name)));
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
  init(frame: string, data: Data, assets?: Record<string, string>, now?: number, theme?: FrameTheme): Promise<void>;
  post(frame: string, type: 'play' | 'reset'): Promise<void>;
  /** Wait until the frame has sent `type` `count` times in all. */
  waitFor(frame: string, type: string, count: number): Promise<void>;
  /** The frame's whole document, with object URLs (which differ per load) made equal. */
  dom(frame: string): Promise<string>;
}

async function host(): Promise<Host> {
  const page = await h.blankPage();
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
        ({ frame, html }) => {
          const w = window as unknown as { frames_: Record<string, HTMLIFrameElement>; msgs: Record<string, string[]> };
          const f = document.createElement('iframe');
          f.setAttribute('sandbox', 'allow-scripts');
          // Every frame on screen: Chromium throttles animation frames in an off-screen frame.
          f.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;border:0';
          w.frames_[frame] = f;
          w.msgs[frame] = [];
          f.srcdoc = html;
          document.body.appendChild(f);
        },
        { frame, html },
      );
      await waitFor(frame, 'loaded', 1);
    },
    async init(frame, data, assets = {}, now = NOW, theme) {
      await page.evaluate(
        async ({ frame, data, assets, sf, now, theme }) => {
          const w = window as unknown as { frames_: Record<string, HTMLIFrameElement> };
          const blobs: Record<string, Blob> = {};
          for (const [field, colour] of Object.entries(assets)) {
            const c = document.createElement('canvas');
            c.width = c.height = 8;
            const g = c.getContext('2d')!;
            g.fillStyle = colour;
            g.fillRect(0, 0, 8, 8);
            blobs[field] = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
          }
          const init = {
            sf,
            type: 'init',
            data,
            assets: blobs,
            durationMs: 8000,
            orientation: 'landscape',
            viewport: { width: 960, height: 540 },
            timezone: 'UTC',
            locale: 'en-US',
            clock: { now, offsetMs: now - Date.now() },
            theme,
          };
          w.frames_[frame]!.contentWindow!.postMessage(init, '*');
        },
        { frame, data, assets, sf, now, theme },
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

  /**
   * Each text in the forecast card that reads below AA (4.5:1, 3:1 for large text), measured from what
   * is painted: the card screenshotted with its text and again with the text hidden, at rest. Each
   * glyph pixel is compared with the pixel under it, so opacity on the text or a parent, and anything
   * drawn over the card, count. A text's ratio is its 90th-percentile pixel: the cores of its strokes,
   * not their anti-aliased edges. Text that leaves no pixel of its own reads at 1:1.
   */
  async function paintedContrast(page: Page, f: Frame): Promise<string[]> {
    const { card, texts } = await f.evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 2000;
      const box = document.querySelector('.info')!.getBoundingClientRect();
      const texts = [];
      for (const el of document.querySelectorAll<HTMLElement>('.info, .info *')) {
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
    });
    const withText = (await page.screenshot({ clip: card })).toString('base64');
    await f.evaluate(() => {
      const hide = document.createElement('style');
      hide.id = 'sf-test-hide';
      hide.textContent = '.info, .info * { color: transparent !important; text-shadow: none !important; }';
      document.head.append(hide);
    });
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
    const kits: [string, FrameTheme | undefined][] = [
      ['no kit', undefined],
      ['the demo kit', { colors: DEMO_KIT, shape: 'soft', fonts: {} }],
      ['a light kit', { colors: light, shape: 'soft', fonts: {} }],
    ];
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
  });

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

describe('template update lifecycle', () => {
  it('covers every shipped template', () => {
    expect(Object.keys(cases).sort()).toEqual(names);
  });

  for (const name of names) {
    it(`${name}: new data after the first init leaves the same document as a fresh load`, async () => {
      const t = built.get(name)!;
      const c = cases[name]!;
      const a = spotData(t.manifest, c.a),
        b = spotData(t.manifest, c.b);
      const hst = await host();

      await hst.open('fresh', t.html);
      await hst.init('fresh', b, c.assetsB);
      await hst.waitFor('fresh', 'ready', 1);
      const fresh = await hst.dom('fresh');

      // The editor's path: play, then `reset`, wait for `loaded`, then init with the new data.
      await hst.open('reset', t.html);
      await hst.init('reset', a, c.assetsA);
      await hst.waitFor('reset', 'ready', 1);
      await hst.post('reset', 'play');
      await hst.page.waitForTimeout(200);
      await hst.post('reset', 'reset');
      await hst.waitFor('reset', 'loaded', 2);
      await hst.init('reset', b, c.assetsB);
      await hst.waitFor('reset', 'ready', 2);
      expect(await hst.dom('reset')).toBe(fresh);

      // A second init with no reset in between is treated the same way.
      await hst.open('again', t.html);
      await hst.init('again', a, c.assetsA);
      await hst.waitFor('again', 'ready', 1);
      await hst.post('again', 'play');
      await hst.init('again', b, c.assetsB);
      await hst.waitFor('again', 'ready', 2);
      expect(await hst.dom('again')).toBe(fresh);
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

describe('text on a brand colour (#57, #69)', () => {
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
  const kit = (colors: BrandColors): FrameTheme => ({ colors, shape: 'soft', fonts: {} });
  // `$brand.accent` as the compiler resolves it: the kit's accent, else DEFAULT_BRAND_COLORS.accent.
  const kits: [string, FrameTheme | undefined, string][] = [
    ['no kit', undefined, '#f59e0b'],
    ['the demo kit', kit(demo), demo.accent],
    ['a kit with poor on-colours', kit(poor), poor.accent],
    ['a light kit', kit(light), light.accent],
  ];
  const menu = { items: [{ name: 'Soup', description: 'Hot', price: '$4', tag: 'New' }] };
  /** Each template's spot, given the accent `$brand.accent` resolves to. */
  const spots = (accent: string): [template: string, data: Data][] => [
    ['news', { accent, items: [{ title: 'Story', published: at(-1), source: 'Wire' }] }],
    ['agenda', { accent, events: [...(cases.agenda!.b.events as unknown[]), ...(cases.agenda!.a.events as unknown[])] }],
    ['clock', { accent }],
    ['cstore-promo', {}],
    // No photo: the photo is the spot's own, and the copy's shade is the kit's background.
    ['photo-promo', {}],
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
  // Accent-coloured text on whatever is behind it: 4.5:1, or 3:1 for text that is large on a
  // 720p panel and up (WCAG: 24 px, or 18.7 px bold).
  const onBackdrop: [template: string, text: string, min: number][] = [
    ['news', '.age', 4.5],
    ['agenda', '.today', 4.5],
    ['agenda', '.now .mon', 4.5],
    ['agenda', '.event:not(.now) .mon', 4.5],
    ['clock', '.greeting', 3],
    ['cstore-promo', '.l1', 3],
    ['photo-promo', '.eyebrow', 3],
    ['menu-board', '.price', 3],
  ];

  /** Run `check` on each spot of `spots(accent)` under `theme`, in a frame of its own, ready and on top. */
  async function eachSpot(theme: FrameTheme | undefined, accent: string, check: (name: string, f: Frame, page: Page) => Promise<void>) {
    const hst = await host();
    for (const [i, [name, data]] of spots(accent).entries()) {
      const t = built.get(name)!;
      const frame = `f${i}`;
      await hst.open(frame, t.html);
      await hst.init(frame, spotData(t.manifest, data), {}, NOW, theme);
      await hst.waitFor(frame, 'ready', 1);
      await check(`${name}${data.theme ? ` (${data.theme})` : ''}`, hst.page.mainFrame().childFrames()[i]!, hst.page);
      // The frames overlap: the next one is measured on top.
      await hst.page.evaluate((frame) => {
        (window as unknown as { frames_: Record<string, HTMLIFrameElement> }).frames_[frame]!.style.visibility = 'hidden';
      }, frame);
    }
  }

  /**
   * The text colour of `sel`'s first match and the pixel behind its text that it reads worst on:
   * the intros run to their end, the text (and its shadow) hidden, and the page screenshotted.
   */
  async function textOnBackdrop(f: Frame, page: Page, sel: string): Promise<[string, string]> {
    const { color, clip } = await f.evaluate((sel) => {
      for (const a of document.getAnimations()) a.currentTime = 2000;
      const el = document.querySelector<HTMLElement>(sel)!;
      const color = getComputedStyle(el).color;
      el.style.color = 'transparent';
      el.style.textShadow = 'none';
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return { color, clip: { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) } };
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
    const worst = pixels.reduce((a, b) => (contrast(color, b) < contrast(color, a) ? b : a));
    return [color, worst];
  }

  for (const [label, theme, accent] of kits) {
    it(`text on a fill reads under ${label}`, async () => {
      const found: string[] = [];
      await eachSpot(theme, accent, async (name, f) => {
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

    it(`accent text reads on its backdrop under ${label}`, async () => {
      const found: string[] = [];
      await eachSpot(theme, accent, async (name, f, page) => {
        for (const [, text, min] of onBackdrop.filter(([n]) => name.startsWith(n))) {
          const [fg, bg] = await textOnBackdrop(f, page, text);
          const ratio = contrast(fg, bg);
          if (ratio < min) found.push(`${name} ${text}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${min}:1`);
        }
      });
      expect(found).toEqual([]);
    });
  }
});
