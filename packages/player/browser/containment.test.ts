/**
 * Hostile templates: each tries to reach the network a different way. None may make a request;
 * the spot fails and the next one plays. Templates navigating their own frame are the case the
 * wrapper frame exists for (review A1); the rest were already stopped by the sandbox and the CSP.
 */
import type { Frame } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { FixtureMode } from './content';
import { spotsPlayed, useHarness, type Player } from './harness';

// As on the Pi, so a template frame that shares the player's process is seen (the last test).
const h = useHarness({ siteIsolation: true });

/**
 * Open the player on `a`, the hostile spot, `b`. A leak is a request that reached the server, or a
 * popup. (Playwright also reports requests CSP blocked before they were sent, so its request
 * events are not evidence.)
 */
async function hostile(mode: FixtureMode) {
  const popups: string[] = [];
  const p = await h.openPlayer((server) => {
    server.publish(
      h.content([
        { id: 'a', durationMs: 800 },
        { id: 'evil', mode, target: `${server.url}/leak/${mode}`, durationMs: 800 },
        { id: 'b', durationMs: 800 },
      ]),
    );
  });
  p.page.context().on('page', (popup) => popups.push(popup.url()));
  return { p, leaks: () => [...popups, ...p.server.requestsTo(/^\/leak\//).map((r) => r.path)] };
}

/** Wait until `b` has played after the hostile spot, then give a late request time to land. */
async function afterEvil(p: Player) {
  const s = await p.until((s) => spotsPlayed(s).includes('b'));
  await new Promise((r) => setTimeout(r, 300));
  return s;
}

describe('a template that navigates its own frame', () => {
  const navigations: FixtureMode[] = ['navigate', 'navigate-data', 'navigate-top', 'refresh', 'link'];
  for (const mode of navigations) {
    it(`is stopped and skipped: ${mode}`, async () => {
      const { p, leaks } = await hostile(mode);
      const s = await afterEvil(p);
      expect(leaks()).toEqual([]);
      expect(spotsPlayed(s)).toEqual(['a', 'b']);
      // The player saw the navigation and gave up at once, rather than waiting out the ready timeout.
      expect(s.lastError).toMatch(/^evil: .*navigat/);
    });
  }

  it('is stopped and blanked when it navigates while playing, and the next spot plays', async () => {
    const { p, leaks } = await hostile('navigate-on-play');
    await p.until((s) => spotsPlayed(s).includes('evil'));
    await expect.poll(() => p.console.some((l) => l.includes('navigated'))).toBe(true);
    // Blanked: no template is left on screen during the rest of its play.
    expect(await p.onScreen()).toBeUndefined();
    const s = await afterEvil(p);
    expect(spotsPlayed(s)).toEqual(['a', 'evil', 'b']);
    expect(leaks()).toEqual([]);
  });
});

describe('a template that loads from the network', () => {
  const loads: FixtureMode[] = ['form', 'open', 'iframe', 'fetch', 'image', 'font'];
  for (const mode of loads) {
    it(`makes no request and is skipped: ${mode}`, async () => {
      const { p, leaks } = await hostile(mode);
      const s = await afterEvil(p);
      expect(leaks()).toEqual([]);
      expect(spotsPlayed(s)).toEqual(['a', 'b']);
      expect(s.lastError).toMatch(/^evil: /);
    });
  }
});

describe('the template frame', () => {
  it('keeps an opaque origin, so it cannot reach the player or its storage', async () => {
    const p = await h.openPlayer((server) => server.publish(h.content([{ id: 'a', durationMs: 5000 }])));
    await p.until((s) => s.played >= 1);
    let template: Frame | undefined;
    for (const f of p.page.frames()) if (await f.evaluate(() => !!document.getElementById('label')).catch(() => false)) template = f;
    expect(template).toBeDefined();
    const reach = await template!.evaluate(() => {
      const tries: Record<string, () => unknown> = {
        origin: () => origin,
        top: () => top!.document.title,
        parent: () => parent.document.title,
        caches: () => (typeof caches === 'undefined' ? 'none' : caches.keys()),
        storage: () => localStorage.length,
      };
      return Object.fromEntries(
        Object.entries(tries).map(([k, f]) => {
          try {
            const v = f();
            return [k, v instanceof Promise ? 'promise' : String(v)];
          } catch {
            return [k, 'blocked'];
          }
        }),
      );
    });
    expect(reach).toEqual({ origin: 'null', top: 'blocked', parent: 'blocked', caches: expect.stringMatching(/blocked|none/), storage: 'blocked' });
  });
});

describe('a template frame', () => {
  // So a template that wedges its renderer does not stop the player, or its beat to the supervisor.
  it('runs in a process of its own, not the player’s', async () => {
    const p = await h.openPlayer((server) => server.publish(h.content([{ id: 'a', durationMs: 5000 }])));
    await p.until((s) => s.spot === 'a');
    // A template's frame is the child of a wrapper frame, which is the child of the player.
    const templates = p.page.frames().filter((f) => f.parentFrame()?.parentFrame() === p.page.mainFrame());
    expect(templates.length).toBeGreaterThan(0);
    // DevTools makes a target of type "iframe" only for a frame in another renderer process
    // (IsolateSandboxedIframes); a frame that shares the player's process has none.
    const cdp = await p.page.context().newCDPSession(p.page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const outOfProcess = targetInfos.filter((t) => t.type === 'iframe' && t.url === 'about:srcdoc');
    expect(outOfProcess.length).toBe(templates.length);
  });
});
