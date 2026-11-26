import { describe, expect, it } from 'vitest';
import type { BrandColors, Orientation } from '@signforge/contract';
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

// Rain's slant is drawn into its square tile (#96): each layer slides one tile left and four down a turn, which lands the
// pattern on itself, and it covers the frame all the way through, whatever the screen's shape.
describe('rain: its slide and its cover (#96)', () => {
  const shapes: [string, Orientation, { long: number; short: number }][] = [
    ['16:9', 'landscape', { long: 1920, short: 1080 }],
    ['9:16', 'portrait', { long: 1920, short: 1080 }],
    ['8:1', 'landscape', { long: 2880, short: 360 }],
    ['1:8', 'portrait', { long: 2880, short: 360 }],
    ['1:1', 'landscape', { long: 1080, short: 1080 }],
  ];
  for (const [shape, orientation, size] of shapes)
    it(`slides a tile left and four down, and covers a ${shape} frame through its turn`, async () => {
      const hst = await host(orientation, size);
      await hst.open('fresh', t().html);
      await hst.init('fresh', spotData(t().manifest, { code: 63 }));
      await hst.waitFor('fresh', 'ready', 1);
      const found = await hst.frame('fresh').evaluate(() => {
        const out: string[] = [];
        const layers = [...document.querySelectorAll<HTMLElement>('#fx .rain')];
        if (layers.length !== 2) out.push(`${layers.length} rain layers, not 2`);
        for (const [i, el] of layers.entries()) {
          const tile = Number.parseFloat(el.style.getPropertyValue('--tile'));
          const [turn] = el.getAnimations();
          turn!.pause();
          const ms = Number(turn!.effect!.getComputedTiming().duration);
          const at = (part: number) => {
            turn!.currentTime = part * ms;
            return el.getBoundingClientRect();
          };
          const [start, half] = [at(0), at(0.5)];
          const slide = [Math.round((half.left - start.left) * 2), Math.round((half.top - start.top) * 2)];
          if (slide[0] !== -tile || slide[1] !== 4 * tile) out.push(`layer ${i} slides ${slide} a turn, not ${[-tile, 4 * tile]}`);
          if (getComputedStyle(el).backgroundSize !== `${tile}px ${tile}px`) out.push(`layer ${i}'s tile is ${getComputedStyle(el).backgroundSize}`);
          for (const part of [0, 0.25, 0.5, 0.75, 0.999]) {
            const r = at(part);
            if (r.left > 0 || r.top > 0 || r.right < innerWidth || r.bottom < innerHeight)
              out.push(
                `layer ${i} at ${part} of its turn leaves ${[r.left, r.top, r.right, r.bottom].map(Math.round)} of ${innerWidth}x${innerHeight} uncovered`,
              );
          }
        }
        return out;
      });
      expect(found).toEqual([]);
    });
});

// D's motion (docs/template-spec.md, Motion), read by seeking: a clear day with the sun, rain by day and snow by night.
// Drifting clouds and falling rain or snow are the weather's own loops.
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
      for (const line of await motionContract(await k.play(sky, undefined, durationMs), durationMs, { loops: '.cloud, .fall' }))
        found.push(`${sky.code}: ${line}`);
    expect(found).toEqual([]);
  });
