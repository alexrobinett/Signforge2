/**
 * Hostile templates: each tries to reach the network a different way. None may make a request;
 * the spot fails and the next one plays. Templates navigating their own frame are the case the
 * wrapper frame exists for (review A1); the rest were already stopped by the sandbox and the CSP.
 */
import { createSocket } from 'node:dgram';
import { createServer, type AddressInfo } from 'node:net';
import type { Frame } from 'playwright';
import { describe, expect, it } from 'vitest';
import { buildContent, type FixtureMode } from './content';
import { attribute, childPage, childScript } from './fixtures/child';
import { spotsPlayed, useHarness, type Player } from './harness';

// As on the Pi, so a template frame that shares the player's process is seen (the last test).
const h = useHarness({ siteIsolation: true });

/**
 * Open the player on `a`, the hostile spot, `b`. A leak is a request that reached the server, or a
 * popup. (Playwright also reports requests CSP blocked before they were sent, so its request
 * events are not evidence.)
 */
async function hostile(mode: FixtureMode, target?: string, templateHtml = h.templateHtml, evilMs = 800) {
  const popups: string[] = [];
  const p = await h.openPlayer((server) => {
    server.publish(
      buildContent(templateHtml, [
        { id: 'a', durationMs: 800 },
        { id: 'evil', mode, target: target ?? `${server.url}/leak/${mode}`, durationMs: evilMs },
        { id: 'b', durationMs: 800 },
      ]),
    );
  });
  p.page.context().on('page', (popup) => popups.push(popup.url()));
  return { p, leaks: () => [...popups, ...p.server.requestsTo(/^\/leak\//).map((r) => r.path)] };
}

/**
 * Wait until `b` has played after the hostile spot, then until a request the page sends after that
 * has reached the server: a late request the hostile frame sent before it went has had its chance to land.
 */
async function afterEvil(p: Player) {
  const s = await p.until((s) => spotsPlayed(s).includes('b'));
  await p.page.evaluate(() => fetch('/probe', { cache: 'no-store' }).then(() => undefined));
  expect(p.server.requestsTo(/^\/probe$/)).toHaveLength(1);
  return s;
}

/**
 * A STUN server (UDP) and a TURN server (TCP) on loopback, as `iceServers` URLs, and what reached
 * them. The CSP has no say over WebRTC: a STUN request leaves over UDP, a TURN allocation over TCP.
 */
async function iceServers() {
  const udp = createSocket('udp4');
  let datagrams = 0;
  udp.on('message', () => datagrams++);
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const connections: string[] = [];
  const tcp = createServer((socket) => {
    connections.push(String(socket.remoteAddress));
    socket.destroy();
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  return {
    servers: `stun:127.0.0.1:${udp.address().port} turn:127.0.0.1:${(tcp.address() as AddressInfo).port}?transport=tcp`,
    sent: () => ({ datagrams, connections }),
    async [Symbol.asyncDispose]() {
      udp.close();
      await new Promise((resolve) => tcp.close(resolve));
    },
  };
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

  it('is stopped and skipped when it navigates as it starts to play, and the next spot cuts in (#522)', async () => {
    // An hour long: b plays within the wait only if evil gives way when it dies.
    const { p, leaks } = await hostile('navigate-on-play', undefined, h.templateHtml, 3_600_000);
    const s = await afterEvil(p);
    // Never played: had its play counted before the navigation landed, it is taken back (#528).
    expect(spotsPlayed(s)).toEqual(['a', 'b']);
    expect(s.lastError).toBe('evil: template navigated away');
    // Its frame is gone: no template on the page still shows it.
    const labels = await Promise.all(p.page.frames().map((f) => f.evaluate(() => document.getElementById('label')?.textContent).catch(() => undefined)));
    expect(labels).not.toContain('evil');
    expect(p.console.some((l) => l.includes('navigated'))).toBe(true);
    expect(leaks()).toEqual([]);
  });
});

describe('a template that loads from the network', () => {
  const loads: FixtureMode[] = ['form', 'open', 'iframe', 'fetch', 'image', 'font', 'external-script'];
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

describe('a template that opens a peer connection', () => {
  // Its own window; a frame it adds whose constructor it reads; a frame it adds, or that its markup
  // holds, running script of its own (fixtures/child.ts).
  const modes = [
    'webrtc',
    'webrtc-frame',
    'webrtc-srcdoc',
    'webrtc-srcdoc-sandboxed',
    'webrtc-srcdoc-same-origin',
    'webrtc-javascript-url',
    'webrtc-grandchild',
    'webrtc-markup',
  ] as const;
  for (const mode of modes) {
    it(`gathers no candidate and sends nothing: ${mode}`, async () => {
      await using ice = await iceServers();
      const html =
        mode === 'webrtc-markup' ? h.templateHtml.replace('<body>', `<body><iframe srcdoc="${attribute(childPage(ice.servers, 1))}"></iframe>`) : undefined;
      const { p, leaks } = await hostile(mode, ice.servers, html);
      const s = await afterEvil(p);
      expect({ leaks: leaks(), ...ice.sent() }).toEqual({ leaks: [], datagrams: 0, connections: [] });
      expect(s.lastError).toMatch(new RegExp(`^evil: .*${mode} was refused`));
      expect(spotsPlayed(s)).toEqual(['a', 'b']);
    });
  }

  // A hash allows a text whatever the script's type: the template copies one of its own classic
  // scripts (which cannot run as one: it declares a global `window`) into a frame it adds, as a module,
  // where `function window` would take a guard that named `window`.
  it('gathers no candidate and sends nothing: a module copy of its own classic script, in a frame it adds', async () => {
    await using ice = await iceServers();
    const scripts =
      `<script id="copied">"use strict";function window() {} var self, globalThis; ${childScript(ice.servers, 1)}</script>` +
      `<script>"use strict";const f = document.createElement('iframe'); f.srcdoc = '<script type="module">' + document.getElementById('copied').textContent + '</scr' + 'ipt>'; document.body.appendChild(f);</script>`;
    const { p } = await hostile('webrtc-markup', ice.servers, h.templateHtml.replace('<body>', `<body>${scripts}`));
    // The driver ran: a frame below the template holds the module. Its run was reached: the guard
    // throws there, `this` being undefined (checked last, so with no guard the packets fail the test).
    await expect
      .poll(async () => {
        for (const f of p.page.frames()) if (await f.evaluate(() => !!document.querySelector('script[type=module]')).catch(() => false)) return true;
        return false;
      })
      .toBe(true);
    const s = await afterEvil(p);
    expect(ice.sent()).toEqual({ datagrams: 0, connections: [] });
    expect(p.console.some((l) => /pageerror: .*undefined/.test(l))).toBe(true);
    expect(spotsPlayed(s)).toEqual(['a', 'b']);
  });
});

describe('a template whose script tries to run before the guard, or shadows the names of the global object', () => {
  // Scripts added to the template's markup ahead of its own, which still plays. Each opens a peer
  // connection with `RTCPeerConnection` after binding `window`, `self` and `globalThis` itself.
  const shadowing: Record<string, (servers: string) => string> = {
    'classic, unwrapped': (s) => `<script>"use strict";var window, self; globalThis = {}; ${childScript(s, 0)}</script>`,
    'classic, wrapped': (s) => `<script>"use strict";(function (window, self, globalThis) { ${childScript(s, 0)} })({}, {}, {})</script>`,
    module: (s) => `<script type="module">function window() {} const self = {}, globalThis = {}; ${childScript(s, 0)}</script>`,
    // JavaScript ends a line comment at U+2028 and U+2029 too: the peer connection is code, on the comment's line.
    'a line comment ended by U+2028': (s) => `<script>"use strict";// a note\u2028${childScript(s, 0).replaceAll('\n', ' ')}</script>`,
    'a line comment ended by U+2029': (s) => `<script>"use strict";// a note\u2029${childScript(s, 0).replaceAll('\n', ' ')}</script>`,
  };
  for (const [name, scripts] of Object.entries(shadowing)) {
    it(`gathers no candidate and sends nothing: ${name}`, async () => {
      await using ice = await iceServers();
      const { p } = await hostile('webrtc-markup', ice.servers, h.templateHtml.replace('<body>', `<body>${scripts(ice.servers)}`));
      const s = await afterEvil(p);
      expect(ice.sent()).toEqual({ datagrams: 0, connections: [] });
      expect(spotsPlayed(s)).toEqual(['a', 'b']);
    });
  }
});

describe('the template frame', () => {
  it('shows text that only looks like a script as written: a textarea holding one', async () => {
    const example = '<script>"use strict";x()</script>';
    const html = h.templateHtml.replace('<body>', `<body><textarea id="example">${example}</textarea>`);
    const p = await h.openPlayer((server) => server.publish(buildContent(html, [{ id: 'a', durationMs: 5000 }])));
    await p.until((s) => s.played >= 1);
    const values: string[] = [];
    for (const f of p.page.frames()) {
      const v = await f.evaluate(() => (document.getElementById('example') as HTMLTextAreaElement | null)?.value).catch(() => undefined);
      if (v !== undefined) values.push(v);
    }
    expect(values).toEqual([example]);
  });

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
