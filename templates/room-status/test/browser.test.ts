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
      async show(data: Data, theme?: FrameTheme, now = NOW, timezone = 'UTC') {
        await hst.init('fresh', spotData(t().manifest, data), {}, now, theme, false, 8000, timezone);
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

  /** The layout's faults, the now line and the pin counted as text, and a schedule drawn empty. */
  const faults = async (f: Frame) => [
    ...(await layoutFaults(f, '.nowline, .pin-pill')),
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
            for (const fault of await faults(await r.show({ look, ...data, ...set }))) found.push(`${look}, ${day}, ${off}: ${fault}`);
          }
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
      const f = r.hst.frame('fresh');
      expect(await motion(f, durationMs), look).toEqual({
        props: ['opacity', 'transform'],
        withinCap: true,
        unended: [],
        unknown: [],
      });
      // D's motion, read by seeking; the clock's colon and Night's glow are the room's own loops.
      expect(await motionContract(f, durationMs, { loops: '.lk-crawl, .lk-ping, .colon, .glow' }), look).toEqual([]);
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
