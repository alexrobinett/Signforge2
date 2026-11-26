import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import type { FrameTheme, Orientation } from '@signforge/contract';
import {
  at,
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
  a: { look: 'corporate', events: [{ title: 'Design review', start: at(-0.5), end: at(0.5), allDay: false, organizer: 'Priya Shah' }] },
  b: { look: 'pop', showSchedule: false, events: [{ title: 'Hiring sync', start: at(1), end: at(2), allDay: false, organizer: '' }] },
});

describe('room status (#199)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
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
      /** `fallback`: the bound fields the screen says play their fallback (#225). */
      async show(data: Data, theme?: FrameTheme, now = NOW, timezone = 'UTC', fallback: string[] = []) {
        await hst.init('fresh', spotData(t().manifest, data), {}, now, theme, false, 8000, timezone, undefined, fallback);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.frame('fresh');
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

  it('says the schedule is unavailable, in every look, while the calendar plays its fallback, whatever the fallback holds (#225)', async () => {
    const r = await room();
    const found: Record<string, unknown> = {};
    for (const look of looks)
      for (const [day, events] of [
        ['none', []],
        ['a meeting on now', [booking('Design review', -0.25, 0.75, 'Priya Shah'), booking('Hiring sync', 2, 2.5)]],
      ] as const)
        found[`${look}, ${day}`] = await says(await r.show({ look, events: [...events] }, undefined, NOW, 'UTC', ['events']));
    const unavailable = {
      state: 'unknown',
      word: 'Schedule unavailable',
      for: null,
      line: 'Check the booking before you use the room',
      org: null,
      next: null,
      freeDay: "The room's calendar is not updating",
      allDay: null,
    };
    expect(found).toEqual(Object.fromEntries(Object.keys(found).map((k) => [k, unavailable])));
    // Neither free's colour nor busy's: the word is in the look's muted ink, in every look.
    for (const look of looks) {
      const f = await r.show({ look, events: [] }, undefined, NOW, 'UTC', ['events']);
      const [word, muted] = await f.evaluate(() => {
        const probe = document.querySelector('.stage')!.appendChild(document.createElement('i'));
        probe.style.color = 'var(--lk-muted)';
        return [getComputedStyle(document.querySelector('.word')!).color, getComputedStyle(probe).color];
      });
      expect(word, look).toBe(muted);
    }
    // A field the screen does not name plays live: the same room, free, when only another field is on its fallback.
    expect(await says(await r.show({ look: 'pop', events: [] }, undefined, NOW, 'UTC', ['room']))).toMatchObject({ state: 'free', freeDay: 'Free all day' });
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
  /** Each day's events, and the bound fields the screen says play their fallback. */
  const days: [string, Data, string[]?][] = [
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
    // A room's name on two lines with "Booked by" on left the meeting line less than a line (review of #606).
    ['busy, a one-line title', { ...longest, events: [booking('Quarterly budget review with finance', -0.25, 0.75, 'Priya Shah')] }],
    ['busy, a shorter room', { room: 'Executive boardroom, east wing', events: [booking(long, -0.25, 0.75, 'Priya Shah')] }],
    // The calendar not updating (#225), its fallback a busy day.
    ['unavailable', { ...longest, events: [booking(long, -0.25, 0.75, 'Priya Shah')] }, ['events']],
  ];
  const toggles = ['showSchedule', 'showNext', 'showClock', 'showFacts', 'showNowLine', 'showOrganiser'];
  const allOn: Data = Object.fromEntries(toggles.map((t) => [t, true]));
  const allOff: Data = Object.fromEntries(toggles.map((t) => [t, false]));
  /** Every toggle on, each one off on its own, and all of them off. */
  const toggleSets: Data[] = [allOn, ...toggles.map((t) => ({ ...allOn, [t]: false })), allOff];

  /**
   * The layout's faults, the now line and the pin counted as text, a schedule drawn empty, and a line of text its own
   * box or one around it cuts through, not at a line's edge: a clamp ends on a whole line.
   */
  const faults = async (f: Frame) => [
    ...(await layoutFaults(f, '.nowline, .pin-pill')),
    ...(await f.evaluate(() => {
      const found: string[] = [];
      const schedule = document.querySelector('.schedule');
      if (schedule && !schedule.querySelector('.item, .block, .free-day')) found.push('an empty schedule');
      for (const el of document.querySelectorAll<HTMLElement>('.stage *'))
        for (const n of el.childNodes) {
          if (n.nodeType !== Node.TEXT_NODE || !n.textContent!.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          // The line box, centred on the glyph box: a tight leading's glyphs stand past it, into the clamp's hidden line.
          const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 0;
          for (const r of range.getClientRects()) {
            const h = lh || r.height;
            let [top, bottom] = [r.top + (r.height - h) / 2, r.top + (r.height + h) / 2];
            let past = false;
            for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
              const s = getComputedStyle(p);
              if (s.overflowY === 'visible') continue;
              const c = p.getBoundingClientRect();
              // A line after a clamp's last starts at its content's edge and is not painted, though its padding shows.
              if (s.webkitLineClamp !== 'none' && s.display !== 'flex' && top >= c.bottom - Number.parseFloat(s.paddingBottom) - 1) past = true;
              [top, bottom] = [Math.max(top, c.top), Math.min(bottom, c.bottom)];
            }
            if (past) continue;
            const shown = (bottom - top) / h;
            if (shown > 0.1 && shown < 0.9) {
              found.push(`${el.className || el.tagName} cut through a line (${Math.round(shown * 100)}% shown)`);
              break;
            }
          }
        }
      return found;
    })),
  ];

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text fits and nothing overlaps, the now line included, in every look and toggle, ${orientation}`, async () => {
      const r = await room(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const [day, data, fallback] of days)
          for (const set of toggleSets) {
            const off =
              Object.keys(set)
                .filter((k) => !set[k])
                .join(', ') || 'all on';
            for (const fault of await faults(await r.show({ look, ...data, ...set }, undefined, NOW, 'UTC', fallback)))
              found.push(`${look}, ${day}, ${off}: ${fault}`);
          }
      // The light kit's faces set the lines a little taller.
      for (const look of looks)
        for (const [day, data] of days.slice(-2))
          for (const fault of await faults(await r.show({ look, ...data, ...allOn }, noDemoAndLight(LIGHT_KIT).at(-1)![1])))
            found.push(`${look}, ${day}, the light kit: ${fault}`);
      // The timeline's hours across a change of clocks and from midnight.
      for (const look of looks)
        for (const [day, now, events] of zoned)
          for (const fault of await faults(await r.show({ look, ...allOn, events }, undefined, Date.parse(now), 'America/New_York')))
            found.push(`${look}, ${day}: ${fault}`);
      expect(found).toEqual([]);
    }, 300_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const r = await room(orientation);
      const found: string[] = [];
      for (const [kit, theme] of noDemoAndLight(LIGHT_KIT))
        for (const look of looks)
          for (const [day, data, fallback] of days)
            for (const set of day === 'empty' ? [allOn] : [allOn, allOff]) {
              const f = await r.show({ look, ...data, ...set }, theme, NOW, 'UTC', fallback);
              for (const l of await paintedContrast(r.hst.page, f, '.stage')) found.push(`${look}, ${kit}, ${day}${set === allOff ? ', all off' : ''}: ${l}`);
            }
      expect(found).toEqual([]);
    }, 300_000);

  // The unknown state's word is in the kit's muted ink, which a kit may make pale (review of #622: #9ca3af on white
  // read 2.54:1): it is read against the page as free's accent is, at 3:1 for its size.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`"Schedule unavailable" reads under a kit whose muted ink is pale, in every look, ${orientation}`, async () => {
      const r = await room(orientation);
      const pale: FrameTheme = { colors: { ...LIGHT_KIT, muted: '#9ca3af' }, shape: 'soft', fonts: {} };
      const found: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, events: [] }, pale, NOW, 'UTC', ['events']);
        // The word only: the look's other muted texts are its own (Night's and Corporate's labels), whatever the state.
        for (const l of await paintedContrast(r.hst.page, f, '.stage')) if (l.startsWith('word ')) found.push(`${look}: ${l}`);
      }
      expect(found).toEqual([]);
    });

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
      const f = r.hst.frame('fresh');
      expect(await motion(f, durationMs), look).toEqual({
        props: ['opacity', 'transform'],
        withinCap: true,
        unended: [],
        unknown: [],
      });
      // D's motion, read by seeking: nothing loops, not even the clock's colon.
      expect(await motionContract(f, durationMs, { loops: '' }), look).toEqual([]);
    }
  });

  // The board's room status (#news-design): the room's name at title size, no text under 2.6vmin in any look, nothing
  // blinking or pinging, and Night's day as solid bars on a hairline track rather than chips cut to three letters.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`leads with the room's name, keeps every text at 2.6vmin or more and nothing looping, ${orientation}`, async () => {
      const r = await room(orientation);
      const found: string[] = [];
      const day = { events: [booking('Design review', -0.25, 0.75), booking('Quarterly planning', 2, 3), booking('Vendor demo', 4.5, 5)] };
      for (const look of looks) {
        const seen = await (await r.show({ look, ...day })).evaluate(() => {
          for (const a of document.getAnimations()) a.currentTime = 3000;
          const vmin = Math.min(innerWidth, innerHeight) / 100;
          const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
          const texts = [...document.querySelectorAll('.stage *')].filter(
            (el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()),
          );
          const small = texts.filter((el) => Number.parseFloat(getComputedStyle(el).fontSize) < 2.6 * vmin - 0.5).map((el) => el.className || el.tagName);
          return {
            room: Number.parseFloat(getComputedStyle(document.querySelector('.room')!).fontSize) / vmin,
            small: [...new Set(small)],
            loops: document.getAnimations().filter((a) => a.effect!.getComputedTiming().iterations === Number.POSITIVE_INFINITY).length,
            chips: [...document.querySelectorAll('.block .what')].filter(shown).length,
          };
        });
        if (seen.room < 6.5) found.push(`${look}: the room's name is ${seen.room.toFixed(1)}vmin`);
        if (seen.small.length) found.push(`${look}: under 2.6vmin: ${seen.small.join(', ')}`);
        if (seen.loops) found.push(`${look}: ${seen.loops} loops`);
        if (look === 'night' && seen.chips) found.push(`night: ${seen.chips} chips on the track`);
      }
      expect(found).toEqual([]);
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
