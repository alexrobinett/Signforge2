import { describe, expect, it } from 'vitest';
import { at, brandColourTests, host, spotData, useTemplate, type Update } from '@signforge/template-test';

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
    const text = async (sel: string) => (await hst.page.mainFrame().childFrames()[0]!.locator(sel).first().textContent())?.trim();
    await hst.open('fresh', t().html);
    await hst.init('fresh', spotData(t().manifest, { events: [] }), {}, later);
    await hst.waitFor('fresh', 'ready', 1);
    expect(await text('#today')).toBe('Wednesday, January 1');
  });
});

brandColourTests(t, {
  spots: (accent) => [[{ accent, events: [...(update.b.events as unknown[]), ...(update.a.events as unknown[])] }]],
  onBackdrop: ['.today', '.now .mon', '.event:not(.now) .mon'],
});
