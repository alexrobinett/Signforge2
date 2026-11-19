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
import type { Page } from 'playwright';
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
            glow: Number(getComputedStyle(document.querySelector('.glow')!).opacity),
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
    expect(rise.glow).toBeGreaterThan(0.5);
    expect(set.glow).toBeGreaterThan(0.5);
    expect(noon.glow).toBe(0);
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
    expect(day.glow).toBe(0);
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

describe('text on a brand colour (#57)', () => {
  /** examples/demo/brand.json, with the on-colours the brand tools derive for it. */
  const demo: BrandColors = {
    primary: '#1d4ed8',
    onPrimary: '#ffffff',
    accent: '#f97316',
    onAccent: '#000000',
    background: '#0b1020',
    surface: '#18213a',
    text: '#f8fafc',
    muted: '#a5b4cb',
  };
  // A kit may set its on-colours by hand; the brand tools only warn when a pair fails.
  const poor: BrandColors = { ...demo, onPrimary: '#2563eb', onAccent: '#ffffff' };
  const kit = (colors: BrandColors): FrameTheme => ({ colors, shape: 'soft', fonts: {} });
  // `$brand.accent` as the compiler resolves it: the kit's accent, else DEFAULT_BRAND_COLORS.accent.
  const kits: [string, FrameTheme | undefined, string][] = [
    ['no kit', undefined, '#f59e0b'],
    ['the demo kit', kit(demo), demo.accent],
    ['a kit with poor on-colours', kit(poor), poor.accent],
  ];
  // The badge's own text (axe, 4.5:1), and cstore-promo's large points figure (3:1).
  const pairs: [template: string, text: string, fill: string, min: number][] = [
    ['news', '.badge', '.badge', 4.5],
    ['cstore-promo', '.badge small', '.badge .disc', 4.5],
    ['cstore-promo', '.badge b', '.badge .disc', 3],
  ];

  for (const [label, theme, accent] of kits)
    it(`news and cstore-promo badges read under ${label}`, async () => {
      const hst = await host();
      const found: string[] = [];
      for (const [i, name] of ['news', 'cstore-promo'].entries()) {
        const t = built.get(name)!;
        const frame = ['fresh', 'reset'][i]!;
        await hst.open(frame, t.html);
        await hst.init(frame, spotData(t.manifest, name === 'news' ? { accent } : {}), {}, NOW, theme);
        await hst.waitFor(frame, 'ready', 1);
        const f = hst.page.mainFrame().childFrames()[i]!;
        for (const [, text, fill, min] of pairs.filter(([n]) => n === name)) {
          const [fg, bg] = await f.evaluate(
            ({ text, fill }) => [getComputedStyle(document.querySelector(text)!).color, getComputedStyle(document.querySelector(fill)!).backgroundColor],
            { text, fill },
          );
          const ratio = contrast(fg!, bg!);
          if (ratio < min) found.push(`${name} ${text}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${min}:1`);
        }
      }
      expect(found).toEqual([]);
    });
});
