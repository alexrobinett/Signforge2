import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import type { FrameTheme, Orientation } from '@signforge/contract';
import {
  host,
  layoutFaults,
  LIGHT_KIT,
  motion,
  motionContract,
  noDemoAndLight,
  NOW,
  paintedContrast,
  spotData,
  useTemplate,
  type Data,
} from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { look: 'pop', target: '2026-11-29T18:00' },
  b: { look: 'night', mode: 'up', target: '2026-04-21T09:00', recordDays: 301, units: 'days and hours' },
});

describe('countdown (#198)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;

  /** One frame at a screen's own size in `timezone`; `show` inits it with the template's defaults under `data` and waits for ready. */
  async function screen(orientation: Orientation = 'landscape', timezone = 'UTC') {
    const hst = await host(orientation, true);
    await hst.open('fresh', t().html);
    let inits = 0;
    return {
      hst,
      async show(data: Data, now = NOW, theme?: FrameTheme, durationMs = 8000) {
        await hst.init('fresh', spotData(t().manifest, data), {}, now, theme, false, durationMs, timezone);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.frame('fresh');
      },
    };
  }

  /** What the screen says: the state, the figures, the unit, the done text and the progress. */
  const reads = (f: Frame) =>
    f.evaluate(() => {
      const text = (sel: string) => document.querySelector(sel)?.textContent ?? null;
      return {
        state: document.querySelector<HTMLElement>('.stage')!.dataset.state,
        number: text('.number'),
        rest: text('.rest'),
        unit: text('.unit'),
        done: text('.done'),
        detail: text('.detail'),
        progress: text('.progress-label'),
      };
    });
  const minutes = 'days, hours and minutes';

  it('works out the count from the screen clock: before, at and after the target', async () => {
    const s = await screen();
    const target = '2026-11-29T18:00';
    // NOW is Tuesday 17 November, 15:00 in the screen's zone (UTC).
    const ahead = (ms: number) => Date.parse('2026-11-29T18:00:00Z') + ms;
    const seen: Record<string, unknown> = {};
    const cases: [string, Data, number?][] = [
      ['12 days before, in days', { target }],
      ['in days and hours', { target, units: 'days and hours' }],
      ['in days, hours and minutes', { target, units: minutes }],
      ['a minute and a half before, in days', { target }, ahead(-90_000)],
      ['a minute and a half before, in minutes', { target, units: minutes }, ahead(-90_000)],
      ['at the target', { target, units: minutes }, ahead(0)],
      ['a day after', { target }, ahead(24 * 3_600_000)],
      ['after, with no done text', { target, units: minutes, doneText: '' }, ahead(60_000)],
    ];
    for (const [name, data, now] of cases) seen[name] = await reads(await s.show({ look: 'pop', ...data }, now));
    const count = (number: string, rest: string | null, unit = 'days to go') => ({ state: 'count', number, rest, unit, done: null });
    const done = { state: 'done', number: null, rest: null, unit: null, done: "It's here!" };
    const progress = (p: string | null) => ({ detail: 'Sunday, November 29 · 6:00 PM', progress: p });
    expect(seen).toEqual({
      '12 days before, in days': { ...count('12', null), ...progress(null) },
      'in days and hours': { ...count('12', '3 h'), ...progress(null) },
      'in days, hours and minutes': { ...count('12', '3 h 0 min'), ...progress(null) },
      // On the day itself: no days to go, and the progress full.
      'a minute and a half before, in days': { ...count('0', null), ...progress(null) },
      // Rounded up: the last minute shows a minute to go, not none.
      'a minute and a half before, in minutes': { ...count('0', '0 h 2 min'), ...progress(null) },
      'at the target': { ...done, ...progress(null) },
      'a day after': { ...done, ...progress(null) },
      'after, with no done text': { ...count('0', '0 h 0 min'), ...progress(null) },
    });
  });

  it('counts wall-clock days across a DST change, in the screen zone', async () => {
    // New York leaves DST at 02:00 on Sunday 1 November 2026 and starts it at 02:00 on Sunday 14 March 2027.
    const s = await screen('landscape', 'America/New_York');
    const seen: Record<string, unknown> = {};
    const cases: [string, Data, string][] = [
      // 49 hours of real time, two days on the wall.
      ['down, over the night the clocks go back', { target: '2026-11-02T18:00', units: minutes }, '2026-10-31T22:00:00Z'],
      ['down, in days, the same night', { target: '2026-11-02T18:00' }, '2026-10-31T22:00:00Z'],
      // 47 hours of real time.
      ['down, over the night the clocks go forward', { target: '2027-03-15T09:00', units: 'days and hours' }, '2027-03-13T14:00:00Z'],
      ['up, over the night the clocks go back', { mode: 'up', target: '2026-10-31T18:00', units: minutes }, '2026-11-02T23:00:00Z'],
      // 23:30 in New York, 03:30 the next day in UTC: still the 31st on the screen's wall.
      ['up, in days, late in the evening', { mode: 'up', target: '2026-10-30T09:00' }, '2026-11-01T03:30:00Z'],
    ];
    for (const [name, data, now] of cases) {
      const r = await reads(await s.show({ look: 'corporate', ...data }, Date.parse(now)));
      seen[name] = [r.number, r.rest, r.unit];
    }
    expect(seen).toEqual({
      'down, over the night the clocks go back': ['2', '0 h 0 min', 'days to go'],
      'down, in days, the same night': ['2', null, 'days to go'],
      'down, over the night the clocks go forward': ['2', '0 h', 'days to go'],
      'up, over the night the clocks go back': ['2', '0 h 0 min', 'days since'],
      'up, in days, late in the evening': ['1', null, 'day since'],
    });
  });

  it('shows zeros once the target has passed, in the hour the clocks repeat too', async () => {
    const s = await screen('landscape', 'America/New_York');
    // 01:30 on the night the clocks go back is its first pass, 05:30 UTC; at 01:15 on the second
    // pass (06:15 UTC) it has gone, though the wall clock is a quarter of an hour behind it.
    const f = await s.show({ look: 'corporate', target: '2026-11-01T01:30', units: minutes, doneText: '' }, Date.parse('2026-11-01T06:15:00Z'));
    expect(await reads(f)).toMatchObject({ state: 'count', number: '0', rest: '0 h 0 min' });
  });

  it("draws a countdown's progress over its last progressDays, only moving forward", async () => {
    const s = await screen();
    const seen: Record<string, unknown> = {};
    // 6:00 PM each day, from 16 days to go to the day itself.
    for (const [span, days] of [
      [14, [16, 15, 14, 13, 7, 1, 0]],
      [30, [31, 30, 29]],
    ] as const)
      for (const d of days) {
        const target = new Date(NOW + (d * 24 + 3) * 3_600_000).toISOString().slice(0, 16);
        const f = await s.show({ look: 'corporate', target, progressDays: span });
        seen[`${d} of ${span}`] = await f.evaluate(() => [
          document.documentElement.dataset.progress,
          document.querySelector('.ends .from')?.textContent ?? null,
          document.querySelector<HTMLElement>('.scale')?.style.getPropertyValue('--share') ?? null,
        ]);
      }
    expect(seen).toEqual({
      '16 of 14': ['off', null, null],
      '15 of 14': ['off', null, null],
      '14 of 14': ['on', 'Today', '0'],
      '13 of 14': ['on', 'Today', String(1 / 14)],
      '7 of 14': ['on', 'Today', '0.5'],
      '1 of 14': ['on', 'Today', String(13 / 14)],
      '0 of 14': ['on', 'Today', '1'],
      '31 of 30': ['off', null, null],
      '30 of 30': ['on', 'Today', '0'],
      '29 of 30': ['on', 'Today', String(1 / 30)],
    });
  });

  it('a prepare that a new init replaces while the faces load leaves the new document alone', async () => {
    const hst = await host();
    const passed = { look: 'corporate', target: '2026-11-10T18:00' };
    await hst.open('fresh', t().html);
    await hst.init('fresh', spotData(t().manifest, passed));
    await hst.waitFor('fresh', 'ready', 1);
    const fresh = await hst.dom('fresh');
    await hst.open('reset', t().html);
    await hst.init('reset', spotData(t().manifest, { look: 'pop', target: '2026-11-29T18:00' }));
    await hst.waitFor('reset', 'ready', 1);
    // Night's faces are not loaded in this document yet: its prepare waits for them, and the
    // second init, already queued, replaces the document meanwhile. Its ready is the only one sent.
    await hst.initAgain('reset', spotData(t().manifest, { look: 'night', target: '2026-11-29T18:00' }));
    await hst.initAgain('reset', spotData(t().manifest, passed));
    await hst.waitFor('reset', 'ready', 2);
    expect(await hst.dom('reset')).toBe(fresh);
  });

  it('counts up from the target, with a record to beat and without one', async () => {
    const s = await screen();
    // 210 days since Tuesday 21 April.
    const since = { mode: 'up', target: '2026-04-21T09:00' };
    const seen: Record<string, unknown> = {};
    for (const look of looks)
      for (const [name, data] of [
        ['a record of 301', { ...since, recordDays: 301 }],
        ['a record of 200', { ...since, recordDays: 200 }],
        ['no record', since],
      ] as const) {
        const f = await s.show({ look, ...data, facts: [] });
        seen[`${look}, ${name}`] = await f.evaluate(() => {
          const texts = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.textContent?.replace(/\s+/g, ' ').trim());
          return [
            document.documentElement.dataset.record,
            document.documentElement.dataset.progress,
            ...texts('.number, .tile .v'),
            ...texts('.best, .record, .fact[data-show="record"], .progress-label, .ends'),
          ];
        });
      }
    expect(seen).toEqual({
      // The bar says how far on its own: only a beaten record has a caption.
      'pop, a record of 301': ['on', 'on', '210', 'Best: 301 days'],
      'pop, a record of 200': ['on', 'on', '210', 'Best: 200 days', 'A new record'],
      'pop, no record': ['off', 'off', '210'],
      'poster, a record of 301': ['on', 'on', '210', 'Record to beat301days, 92 more to beat it'],
      'poster, a record of 200': ['on', 'on', '210', 'Record to beat200days, now beaten'],
      // Poster's progress is its tiles' split, which needs no record.
      'poster, no record': ['off', 'on', '210'],
      'night, a record of 301': ['on', 'on', '210', 'Record301 days', 'To beat it92 more days'],
      'night, a record of 200': ['on', 'on', '210', 'Record200 days', 'To beat itA new record'],
      'night, no record': ['off', 'off', '210'],
      'corporate, a record of 301': ['on', 'on', '210', '210 days of 301Record', 'Record301 days', 'To beat it92 more days'],
      'corporate, a record of 200': ['on', 'on', '210', '210 days of 200Record', 'Record200 days', 'To beat itA new record'],
      'corporate, no record': ['off', 'off', '210'],
    });
  });

  it("fills Night's ring with two half-discs turned by transforms, never a stroke", async () => {
    const s = await screen();
    const turns: Record<string, number[]> = {};
    // 4 of 14 days, then 69% and 100% of the way to a record.
    for (const [name, data] of [
      ['under half', { target: '2026-11-27T18:00' }],
      ['over half', { mode: 'up', target: '2026-04-21T09:00', recordDays: 301 }],
      ['full', { mode: 'up', target: '2026-04-21T09:00', recordDays: 100 }],
    ] as const) {
      const f = await s.show({ look: 'night', ...data });
      turns[name] = await f.evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 5000;
        const angle = (sel: string) => {
          const m = new DOMMatrix(getComputedStyle(document.querySelector(sel)!).transform);
          return Math.round((((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360) * 10) / 10;
        };
        if (document.querySelector('.ring svg, .ring [stroke-dashoffset]')) return [-1];
        return [angle('.fill.a'), angle('.fill.b'), angle('.arm')];
      });
    }
    expect(turns).toEqual({ 'under half': [102.9, 0, 102.9], 'over half': [180, 71.2, 251.2], full: [180, 180, 0] });
  });

  it('changes its figures at most once a second, from one timer that stop clears', async () => {
    const hst = await host('landscape', true);
    await hst.page.clock.install({ time: NOW });
    await hst.open('fresh', t().html);
    // 2 days, 3 hours and 0 minutes to go.
    await hst.init('fresh', spotData(t().manifest, { look: 'night', target: '2026-11-19T18:00', units: minutes }));
    await hst.waitFor('fresh', 'ready', 1);
    const f = hst.frame('fresh');
    await hst.page.clock.pauseAt(NOW + 10_000);
    await f.evaluate(() => {
      const w = window as unknown as { seen: string[] };
      w.seen = [];
      new MutationObserver((ms) => {
        for (const m of ms) w.seen.push(`${(m.target.parentElement ?? m.target).textContent}`);
      }).observe(document.querySelector('.stage')!, { subtree: true, childList: true, characterData: true });
    });
    await hst.post('fresh', 'play');
    const read = () => f.evaluate(() => [document.querySelector('.sub')!.textContent, (window as unknown as { seen: string[] }).seen.splice(0)]);
    const ticks: unknown[] = [];
    for (const ms of [1000, 48_000, 2000, 1000, 60_000]) {
      await hst.page.clock.runFor(ms);
      ticks.push(await read());
    }
    await hst.post('fresh', 'stop');
    await hst.page.clock.runFor(180_000);
    ticks.push(await read());
    // Played 10 s into the minute, read at 11, 59, 61, 62 and 122 s: the minutes go down as each
    // minute turns, nothing else is written, and nothing at all once stopped.
    expect(ticks).toEqual([
      ['days · 3 h · 0 min', []],
      ['days · 3 h · 0 min', []],
      ['days · 2 h · 59 min', ['days · 2 h · 59 min']],
      ['days · 2 h · 59 min', []],
      ['days · 2 h · 58 min', ['days · 2 h · 58 min']],
      ['days · 2 h · 58 min', []],
    ]);
  });

  it('keeps each figure the same width whatever its digits, in every look', async () => {
    const s = await screen();
    const widths: Record<string, number[]> = {};
    for (const look of looks)
      for (let d = 10; d < 20; d++) {
        // d days, d hours and d minutes to go: every digit from 0 to 9 in each place. (Night's
        // percentage beside them is fixed for a play.)
        const target = new Date(NOW + ((d * 24 + d) * 60 + d) * 60_000).toISOString().slice(0, 16);
        const f = await s.show({ look, target, units: minutes, showProgress: false });
        const w = await f.evaluate(() => {
          for (const a of document.getAnimations()) a.currentTime = 5000;
          return [...document.querySelectorAll<HTMLElement>('.number, .rest, .sub, .tile .v')].map((e) => {
            const r = document.createRange();
            r.selectNodeContents(e);
            return Math.round(r.getBoundingClientRect().width * 10) / 10;
          });
        });
        for (const [i, x] of w.entries()) (widths[`${look} ${i}`] ??= []).push(x);
      }
    for (const [figure, w] of Object.entries(widths)) expect(new Set(w).size, `${figure}: ${w.join(', ')}`).toBe(1);
  });

  /** Copy at its longest: every text at its maxLength, three facts, and the figures at their widest. */
  const longest = {
    title: 'The winter party on the Pier 9 roof terrace, with the bandzz',
    doneText: 'The doors are open: come up to the roofz',
    facts: [
      { label: 'Where exactly??', value: 'Pier 9 roof terrace, north sidez' },
      { label: 'Dress code toni', value: 'Smart casual and a warm coat, ok' },
      { label: 'Tickets from rr', value: 'Reception, free for every staffz' },
    ],
  };
  const states: [string, Data][] = [
    ['down', { ...longest, target: '2026-11-27T18:00', units: minutes }],
    ['far off', { ...longest, target: '2099-12-31T23:59', units: 'days and hours' }],
    ['up', { ...longest, mode: 'up', target: '1900-01-01T00:00', recordDays: 99999 }],
    ['done', { ...longest, target: '2026-11-17T09:00' }],
  ];
  const toggles = ['showProgress', 'showRecord', 'showFacts', 'showDetail'];
  /** Every toggle on, each one off on its own, and all of them off. */
  const toggleSets: Data[] = [{}, ...toggles.map((k) => ({ [k]: false })), Object.fromEntries(toggles.map((k) => [k, false]))];

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text fits and nothing overlaps at the longest copy, in every look and toggle, ${orientation}`, async () => {
      const s = await screen(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const [state, data] of states)
          for (const set of toggleSets) {
            const off = Object.keys(set).join(', ') || 'all on';
            // Poster's flip-clock split is drawn across its figures.
            for (const fault of await layoutFaults(await s.show({ look, ...data, ...set }), '', '.split')) found.push(`${look}, ${state}, ${off}: ${fault}`);
          }
      expect(found).toEqual([]);
    }, 300_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const s = await screen(orientation);
      const found: string[] = [];
      const allOff = toggleSets.at(-1)!;
      for (const [kit, theme] of noDemoAndLight(LIGHT_KIT))
        for (const look of looks)
          for (const [state, data] of states)
            for (const set of state === 'done' ? [{}] : [{}, allOff]) {
              const f = await s.show({ look, ...data, ...set }, NOW, theme);
              for (const l of await paintedContrast(s.hst.page, f, '.stage')) found.push(`${look}, ${kit}, ${state}${set === allOff ? ', all off' : ''}: ${l}`);
            }
      expect(found).toEqual([]);
    }, 300_000);

  it('marks each toggle on the root, removes what is off, and steps the title up into a screen without them', async () => {
    const s = await screen();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['progress', 'record', 'facts', 'detail'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: [
          '.dots, .ring, .split, .scale',
          '.best, .record, .fact[data-show="record"]',
          '.facts .fact[data-show="facts"], .band',
          '.detail, .fact[data-show="detail"]',
        ].filter((sel) => document.querySelector(sel)),
        title: Number.parseFloat(getComputedStyle(document.querySelector('.title')!).fontSize),
      }));
    const data = { mode: 'up', target: '2026-04-21T09:00', recordDays: 301, title: 'Safe days' };
    for (const look of looks) {
      const on = await read(await s.show({ look, ...data }));
      const off = await read(await s.show({ look, ...data, ...toggleSets.at(-1)! }));
      expect(on.marks, look).toEqual(['progress=on', 'record=on', 'facts=on', 'detail=on']);
      expect(on.present, look).toHaveLength(4);
      expect(off.marks, look).toEqual(['progress=off', 'record=off', 'facts=off', 'detail=off']);
      expect(off.present, look).toEqual([]);
      const step = Number(await (await s.show({ look, ...data })).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lk-step')));
      expect(off.title / on.title, look).toBeCloseTo(step, 2);
    }
  });

  it('every element has an intro and an outro timed from --sf-duration, moving only transform and opacity, within the cap', async () => {
    const s = await screen();
    const durationMs = 11_000;
    for (const look of looks)
      for (const [, data] of states) {
        const f = await s.show({ look, ...data }, NOW, undefined, durationMs);
        // Every element with a kit class has its intro and outro here.
        expect(await motion(f, durationMs, true), look).toEqual({ props: ['opacity', 'transform'], withinCap: true, unended: [], unknown: [] });
        // D's motion, read by seeking; Night's ring turns as the days run out, as progress.
        expect(await motionContract(f, durationMs, { progress: ":root[data-look='night'] :is(.fill, .seam, .arm)" }), look).toEqual([]);
      }
  });

  // Ambient motion and the ring's sweep took a portrait fade over 1% dropped on the Pi (spike/pi-perf/RESULTS.md, Countdown).
  it("holds its ambient motion and Night's sweep still in portrait, and keeps them in landscape", async () => {
    const moving: Record<string, number[]> = {};
    for (const orientation of ['landscape', 'portrait'] as const) {
      const s = await screen(orientation);
      for (const look of looks) {
        const f = await s.show({ look, mode: 'up', target: '2026-04-21T09:00', recordDays: 301 });
        (moving[orientation] ??= []).push(
          await f.evaluate(
            () => [...document.querySelectorAll('.lk-wobble, .lk-pulse, .lk-ping, .ring .fill, .arm')].filter((e) => e.getAnimations().length).length,
          ),
        );
      }
    }
    // Night: two halves and the arm (the ping went with the board's hairline ring). Pop's wobbling tile and stickers, its pulsing dot and Corporate's breathing
    // marker are retired with D's motion (long holds, nothing bouncing on text).
    expect(moving).toEqual({ landscape: [0, 0, 3, 0], portrait: [0, 0, 0, 0] });
  });

  // The board's countdown (#news-design), shown in Night: the number the one lit thing in a hairline ring with no ping,
  // no "//" before the unit, the title in the text colour and the facts as ruled rows.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`lights only Night's number, in a hairline ring, with ruled facts, ${orientation}`, async () => {
      const s = await screen(orientation);
      const f = await s.show({ look: 'night', target: '2026-11-29T18:00', facts: [{ label: 'Where', value: 'Pier 9 roof terrace' }] });
      const seen = await f.evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 3000;
        const style = (sel: string) => getComputedStyle(document.querySelector(sel)!);
        const vmin = Math.min(innerWidth, innerHeight) / 100;
        const ring = document.querySelector('.track')!.getBoundingClientRect();
        const hole = document.querySelector('.hole')!.getBoundingClientRect();
        return {
          ring: Math.round(((ring.width - hole.width) / 2 / vmin) * 10) / 10,
          ping: document.querySelectorAll('.ping').length,
          unit: document.querySelector('.unit-row')!.textContent!.trim().startsWith('//'),
          lit: style('.number').color !== style('.title').color && style('.title').color === style('body').color,
          rows: [...document.querySelectorAll('.fact')].every((el) => getComputedStyle(el).display === 'grid'),
        };
      });
      expect(seen).toEqual({ ring: 1.1, ping: 0, unit: false, lit: true, rows: true });
    });

  it('with reduced motion, shows the final frame with nothing animating', async () => {
    const s = await screen();
    await s.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const look of looks) {
      const f = await s.show({ look, mode: 'up', target: '2026-04-21T09:00', recordDays: 301, units: minutes });
      await s.hst.post('fresh', 'play');
      expect(await f.evaluate(() => document.getAnimations().length), look).toBe(0);
    }
  });
});
