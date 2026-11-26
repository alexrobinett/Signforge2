/**
 * The Frame host (#331) through its own interface, once: player-core's `openFrameHost` bundled for a
 * page (`frameHostJs`), on the fixture template's frames as the player contains them. The handshake,
 * `play` and `reset`, a template's error, the guard against a navigation before and after it is ready,
 * and the ready timeout on a reset. The player's suites test it as the slot drives it.
 */
import { containedFrames } from '@signforge/player-core';
import type { Page } from 'playwright';
import { describe, expect, inject, it } from 'vitest';
import { useHarness } from './harness';

// Sites isolated, as on the Pi: the headless shell crashes on a sandboxed frame otherwise (harness.ts).
const h = useHarness({ siteIsolation: true });
const HOST = 'http://host.test/';

/** What the first `init` carries: the fixture's label, in its ordinary mode. */
const firstInit = () => ({
  timezone: 'UTC',
  locale: 'en-US',
  viewport: { width: 960, height: 540 },
  orientation: 'landscape',
  clock: { offsetMs: 0, now: Date.now() },
  durationMs: 5000,
  data: { mode: 'ok', label: 'First' },
  assets: {},
});

/** A page with the host's script, and a host opened on `templateHtml`'s contained frames, its `init` from `window.sfInit`. */
async function hostPage(templateHtml = h.templateHtml, opts: { clock?: boolean } = {}): Promise<Page> {
  const page = await h.blankPage();
  await page
    .context()
    .route(HOST, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Frame host</title><body style="margin:0">' }));
  if (opts.clock) await page.clock.install();
  await page.goto(HOST);
  await page.addScriptTag({ content: inject('frameHostJs') });
  await page.evaluate(
    async ({ frames, init }) => {
      type Host = { start(): Promise<number | null>; reset(): Promise<number | null>; play(): void };
      const w = window as unknown as {
        SFFrameHost: { openFrameHost(o: unknown): Promise<Host> };
        sfHost: Host;
        sfInit: Record<string, unknown>;
        sfNavigated: number;
        sfAbort: AbortController;
      };
      w.sfNavigated = 0;
      w.sfAbort = new AbortController();
      w.sfInit = init;
      w.sfHost = await w.SFFrameHost.openFrameHost({
        container: document.body,
        frames,
        protocol: 2,
        title: 'Fixture',
        size: { width: 960, height: 540 },
        init: () => w.sfInit,
        label: 'fixture',
        signal: w.sfAbort.signal,
        onNavigatedAway: () => w.sfNavigated++,
      });
    },
    { frames: containedFrames(templateHtml), init: firstInit() },
  );
  return page;
}

/** Call the host's `start` or `reset` in the page: its time, or the message it rejected with. */
const call = (page: Page, what: 'start' | 'reset') =>
  page.evaluate(async (what) => {
    try {
      return { ms: await (window as unknown as { sfHost: Record<string, () => Promise<number | null>> }).sfHost[what]!() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, what);

const setData = (page: Page, data: Record<string, unknown>) =>
  page.evaluate((data) => Object.assign((window as unknown as { sfInit: Record<string, unknown> }).sfInit, { data }), data);

/** The fixture's label and play mark, in the template's frame on the page; undefined once it is gone. */
async function shown(page: Page) {
  const frame = page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());
  if (!frame) return undefined;
  return frame
    .evaluate(() => ({ label: document.getElementById('label')?.textContent ?? '', playing: document.body.dataset.playing === '1' }))
    .catch(() => undefined);
}

describe('the Frame host (#331)', () => {
  it('answers loaded with init, reports ready with its time from init, plays, and takes new data with reset', async () => {
    const page = await hostPage();
    const first = await call(page, 'start');
    expect(first).toEqual({ ms: expect.any(Number) });
    expect(await shown(page)).toEqual({ label: 'First', playing: false });
    await page.evaluate(() => (window as unknown as { sfHost: { play(): void } }).sfHost.play());
    await expect.poll(() => shown(page)).toEqual({ label: 'First', playing: true });
    // A reset: loaded again, and the init it gets is what init() gives now.
    await setData(page, { label: 'Second', mode: 'ok' });
    expect(await call(page, 'reset')).toEqual({ ms: expect.any(Number) });
    expect(await shown(page)).toEqual({ label: 'Second', playing: false });
    // The frames: the wrapper the host wrote, and the template's sandboxed inside it.
    const sandbox = await page.evaluate(() => {
      const wrapper = document.querySelector('iframe')!;
      return { title: wrapper.title, sandbox: wrapper.contentDocument!.querySelector('iframe')!.getAttribute('sandbox') };
    });
    expect(sandbox).toEqual({ title: 'Fixture', sandbox: 'allow-scripts' });
  });

  it("rejects with the template's error", async () => {
    const page = await hostPage();
    await setData(page, { label: 'Bad', mode: 'throw' });
    expect(await call(page, 'start')).toEqual({ error: 'template error: fixture prepare failed' });
  });

  it('rejects the start of a template that navigates away before it is ready, and removes its frames', async () => {
    const page = await hostPage();
    await setData(page, { label: 'Away', mode: 'navigate', target: 'https://away.test/' });
    expect(await call(page, 'start')).toEqual({ error: 'template navigated away' });
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { sfNavigated: number }).sfNavigated)).toBe(0);
  });

  it('says so once a template that was ready navigates away, and removes its frames', async () => {
    const page = await hostPage();
    await setData(page, { label: 'Later', mode: 'navigate-on-play', target: 'https://away.test/' });
    expect(await call(page, 'start')).toEqual({ ms: expect.any(Number) });
    await page.evaluate(() => (window as unknown as { sfHost: { play(): void } }).sfHost.play());
    await expect.poll(() => page.evaluate(() => (window as unknown as { sfNavigated: number }).sfNavigated)).toBe(1);
    expect(await page.locator('iframe').count()).toBe(0);
  });

  it('gives up on a reset the template does not answer within the ready timeout', async () => {
    const page = await hostPage(h.templateHtml, { clock: true });
    expect(await call(page, 'start')).toEqual({ ms: expect.any(Number) });
    await setData(page, { label: 'Stuck', mode: 'hang' });
    const reset = call(page, 'reset');
    // The page's clock is Playwright's: the timeout passes when the test says, not after 2 s of waiting.
    await expect.poll(() => shown(page)).toMatchObject({ label: 'Stuck' });
    await page.clock.fastForward(2000);
    expect(await reset).toEqual({ error: 'not ready within 2000 ms' });
  });

  it('reports no time for a ready that came with no init', async () => {
    // A template that says ready before it is told anything.
    const page = await hostPage('<!doctype html><body><script>"use strict";parent.postMessage({ sf: 2, type: "ready" }, "*");</script></body>');
    expect(await call(page, 'start')).toEqual({ ms: null });
  });
});
