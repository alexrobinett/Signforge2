/**
 * Test helpers: one headless Chromium per test file, a fresh browser context (so empty Cache
 * Storage and no service worker) and fixture server per test, and readers for the player's
 * live state (`window.__sf`) and its template frames.
 */
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { buildContent, type FixtureSpot } from './content';
import { FixtureServer } from './fixture-server';

/** What the player exposes as `window.__sf`, reduced to what tests read. */
export interface PlayerState {
  manifestId: string;
  playlist: string;
  spot: string;
  played: number;
  skipped: number;
  lastError: string;
  online: boolean;
  /** The id of the last manifest that played a spot. */
  lastGood: string;
  /** The id of a new manifest that played nothing, while the player falls back to `lastGood`; '' otherwise. */
  fallback: string;
  log: { spot: string; manifest: string; startedAt: string }[];
  /** When each data source's current snapshot was fetched. */
  data: Record<string, string>;
  /** Live values refused per data source, and snapshots refused as a whole. */
  dataRejected: Record<string, number>;
  /** False while the panel is off (display hours or an override). */
  displayOn: boolean;
  /** Why the API refused this screen, or ''. */
  auth: string;
  /** Whether the nudge socket is open. */
  socket: boolean;
  /** The pairing code on screen, or '' when none is shown. */
  pairing: string;
  /** The correction from server time, and whether the player trusts its clock. */
  clock: { offsetMs: number; trusted: boolean };
  /** The last 50 prepares: start of loading to ready. */
  prepares: { spot: string; ms: number }[];
}

export interface Player {
  page: Page;
  server: FixtureServer;
  /** Every console line the page printed, `type: text`. */
  console: string[];
  state(): Promise<PlayerState>;
  /** Wait until `predicate(state)` holds. The predicate runs in Node, polled every 100 ms. */
  until(predicate: (s: PlayerState) => boolean, timeoutMs?: number): Promise<PlayerState>;
  /** The label, the listed item titles and the play flag of the template on screen, or undefined if none is. */
  /** `sample`: the size of the sample the template got beside its asset `file`, or ''. */
  onScreen(): Promise<{ label: string; items: string; playing: boolean; sample: string } | undefined>;
}

export interface Harness {
  /** The fixture template bundle, for building content or hosting it directly. */
  templateHtml: string;
  /** The same template in markup that uses every brand token, the brand fonts and the logo. */
  brandTemplateHtml: string;
  content(spots: FixtureSpot[], opts?: Parameters<typeof buildContent>[2]): ReturnType<typeof buildContent>;
  /**
   * Start a fixture server and open the player on it. `query` adds to or overrides the defaults
   * (`poll=1`); give a function to build it from the server (e.g. `content` on `server.localUrl`).
   */
  openPlayer(
    setup?: (server: FixtureServer) => void,
    query?: Record<string, string> | ((server: FixtureServer) => Record<string, string>),
    /** Run the page on Playwright's clock from this instant (`page.clock`): time flows, and a test can jump it. */
    opts?: { clockAt?: Date },
  ): Promise<Player>;
  /** A blank page in a fresh context, for hosting a template without the player. */
  blankPage(): Promise<Page>;
  /** A fixture server for this test, closed after it: the player at its `url`, for a page to frame. */
  playerServer(): Promise<FixtureServer>;
}

/**
 * Register the hooks for one test file and return its harness. `siteIsolation` runs its browser
 * with `--site-per-process`: Chromium on the Pi isolates sites by default, and with that puts each
 * sandboxed template frame in a renderer of its own. The headless shell does neither unless told,
 * and with it crashes on a sandboxed frame in an `about:blank` page, which `blankPage` hosts.
 */
