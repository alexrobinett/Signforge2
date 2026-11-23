import { describe, expect, it } from 'vitest';
import { brandColourTests, host, spotData, useTemplate } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), { a: { greeting: 'Welcome', message: 'Doors open at 6', seconds: true }, b: { hour24: true } });

describe('template time', () => {
  // Wednesday 2031-01-01 09:30 UTC: years from the machine's own clock, so the device time cannot pass for it.
  const later = Date.parse('2031-01-01T09:30:00Z');

  it('shows the time from init, not the device clock', async () => {
    const hst = await host();
    const text = async (sel: string) => (await hst.page.mainFrame().childFrames()[0]!.locator(sel).first().textContent())?.trim();
    await hst.open('fresh', t().html);
    await hst.init('fresh', spotData(t().manifest, {}), {}, later);
    await hst.waitFor('fresh', 'ready', 1);
    expect(await text('#hm')).toBe('9:30');
    expect(await text('#date')).toBe('Wednesday, January 1');
  });
});

brandColourTests(t, { spots: (accent) => [[{ accent }]], onBackdrop: ['.greeting'] });
