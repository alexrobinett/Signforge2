import { describe, expect, it } from 'vitest';
import { brandColourTests, host, motionContract, screenFrame, spotData, useTemplate } from '@signforge/template-test';

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

// D's motion (docs/template-spec.md, Motion), read by seeking: greeting, time with seconds, date and message. The
// block's slow drift is the clock's one loop: no pixel holds still for the hour a clock is left up.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`moves as D does, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const durationMs = 11_000;
    const f = await k.play({ greeting: 'Welcome', message: 'Doors open at 6', seconds: true }, undefined, durationMs);
    expect(await motionContract(f, durationMs, { loops: '.content' })).toEqual([]);
  });

// The board's clock (#news-design): the time hangs on the centre line whether or not there is a message, and the
// greeting, date and message share one size.
for (const orientation of ['landscape', 'portrait'] as const)
  it(`keeps the time on one line with or without a message, and one size for the words around it, ${orientation}`, async () => {
    const k = await screenFrame(t(), orientation, {});
    const read = async (message: string) =>
      (await k.play({ greeting: 'Welcome', message })).evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 2000;
        // Against the block it sits in, which the burn-in drift moves as a whole.
        const time = document.querySelector('.time')!.getBoundingClientRect();
        const block = document.querySelector('.content')!.getBoundingClientRect();
        const size = (sel: string) => getComputedStyle(document.querySelector(sel)!).fontSize;
        return { middle: Math.round(time.top + time.height / 2 - (block.top + block.height / 2)), sizes: [size('.greeting'), size('.date'), size('.message')] };
      });
    const [without, withMessage] = [await read(''), await read('Doors open at 6')];
    expect(without.middle).toBeCloseTo(0, 0);
    expect(withMessage.middle).toBeCloseTo(0, 0);
    expect(new Set(withMessage.sizes).size).toBe(1);
  });