export function useHarness({ siteIsolation = false } = {}): Harness {
  const playerDir = inject('playerDir');
  const templateHtml = inject('templateHtml');
  const brandTemplateHtml = inject('brandTemplateHtml');
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const servers: FixtureServer[] = [];

  beforeAll(async () => {
    // preview.test.ts frames the player (127.0.0.1) from pages on made-up hosts that Playwright
    // answers; Chromium's local network access checks would block that as a public site framing a
    // local one, which is a property of the test setup, not of a CMS deployment.
    browser = await chromium.launch({
      args: [
        ...(siteIsolation ? ['--site-per-process'] : []),
        '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,BlockInsecurePrivateNetworkRequests',
      ],
    });
  });
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    await browser?.close();
  });

  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    contexts.push(context);
    return context.newPage();
  };

  return {
    templateHtml,
    brandTemplateHtml,
    content: (spots, opts) => buildContent(templateHtml, spots, opts),
    blankPage: newPage,
    async playerServer() {
      const server = await FixtureServer.start(playerDir);
      servers.push(server);
      return server;
    },
    async openPlayer(setup, query = {}, opts = {}) {
      const server = await FixtureServer.start(playerDir);
      servers.push(server);
      setup?.(server);
      const page = await newPage();
      const lines: string[] = [];
      page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
      if (opts.clockAt) await page.clock.install({ time: opts.clockAt });
      // The supervisor points at the fixture server, so a real one on this machine is never touched.
      const q = new URLSearchParams({ poll: '1', supervisor: `${server.url}/supervisor`, ...(typeof query === 'function' ? query(server) : query) });
      await page.goto(`${server.url}/?${q}`);

      const state = () =>
        page.evaluate(() => {
          const s = (window as unknown as { __sf?: PlayerState }).__sf;
          if (!s) throw new Error('the player has not started');
          const {
            manifestId,
            playlist,
            spot,
            played,
            skipped,
            lastError,
            online,
            lastGood,
            fallback,
            log,
            data,
            dataRejected,
            displayOn,
            auth,
            socket,
            clock,
            pairing,
            prepares,
          } = s;
          return {
            manifestId,
            playlist,
            spot,
            played,
            skipped,
            lastError,
            online,
            lastGood,
            fallback,
            log: log.map(({ spot, manifest, startedAt }) => ({ spot, manifest, startedAt })),
            data: { ...data },
            dataRejected: { ...dataRejected },
            displayOn,
            auth,
            socket,
            pairing,
            clock: { offsetMs: clock.offsetMs, trusted: clock.trusted },
            prepares: prepares.map(({ spot, ms }) => ({ spot, ms })),
          };
        });
      const until = async (predicate: (s: PlayerState) => boolean, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        let last: PlayerState | undefined;
        while (Date.now() < deadline) {
          last = await state().catch(() => undefined);
          if (last && predicate(last)) return last;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`player state never matched within ${timeoutMs} ms; last: ${JSON.stringify(last)}\nconsole:\n${lines.join('\n')}`);
      };
      const onScreen = async () => {
        const frame = await visibleFrame(page, 'label');
        if (!frame) return undefined;
        return frame.evaluate(() => ({
          label: document.getElementById('label')?.textContent ?? '',
          items: document.getElementById('box')?.textContent ?? '',
          playing: document.body.dataset.playing === '1',
          sample: document.body.dataset.sample ?? '',
        }));
      };
      return { page, server, console: lines, state, until, onScreen };
    },
  };
}

/** The currently visible template frame containing `#<hasId>`, if any. */
export async function visibleFrame(page: Page, hasId: string): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const el = await frame.frameElement().catch(() => undefined);
    const shown = await el?.evaluate((e) => {
      // A template frame sits in a wrapper frame, which sits in the slot.
      const el = e as HTMLElement;
      const slot = (el.ownerDocument.defaultView?.frameElement ?? el).closest<HTMLElement>('.slot');
      return !!slot && slot.style.zIndex === '2' && getComputedStyle(slot).opacity === '1';
    });
    if (!shown) continue;
    if (await frame.evaluate((id) => !!document.getElementById(id), hasId).catch(() => false)) return frame;
  }
  return undefined;
}

/** Minimal valid greyscale PNG of size `w`x`h` with pixel value `shade`, so fixtures have distinct hashes and sizes. */
export function png(w: number, h: number, shade = 128): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array(w).fill(shade)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The ids of the spots played, in order. */
export const spotsPlayed = (s: PlayerState) => s.log.map((l) => l.spot);
