/**
 * Test helpers: one headless Chromium per test file, a fresh browser context (so empty Cache
 * Storage and no service worker) and fixture server per test, and readers for the player's
 * live state (`window.__sf`) and its template frames.
 */
import { afterAll, afterEach, beforeAll, inject } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
  onScreen(): Promise<{ label: string; items: string; playing: boolean } | undefined>;
}

export interface Harness {
  /** The fixture template bundle, for building content or hosting it directly. */
  templateHtml: string;
  content(spots: FixtureSpot[], opts?: Parameters<typeof buildContent>[2]): ReturnType<typeof buildContent>;
  /** Start a fixture server and open the player on it. `query` adds to or overrides the defaults (`poll=1`). */
  openPlayer(setup?: (server: FixtureServer) => void, query?: Record<string, string>): Promise<Player>;
  /** A blank page in a fresh context, for hosting a template without the player. */
  blankPage(): Promise<Page>;
  /** A fixture server for this test, closed after it: the player at its `url`, for a page to frame. */
  playerServer(): Promise<FixtureServer>;
}

/** Register the hooks for one test file and return its harness. */
export function useHarness(): Harness {
  const playerDir = inject('playerDir');
  const templateHtml = inject('templateHtml');
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const servers: FixtureServer[] = [];

  beforeAll(async () => {
    // preview.test.ts frames the player (127.0.0.1) from pages on made-up hosts that Playwright
    // answers; Chromium's local network access checks would block that as a public site framing a
    // local one, which is a property of the test setup, not of a CMS deployment.
    browser = await chromium.launch({
      args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,BlockInsecurePrivateNetworkRequests'],
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
    content: (spots, opts) => buildContent(templateHtml, spots, opts),
    blankPage: newPage,
    async playerServer() {
      const server = await FixtureServer.start(playerDir);
      servers.push(server);
      return server;
    },
    async openPlayer(setup, query = {}) {
      const server = await FixtureServer.start(playerDir);
      servers.push(server);
      setup?.(server);
      const page = await newPage();
      const lines: string[] = [];
      page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
      // The supervisor points at the fixture server, so a real one on this machine is never touched.
      const q = new URLSearchParams({ poll: '1', supervisor: `${server.url}/supervisor`, ...query });
      await page.goto(`${server.url}/?${q}`);

      const state = () =>
        page.evaluate(() => {
          const s = (window as unknown as { __sf?: PlayerState }).__sf;
          if (!s) throw new Error('the player has not started');
          const { manifestId, playlist, spot, played, skipped, lastError, online, lastGood, fallback, log, data, dataRejected } = s;
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
          if (!(await frame.evaluate(() => !!document.getElementById('label')).catch(() => false))) continue;
          return frame.evaluate(() => ({
            label: document.getElementById('label')?.textContent ?? '',
            items: document.getElementById('box')?.textContent ?? '',
            playing: document.body.dataset.playing === '1',
          }));
        }
        return undefined;
      };
      return { page, server, console: lines, state, until, onScreen };
    },
  };
}

/** The ids of the spots played, in order. */
export const spotsPlayed = (s: PlayerState) => s.log.map((l) => l.spot);
