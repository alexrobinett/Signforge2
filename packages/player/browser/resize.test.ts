/**
 * A screen whose output changes size while it plays (#457): a rotation, an HDMI mode change. Each
 * test changes the page's viewport with Playwright and waits on what the template frame reports,
 * so nothing here depends on how fast the machine is.
 */
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { buildContent, TEMPLATE_KEY } from './content';
import { useHarness, visibleFrame } from './harness';

const h = useHarness();

const LANDSCAPE = { width: 960, height: 540 };
const PORTRAIT = { width: 540, height: 960 };

/** What the fixture template on top reported in its last init, and the size of its wrapper frame. */
async function fitted(page: Page) {
  const frame = await visibleFrame(page, 'label');
  if (!frame) return undefined;
  const wrapper = await (await frame.frameElement()).evaluate((e) => {
    const r = e.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect();
    return r && `${r.width}x${r.height}`;
  });
  const body = await frame.evaluate(() => ({ ...document.body.dataset }));
  return { viewport: body.viewport, inits: body.inits, playing: body.playing, wrapper };
}

describe('resize while playing', () => {
  it('fits the template on screen to a rotation and back, one init each, and plays it again', async () => {
    const p = await h.openPlayer((s) => s.publish(h.content([{ id: 'a', durationMs: 60_000 }])));
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '960x540 landscape', inits: '1', playing: '1', wrapper: '960x540' });

    await p.page.setViewportSize(PORTRAIT);
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '540x960 portrait', inits: '2', playing: '1', wrapper: '540x960' });

    await p.page.setViewportSize(LANDSCAPE);
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '960x540 landscape', inits: '3', playing: '1', wrapper: '960x540' });
    expect((await p.state()).spot).toBe('a');
  });

  it('does not init again for resizes that leave the size as it was', async () => {
    const p = await h.openPlayer((s) => s.publish(h.content([{ id: 'a', durationMs: 60_000 }])));
    await expect.poll(() => fitted(p.page)).toMatchObject({ inits: '1', playing: '1' });
    await p.page.evaluate(() => {
      for (let i = 0; i < 10; i++) dispatchEvent(new Event('resize'));
    });
    // A rotation after them is the next init: the burst before it took none.
    await p.page.setViewportSize(PORTRAIT);
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '540x960 portrait', inits: '2', playing: '1' });
  });

  it('letterboxes a landscape-only template again when the screen turns portrait', async () => {
    const content = h.content([{ id: 'a', durationMs: 60_000 }], {
      edit: (m) => {
        const t = m.templates[TEMPLATE_KEY]!;
        m.templates[TEMPLATE_KEY] = { ...t, manifest: { ...t.manifest, orientations: ['landscape'], background: '#123456' } };
      },
    });
    const p = await h.openPlayer((s) => s.publish(content));
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '960x540 landscape', playing: '1' });

    await p.page.setViewportSize(PORTRAIT);
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '540x303.75 landscape', inits: '2', playing: '1', wrapper: '540x303.75' });
    const bg = await p.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.slot')].map((s) => s.style.getPropertyValue('--slot-bg')));
    expect(bg).toContain('#123456');
  });

  it('shows the next spot, loaded before the rotation, at the new size', async () => {
    // `b` starts loading at once: `a` is no longer than the lead the next spot is prepared with.
    const p = await h.openPlayer((s) =>
      s.publish(
        h.content([
          { id: 'a', durationMs: 3000 },
          { id: 'b', durationMs: 60_000 },
        ]),
      ),
    );
    await p.until((s) => s.spot === 'a');
    await expect
      .poll(() => Promise.all(p.page.frames().map((f) => f.evaluate(() => document.getElementById('label')?.textContent).catch(() => undefined))))
      .toContain('b');

    await p.page.setViewportSize(PORTRAIT);
    await p.until((s) => s.spot === 'b');
    await expect.poll(() => fitted(p.page)).toMatchObject({ viewport: '540x960 portrait', playing: '1', wrapper: '540x960' });
  });

  it('reloads a protocol 1 template at the new size, since it cannot reset', async () => {
    const html = `<!doctype html><body style="margin:0;background:#000;color:#fff"><div id="label"></div><script>"use strict";
addEventListener('message', (e) => {
  if (e.data?.sf !== 1) return;
  if (e.data.type === 'init') {
    document.getElementById('label').textContent = e.data.viewport.width + 'x' + e.data.viewport.height;
    parent.postMessage({ sf: 1, type: 'ready' }, '*');
  }
  if (e.data.type === 'play') document.body.dataset.playing = '1';
});
parent.postMessage({ sf: 1, type: 'loaded' }, '*');
</script>`;
    const content = buildContent(html, [{ id: 'a', durationMs: 60_000 }], {
      edit: (m) => {
        const t = m.templates[TEMPLATE_KEY]!;
        m.templates[TEMPLATE_KEY] = { ...t, manifest: { ...t.manifest, protocol: 1 } };
      },
    });
    const p = await h.openPlayer((s) => s.publish(content));
    await expect.poll(p.onScreen).toMatchObject({ label: '960x540', playing: true });

    await p.page.setViewportSize(PORTRAIT);
    await expect.poll(p.onScreen).toMatchObject({ label: '540x960', playing: true });
  });
});
