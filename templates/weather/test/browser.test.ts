import { describe, expect, it } from 'vitest';
import type { BrandColors } from '@signforge/contract';
import { host, motionContract, noDemoAndLight, NOW, paintedContrast, screenFrame, spotData, useTemplate, type Data } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { code: 61, isDay: 1, sunrise: NOW / 1000 - 3600, sunset: NOW / 1000 + 7200 },
  b: { code: 71, isDay: 0, temp: 30, sunrise: NOW / 1000 - 11 * 3600, sunset: NOW / 1000 - 3600 },
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
    const hst = await host();
    await hst.open('fresh', t().html);
    let inits = 0;
    return async (data: Data, at: number) => {
      await hst.init('fresh', spotData(t().manifest, data), {}, at);
      await hst.waitFor('fresh', 'ready', ++inits);
      return hst.frame('fresh').evaluate(() => {
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
    const hst = await host();
    await hst.open('fresh', t().html);
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
          await hst.init('fresh', spotData(t().manifest, { ...data, code }), {}, clock(at), theme);
          await hst.waitFor('fresh', 'ready', ++inits);
          const low = await paintedContrast(hst.page, hst.frame('fresh'));
          for (const l of low) found.push(`${kit}, ${phase}, code ${code}: ${l}`);
        }
    expect(found).toEqual([]);
    // 252 screenshots, each kit, time of day and condition painting the card differently: 17 s on a laptop, 84 s on
    // CI's runner (run 45109076539).
  }, 240_000);

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

// D's motion (docs/template-spec.md, Motion), read by seeking: a clear day with the sun, rain by day and snow by night.
// Falling rain or snow is the weather's own loop.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`moves as D does, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const durationMs = 11_000;
    const found: string[] = [];
    const skies: Data[] = [
      { code: 1, isDay: 1, sunrise: NOW / 1000 - 3600, sunset: NOW / 1000 + 7200 },
      { code: 61, isDay: 1, sunrise: NOW / 1000 - 3600, sunset: NOW / 1000 + 7200 },
      { code: 71, isDay: 0, temp: 30, sunrise: NOW / 1000 - 11 * 3600, sunset: NOW / 1000 - 3600 },
    ];
    for (const sky of skies)
      for (const line of await motionContract(await k.play(sky, undefined, durationMs), durationMs, { loops: '.fall' })) found.push(`${sky.code}: ${line}`);
    expect(found).toEqual([]);
  });

// The board's weather (#news-design): the glass card kept, lighter, with a hairline edge and no shadow; no clouds parked
// on the top edge; the city in title case, its descenders clear of the figures (Sydney); the unit at the figures' cap
// height; two rows of tabular figures.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`keeps a lighter glass card with no edge clouds, the city in title case and the unit at cap height, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const f = await k.play({ city: 'Sydney', code: 2, isDay: 1, sunrise: NOW / 1000 - 3600, sunset: NOW / 1000 + 7200 });
    const seen = await f.evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 3000;
      const style = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const vmin = Math.min(innerWidth, innerHeight) / 100;
      // The alpha as computed: `rgba(r, g, b, a)` or `color(srgb r g b / a)`; with none it is opaque.
      const bg = style('.info').backgroundColor;
      const alpha = Number((bg.match(/\/\s*([\d.]+)\)$/) ?? bg.match(/^rgba\(.*,\s*([\d.]+)\)$/))?.[1] ?? 1);
      return {
        clouds: document.querySelectorAll('.cloud:not(.hero)').length,
        glass: alpha < 1,
        edge: style('.info').boxShadow.includes('inset'),
        city: style('.city').textTransform,
        // The city's line box holds its descenders; the figures' box starts at their cap top.
        clear: (box('#temp').top - box('.city').bottom) / vmin >= 1,
        // Both boxes trimmed to cap height, which the row then aligns: their box tops match whether trimmed or not.
        unit: [style('#temp').getPropertyValue('text-box'), style('.temp .unit').getPropertyValue('text-box')].every((v) => v.includes('cap')),
        rows: [
          style('.range').gridTemplateColumns.split(' ').length,
          style('.extra').gridTemplateColumns.split(' ').length,
          style('.range').fontVariantNumeric,
        ],
      };
    });
    expect(seen).toEqual({ clouds: 0, glass: true, edge: true, city: 'none', clear: true, unit: true, rows: [2, 2, 'tabular-nums'] });
  });
