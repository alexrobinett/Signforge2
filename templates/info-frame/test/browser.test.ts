import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import type { FrameTheme, Orientation } from '@signforge/contract';
import {
  DEMO_KIT,
  host,
  INTRO_WINDOW_MS,
  layoutFaults,
  LIGHT_KIT,
  motion,
  noDemoAndLight,
  NOW,
  paintedContrast,
  spotData,
  useTemplate,
  type Data,
} from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { look: 'night', rail: 'left', items: [{ title: 'Ferry runs late', published: '', source: '' }] },
  b: { look: 'pop', rail: 'off', ticker: 'top', showForecast: false, items: [] },
  assetsA: { photo: '#963' },
  assetsB: { photo: '#369' },
});

describe('info frame (#201)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
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
  const faults = (f: Frame) => layoutFaults(f, '.logo, .glyph', '', '.card');

  /**
   * Fast opaque-card contrast check for the full 288-state cross-product: verifies every text node
   * sits on an opaque card (never on the photo), with full opacity at rest, and that its computed
   * colour meets WCAG 4.5:1 (3:1 large) against that card's computed fill.
   */
  const cardContrast = (f: Frame) =>
    f.evaluate((window) => {
      const intros = document
        .getAnimations()
        .map((a) => a.effect!.getComputedTiming())
        // An entrance, as layoutFaults reads one: not an exit near the play's end, a push-in or a loop.
        .filter((t) => t.direction !== 'reverse' && Number.isFinite(Number(t.endTime)) && Number(t.delay) < window && Number(t.duration) < window);
      const rest = Math.max(0, ...intros.map((t) => Number(t.endTime)));
      for (const a of document.getAnimations()) a.currentTime = rest;
      const rgba = (c: string): [number, number, number, number] => {
        const nums = (c.match(/[\d.]+/g) ?? []).map(Number);
        const scale = c.startsWith('color(') ? 255 : 1;
        return [(nums[0] ?? 0) * scale, (nums[1] ?? 0) * scale, (nums[2] ?? 0) * scale, nums[3] ?? 1];
      };
      const lum = ([r, g, b]: [number, number, number, number]) => {
        const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.stage *')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        if (!own.length) continue;
        const s = getComputedStyle(el);
        const fg = rgba(s.color);
        if (fg[3] < 0.99) out.push(`${el.className || el.tagName}: translucent text (${fg[3]})`);
        let bg: [number, number, number, number] | undefined;
        for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (!p.classList.contains('colon') && Number.parseFloat(ps.opacity) < 0.99) out.push(`${el.className || el.tagName}: faded by ${p.className}`);
          const c = rgba(ps.backgroundColor);
          if (c[3] > 0) {
            bg = c;
            break;
          }
        }
        if (!bg || bg[3] < 0.99) {
          out.push(`${el.className || el.tagName}: no opaque card fill`);
          continue;
        }
        const size = Number.parseFloat(s.fontSize);
        const min = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5;
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        const ratio = (hi! + 0.05) / (lo! + 0.05);
        if (ratio < min) out.push(`${el.className || el.tagName}: ${ratio.toFixed(2)}:1, below ${min}:1`);
      }
      return [...new Set(out)];
    }, INTRO_WINDOW_MS);

  for (const orientation of ['landscape', 'portrait'] as const)
    for (const look of looks)
      it(`${look}, ${orientation}: in every rail, crawl and toggle setting, at the longest copy, every text fits, reads and nothing overlaps`, async () => {
        const r = await frame(orientation);
        const found: string[] = [];
        for (const set of settings) {
          const f = await r.show({ look, ...longest, ...set });
          for (const fault of [...(await faults(f)), ...(await cardContrast(f))]) found.push(`${named(set)}: ${fault}`);
        }
        expect(found).toEqual([]);
      }, 600_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`an unbroken word at each field's maxLength wraps or truncates without sideways clipping, ${orientation}`, async () => {
      const r = await frame(orientation);
      const unbroken: Data = {
        ...news,
        captionTitle: 'W'.repeat(64),
        captionLine: 'W'.repeat(80),
        city: 'W'.repeat(24),
      };
      const found: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, ...unbroken });
        for (const fault of await faults(f)) found.push(`${look}: ${fault}`);
        const check = await f.evaluate(() => {
          const title = document.querySelector<HTMLElement>('.title')!;
          const caption = document.querySelector<HTMLElement>('.caption')!;
          return {
            overflowX: title.scrollWidth - title.clientWidth,
            fit: Number(caption.style.getPropertyValue('--if-title-fit') || 1),
          };
        });
        if (check.overflowX > 1) found.push(`${look}: .title overflows horizontally by ${check.overflowX}px`);
        if (check.fit >= 1) found.push(`${look}: .title stayed at scale ${check.fit} for 64 unbroken W's`);
      }
      expect(found).toEqual([]);
    }, 120_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`the defaults fit at the look's own size, nothing shrunk, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, ...news });
        for (const fault of await faults(f)) found.push(`${look}: ${fault}`);
        const shrunk = await f.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[style*="--if-"]')]
            .filter((el) => ['--if-fit', '--if-title-fit'].some((v) => el.style.getPropertyValue(v) && Number(el.style.getPropertyValue(v)) !== 1))
            .map((el) => el.className),
        );
        for (const el of shrunk) found.push(`${look}: ${el} is shrunk`);
      }
      expect(found).toEqual([]);
    }, 120_000);

  /**
   * Pixel-painted contrast states: every rail (`right`, `left`, `off`) and crawl (`bottom`, `top`,
   * `off`) placement, chip-only combinations (clock without weather, weather without clock), each
   * toggle off alone, and all off.
   */
  const contrastSets: Data[] = [
    { rail: 'right', ticker: 'bottom' },
    { rail: 'left', ticker: 'top' },
    { rail: 'right', ticker: 'off' },
    { rail: 'off', ticker: 'bottom' },
    { rail: 'off', ticker: 'off', showWeather: false },
    { rail: 'off', ticker: 'top', showClock: false },
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

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every one of the 288 rail × crawl × toggle settings reads on an opaque card in every look, with no kit and a light kit, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const [kit, theme] of [
        ['no kit', null],
        ['light kit', { colors: LIGHT_KIT, shape: 'soft', fonts: {} } satisfies FrameTheme],
      ] as const)
        for (const look of looks)
          for (const set of settings) {
            const f = await r.show({ look, ...news, ...set }, theme);
            for (const l of await cardContrast(f)) found.push(`${look}, ${kit}, ${named(set)}: ${l}`);
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
    // 22:30 on Tuesday in New York, then 0:30 on Wednesday: static fallback days follow the screen's zone, not UTC's.
    const ny = (at: string) => r.show({ look: 'pop', hour24: true }, demo, Date.parse(at), 'America/New_York');
    expect(await read(await ny('2026-11-18T03:30:00Z'))).toEqual({ time: '22:30', ap: null, date: 'Tuesday, November 17', days: ['Wed', 'Thu', 'Fri'] });
    expect(await read(await ny('2026-11-18T05:30:00Z'))).toEqual({ time: '00:30', ap: null, date: 'Wednesday, November 18', days: ['Thu', 'Fri', 'Sat'] });
    // Cross-timezone live forecast: LA screen (Tue Nov 17 22:00) bound to NY weather (already Wed Nov 18 01:00;
    // daily.time.1..3 are Thu Nov 19, Fri Nov 20, Sat Nov 21 at 00:00 EST). Forecast days keep NY's dates.
    const at = Date.parse('2026-11-18T06:00:00Z');
    const nyFresh: Data = {
      look: 'pop',
      hour24: true,
      weatherTimezone: 'America/New_York',
      day1Time: Date.parse('2026-11-19T05:00:00Z') / 1000,
      day2Time: Date.parse('2026-11-20T05:00:00Z') / 1000,
      day3Time: Date.parse('2026-11-21T05:00:00Z') / 1000,
    };
    expect(await read(await r.show(nyFresh, demo, at, 'America/Los_Angeles'))).toEqual({
      time: '22:00',
      ap: null,
      date: 'Tuesday, November 17',
      days: ['Thu', 'Fri', 'Sat'],
    });
    // Cached snapshot across midnight: NY screen at Wed 01:00 holding Tuesday's snapshot (daily.time.1..3 = Wed..Fri).
    const nyCached: Data = {
      look: 'pop',
      hour24: true,
      weatherTimezone: 'America/New_York',
      day1Time: Date.parse('2026-11-18T05:00:00Z') / 1000,
      day2Time: Date.parse('2026-11-19T05:00:00Z') / 1000,
      day3Time: Date.parse('2026-11-20T05:00:00Z') / 1000,
    };
    expect(await read(await r.show(nyCached, demo, at, 'America/New_York'))).toEqual({
      time: '01:00',
      ap: null,
      date: 'Wednesday, November 18',
      days: ['Wed', 'Thu', 'Fri'],
    });
    // An unrecognised fallback timezone string falls back cleanly to the screen's zone without failing prepare.
    expect(await read(await r.show({ ...nyCached, weatherTimezone: 'Not/A_Zone' }, demo, at, 'America/New_York'))).toEqual({
      time: '01:00',
      ap: null,
      date: 'Wednesday, November 18',
      days: ['Wed', 'Thu', 'Fri'],
    });
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

  it("keeps the photo unpainted until play, under each look's intro", async () => {
    const r = await frame();
    for (const look of looks) {
      const f = await r.show({ look });
      expect(await f.evaluate(() => getComputedStyle(document.querySelector('.photo')!).visibility), look).toBe('hidden');
      await r.hst.post('fresh', 'play');
      await f.waitForFunction(() => getComputedStyle(document.querySelector('.photo')!).visibility === 'visible');
    }
  });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every element has an intro and an outro timed from --sf-duration, moving only transform and opacity, within the cap; in ${orientation}, ${orientation === 'portrait' ? 'only the crawl loops' : 'the ambient motion loops'}`, async () => {
      const r = await frame(orientation);
      const durationMs = 13_000;
      for (const [i, look] of looks.entries()) {
        await r.hst.init('fresh', spotData(t().manifest, { look, ...longest }), { photo: '#963', '$brand.logo': '#fff' }, NOW, demo, false, durationMs);
        await r.hst.waitFor('fresh', 'ready', i + 1);
        const f = r.hst.page.mainFrame().childFrames()[0]!;
        const seen = await motion(f, durationMs);
        expect(seen, look).toEqual({ props: ['opacity', 'transform'], withinCap: true, unended: [], unknown: [] });
        const looping = await f.evaluate(() =>
          [
            ...new Set(
              document
                .getAnimations()
                .filter((a) => a.effect!.getComputedTiming().iterations === Number.POSITIVE_INFINITY)
                .map((a) => ((a.effect as KeyframeEffect).target as Element).className),
            ),
          ].sort(),
        );
        if (orientation === 'portrait') expect(looping, look).toEqual(['lk-crawl']);
        else expect(looping.length, look).toBeGreaterThan(1);
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
