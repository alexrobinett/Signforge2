/**
 * The spare template frame (#232): from the page's start, one wrapper frame holding a frame sandboxed as a template's,
 * under a policy that allows nothing, with an empty document. It starts the templates' renderer before the first
 * prepare and keeps it running between templates; it carries no script and is never shown.
 */
import { describe, expect, it } from 'vitest';
import { useHarness } from './harness';

// As on the Pi, so the sandboxed frames run out of process, as there.
const h = useHarness({ siteIsolation: true });

describe('the spare template frame', () => {
  it('is there from the start, sandboxed as a template is, allowing nothing, and stays while spots change', async () => {
    const p = await h.openPlayer((server) =>
      server.publish(
        h.content([
          { id: 'a', durationMs: 800 },
          { id: 'b', durationMs: 800 },
        ]),
      ),
    );
    const spare = () =>
      p.page.evaluate(() => {
        const found = [...document.querySelectorAll('iframe')].filter((f) => f.title === 'Spare template frame');
        const doc = found[0]?.srcdoc ?? '';
        return { count: found.length, hidden: found[0]?.getAttribute('aria-hidden'), doc };
      });
    const first = await spare();
    expect(first.count).toBe(1);
    expect(first.hidden).toBe('true');
    expect(first.doc).toContain(`content="default-src 'none'"`);
    expect(first.doc).toContain('<iframe sandbox="allow-scripts"');
    expect(first.doc).not.toContain('<script');
    await p.until((s) => s.played >= 3);
    expect(await spare()).toEqual(first);
    // Its inner frame holds the empty document, nothing else.
    const inner = p.page.frames().filter((f) => f.parentFrame()?.parentFrame() === p.page.mainFrame() && f.name() === '');
    const bodies = await Promise.all(inner.map((f) => f.evaluate(() => document.body?.innerHTML ?? null).catch(() => undefined)));
    expect(bodies).toContain('');
  });
});
