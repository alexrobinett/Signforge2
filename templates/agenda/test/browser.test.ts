import { describe, expect, it } from 'vitest';
import { at, brandColourTests, DEMO_KIT, host, motionContract, screenFrame, spotData, useTemplate, type Update } from '@signforge/template-test';

const update: Update = {
  a: {
    subtitle: 'Main hall',
    events: [
      { title: 'Standup', start: at(1), end: at(2), allDay: false, location: 'Room 1' },
      { title: 'Review', start: at(26), end: at(27), allDay: false, location: 'Room 2' },
      { title: 'Holiday', start: '2026-11-20', end: '2026-11-21', allDay: true, location: '' },
    ],
  },
  b: { events: [{ title: 'Lunch', start: at(-0.5), end: at(1), allDay: false, location: 'Canteen' }], rows: 3 },
};
const t = useTemplate(new URL('..', import.meta.url), update);

describe('template time', () => {
  // Wednesday 2031-01-01 09:30 UTC: years from the machine's own clock, so the device time cannot pass for it.
  const later = Date.parse('2031-01-01T09:30:00Z');

  it('shows the time from init, not the device clock', async () => {
    const hst = await host();
    const text = async (sel: string) => (await hst.frame('fresh').locator(sel).first().textContent())?.trim();
    await hst.open('fresh', t().html);
    await hst.init('fresh', spotData(t().manifest, { events: [] }), {}, later);
    await hst.waitFor('fresh', 'ready', 1);
    expect(await text('#today')).toBe('Wednesday, January 1');
  });
});

brandColourTests(t, {
  spots: (accent) => [[{ accent, events: [...(update.b.events as unknown[]), ...(update.a.events as unknown[])] }]],
  onBackdrop: ['.now .when'],
});

// D's motion (docs/template-spec.md, Motion), read by seeking: every row of a full day.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`moves as D does, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const durationMs = 11_000;
    const events = [...(update.b.events as unknown[]), ...(update.a.events as unknown[])];
    expect(await motionContract(await k.play({ subtitle: 'Main hall', events }, undefined, durationMs), durationMs)).toEqual([]);
  });

// The board's agenda (#news-design): ruled rows on a flat ground, the accent only on what is on now, title-case day
// labels, and one date heading a day.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`rules its rows on a flat ground, keeps the accent to what is on now and heads each day once, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const events = [
      { title: 'Design review', start: at(-0.5), end: at(1), allDay: false, location: 'Product design' },
      { title: 'Quarterly planning', start: at(2), end: at(3), allDay: false, location: 'Operations' },
      { title: 'Candidate interviews', start: at(25), end: at(26), allDay: false, location: 'People team' },
    ];
    const f = await k.play({ events }, { colors: { ...DEMO_KIT, accent: '#ffb547' }, shape: 'soft', fonts: {} });
    const seen = await f.evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 3000;
      const rows = [...document.querySelectorAll<HTMLElement>('.event')];
      const style = (el: Element) => getComputedStyle(el);
      const accent = style(document.querySelector('.now .when')!).color;
      return {
        stage: style(document.querySelector('.stage')!).backgroundImage,
        cards: rows.map((r) => style(r).backgroundColor),
        rules: rows.map((r) => style(r).borderBottomStyle),
        accented: [...document.querySelectorAll('.today, .when, .dow, .mon, .name, .where')]
          .filter((el) => style(el).color === accent)
          .map((el) => el.className),
        days: rows.map((r) => style(r.querySelector('.day')!).visibility),
        labels: [style(rows[0]!.querySelector('.dow')!).textTransform, rows[0]!.querySelector('.dow')!.textContent],
      };
    });
    expect(seen).toEqual({
      stage: 'none',
      cards: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'],
      rules: ['solid', 'solid', 'solid'],
      accented: ['when'],
      days: ['visible', 'hidden', 'visible'],
      labels: ['none', 'Tue'],
    });
  });
