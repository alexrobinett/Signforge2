/**
 * The spare template frame (#232): from the page's start, a frame sandboxed with no allowances, in a wrapper as a
 * template's is, under a policy that allows nothing, with an empty document. It starts the templates' renderer before the first prepare, so a
 * template's frame joins it rather than a new one, and it can reach nothing a template cannot.
 */
import type { Frame } from 'playwright';
import { describe, expect, it } from 'vitest';
import { NO_REACH, reachOf, useHarness } from './harness';

// As on the Pi, so the sandboxed frames run out of process, as there.
const h = useHarness({ siteIsolation: true });

describe('the spare template frame', () => {
  it('starts the renderer the first template joins, so playing one starts no new process', async () => {
    // Nothing to play yet: the spare alone.
    const p = await h.openPlayer(() => undefined);
    const browser = await p.page.context().browser()!.newBrowserCDPSession();
    const sandboxed = async () => (await browser.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe' && t.url === 'about:srcdoc');
    await expect.poll(async () => (await sandboxed()).length).toBe(1);
    const renderers = async () =>
      new Set(
        ((await browser.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] }).processInfo
          .filter((x) => x.type === 'renderer')
          .map((x) => x.id),
      );
    const before = await renderers();
    p.server.publish(h.content([{ id: 'a', durationMs: 5000 }]));
    await p.until((s) => s.spot === 'a');
    // The template's frame is out of process, beside the spare, in the renderer the spare started.
    expect((await sandboxed()).length).toBe(2);
    expect(await renderers()).toEqual(before);
  });

  it('keeps an opaque origin, so it cannot reach the player or its storage', async () => {
    const p = await h.openPlayer(() => undefined);
    let inner: Frame | undefined;
    await expect
      .poll(async () => {
        for (const f of p.page.frames()) {
          const wrapper = f.parentFrame();
          const title = wrapper && wrapper !== p.page.mainFrame() ? await (await wrapper.frameElement()).getAttribute('title') : null;
          if (title === 'Spare template frame') inner = f;
        }
        return inner !== undefined;
      })
      .toBe(true);
    expect(await reachOf(inner!)).toEqual(NO_REACH);
    expect(await inner!.evaluate(() => document.body.innerHTML)).toBe('');
  });
});
