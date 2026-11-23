import { describe, expect, it } from 'vitest';
import { at, brandColourTests, host, spotData, useTemplate } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { items: [] },
  b: { source: 'Wire', items: [1, 2, 3].map((i) => ({ title: `Headline ${i}`, published: at(-i), source: 'Wire' })) },
});

describe('template time', () => {
  // Wednesday 2031-01-01 09:30 UTC: years from the machine's own clock, so the device time cannot pass for it.
  const later = Date.parse('2031-01-01T09:30:00Z');

  it('shows the time from init, not the device clock', async () => {
    const hst = await host();
    const text = async (sel: string) => (await hst.page.mainFrame().childFrames()[0]!.locator(sel).first().textContent())?.trim();
    await hst.open('fresh', t().html);
    const items = [{ title: 'Story', published: '2031-01-01T08:30:00Z', source: 'Wire' }];
    await hst.init('fresh', spotData(t().manifest, { items }), {}, later);
    await hst.waitFor('fresh', 'ready', 1);
    expect(await text('#clock')).toBe('9:30 AM');
    expect(await text('#age')).toBe('1 hour ago');
  });
});

brandColourTests(t, {
  spots: (accent) => [[{ accent, items: [{ title: 'Story', published: at(-1), source: 'Wire' }] }]],
  onFill: [['.badge', '.badge', 4.5]],
  onBackdrop: ['.age'],
});
