/**
 * The preview content source (M3-36): the real player build, framed by a CMS page, plays the draft
 * that page posts to it, and nothing anyone else posts.
 *
 * The player is built with `CMS_ORIGIN` set to `http://cms.test` (global-setup.ts) and served by the
 * fixture server on 127.0.0.1, so the CMS page is on another origin. Pages on `cms.test` and
 * `evil.test` are answered by Playwright's routing, not by a server.
 */
import type { DataSnapshot } from '@signforge/contract';
import type { Frame, Page } from 'playwright';
import { describe, expect, inject, it } from 'vitest';
import type { Content, FixtureSpot } from './content';
import type { FixtureServer } from './fixture-server';
import { useHarness, type PlayerState } from './harness';

const h = useHarness();
const CMS = inject('cmsOrigin');
const EVIL = 'http://evil.test';

type Message = { sfPreview: number; type: string; spot?: string; message?: string };

interface Preview {
  page: Page;
  server: FixtureServer;
  /** Messages the player frame posted to the page. */
  messages(): Promise<Message[]>;
  state(): Promise<PlayerState>;
  until(predicate: (s: PlayerState) => boolean, timeoutMs?: number): Promise<PlayerState>;
  /** Post a draft from the page, with these files inline. */
  post(content: Content, opts?: { inline?: boolean; data?: DataSnapshot[] }): Promise<void>;
  /** The label and list of the template the player shows, and whether it is the frame marked by `mark`. */
  onScreen(): Promise<{ label: string; items: string; marked: boolean } | undefined>;
  /** Tag the template frame on screen, to tell later whether it is still the same frame. */
  mark(): Promise<void>;
}

/** Requests to the CMS blob route, by hash. */
const blobRequests: string[] = [];

/**
 * Open a page at `origin` that frames the player in preview mode. `/api/blobs/<sha>` on cms.test
 * serves the content's files with CORS for the player's origin, as a same-site deployment would
 * with the session cookie. `extra` routes more paths.
 */
async function openPreview(origin: string, content?: Content, extra: Record<string, string> = {}): Promise<Preview> {
  const server = await h.playerServer();
  const page = await h.blankPage();
  const lines: string[] = [];
  page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`));
  blobRequests.length = 0;
  await page.context().route(/^http:\/\/(cms|evil)\.test\//, (route) => {
    const url = new URL(route.request().url());
    const blob = /^\/api\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
    if (url.origin === CMS && blob) {
      blobRequests.push(blob[1]!);
      const body = content?.blobs.get(blob[1]!);
      const cors = { 'access-control-allow-origin': server.url, 'access-control-allow-credentials': 'true' };
      return body ? route.fulfill({ status: 200, body, headers: { ...cors, 'content-type': 'application/octet-stream' } }) : route.fulfill({ status: 404, headers: cors });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: extra[url.pathname] ?? '<!doctype html><title>editor</title><body style="margin:0">' });
  });
  await page.goto(`${origin}/editor`);
  await page.evaluate(
    (src) =>
      new Promise<void>((resolve) => {
        const w = window as unknown as { previewMessages: unknown[] };
        w.previewMessages = [];
        const f = document.createElement('iframe');
        f.name = 'player';
        f.style.cssText = 'width:960px;height:540px;border:0';
        addEventListener('message', (e) => e.source === f.contentWindow && w.previewMessages.push(e.data));
        f.addEventListener('load', () => resolve(), { once: true });
        f.src = src;
        document.body.appendChild(f);
      }),
    `${server.url}/?source=preview`,
  );
  const player = (): Frame => page.frames().find((f) => f.url().startsWith(server.url))!;
  const state = () =>
    player().evaluate(() => {
      const s = (window as unknown as { __sf: PlayerState }).__sf;
      return { ...s, log: s.log.map(({ spot, manifest, startedAt }) => ({ spot, manifest, startedAt })), data: {}, dataRejected: {} };
    });
  const until = async (predicate: (s: PlayerState) => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    let last: PlayerState | undefined;
    while (Date.now() < deadline) {
      last = await state().catch(() => undefined);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`player state never matched; last: ${JSON.stringify(last)}\nconsole:\n${lines.join('\n')}`);
  };
  /** The template frame drawn on top, as the harness's `onScreen` finds it. */
  const shownFrame = async (): Promise<Frame | undefined> => {
    for (const frame of player().childFrames()) {
      const el = await frame.frameElement().catch(() => undefined);
      const shown = await el?.evaluate((e) => (e.parentElement!.style.zIndex === '2' && getComputedStyle(e.parentElement!).opacity === '1'));
      if (shown) return frame;
    }
    return undefined;
  };
  return {
    page,
    server,
    messages: () => page.evaluate(() => (window as unknown as { previewMessages: Message[] }).previewMessages),
    state,
    until,
    async post(c, { inline = true, data } = {}) {
      const files = inline ? [...c.blobs].map(([sha, b]) => [sha, b.toString('utf8')] as const) : [];
      await page.evaluate(
        ({ manifest, files, data }) => {
          const target = (document.querySelector('iframe[name=player]') as HTMLIFrameElement).contentWindow!;
          const blobs = Object.fromEntries(files.map(([sha, text]) => [sha, new Blob([text])]));
          target.postMessage({ sfPreview: 1, type: 'draft', manifest, files: blobs, ...(data ? { data } : {}) }, '*');
        },
        { manifest: c.manifest, files, data },
      );
    },
    async onScreen() {
      const frame = await shownFrame();
      if (!frame) return undefined;
      const marked = await (await frame.frameElement()).evaluate((e) => (e as Element).getAttribute('data-test-mark') === '1');
      return frame.evaluate((marked) => ({ label: document.getElementById('label')?.textContent ?? '', items: document.getElementById('box')?.textContent ?? '', marked }), marked);
    },
    async mark() {
      const frame = await shownFrame();
      await (await frame!.frameElement()).evaluate((e) => (e as Element).setAttribute('data-test-mark', '1'));
    },
  };
}

/** One long spot, so nothing but an update changes what is on screen. */
const draft = (spot: Partial<FixtureSpot> = {}) => h.content([{ id: 'draft', durationMs: 60_000, ...spot }]);

describe('preview content source', () => {
  it('plays a draft posted by the CMS page that frames it, without touching the device API', async () => {
    const p = await openPreview(CMS);
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'listening' });
    const c = draft({ label: 'First draft' });
    await p.post(c);
    const s = await p.until((s) => s.played >= 1);
    expect(s.spot).toBe('draft');
    expect(s.manifestId).toBe(c.manifest.id);
    await expect.poll(p.onScreen).toMatchObject({ label: 'First draft' });
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'playing', manifest: c.manifest.id, spot: 'draft' });
    // No sync, no data loop, no supervisor: the player asked its own origin for nothing but itself.
    expect(p.server.requestsTo(/^\/(content|supervisor)\//)).toEqual([]);
    expect(blobRequests).toEqual([]);
  });

  it('fetches the files it was not sent from the CMS blob route', async () => {
    const c = draft({ label: 'Saved draft', asset: Buffer.from('a saved image') });
    const p = await openPreview(CMS, c);
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'listening' });
    await p.post(c, { inline: false });
    await p.until((s) => s.played >= 1);
    await expect.poll(p.onScreen).toMatchObject({ label: 'Saved draft' });
    expect(blobRequests.sort()).toEqual([...c.blobs.keys()].sort());
  });

  it('plays posted data in place of the fallback', async () => {
    const p = await openPreview(CMS);
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'listening' });
    const c = draft({ items: [{ title: 'Fallback' }], bindings: { items: { source: 'news', path: 'stories' } } });
    const snap: DataSnapshot = { id: 'news', version: 1, fetchedAt: new Date().toISOString(), data: { stories: [{ title: 'Live story' }] } };
    await p.post(c, { data: [snap] });
    await p.until((s) => s.played >= 1);
    await expect.poll(p.onScreen).toMatchObject({ items: 'Live story' });
  });

  it('shows a new draft of the spot on screen at once, in the same template frame', async () => {
    const p = await openPreview(CMS);
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'listening' });
    await p.post(draft({ label: 'Before' }));
    await p.until((s) => s.played >= 1);
    await expect.poll(p.onScreen).toMatchObject({ label: 'Before' });
    await p.mark();

    const next = draft({ label: 'After' });
    await p.post(next);
    // reset + init in the frame already on screen: no reload, no new play, long before the 60 s spot ends.
    await expect.poll(p.onScreen, { timeout: 3000 }).toEqual({ label: 'After', items: '', marked: true });
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'playing', manifest: next.manifest.id, spot: 'draft' });
    expect((await p.state()).played).toBe(1);
  });

  it('ignores a page on any other origin that frames it', async () => {
    const p = await openPreview(EVIL);
    await p.post(draft({ label: 'Hijack' }));
    await new Promise((r) => setTimeout(r, 1500));
    expect((await p.state()).played).toBe(0);
    // Replies go to the CMS origin only, so this page hears nothing.
    expect(await p.messages()).toEqual([]);
    expect(blobRequests).toEqual([]);
  });

  it('ignores another origin posting to it while the CMS frames it', async () => {
    const hijack = draft({ label: 'Hijack' });
    const attack = `<!doctype html><script>parent.frames.player.postMessage(${JSON.stringify({ sfPreview: 1, type: 'draft', manifest: hijack.manifest })}, '*'); document.title = 'sent';</script>`;
    const p = await openPreview(CMS, hijack, { '/attack': attack });
    await expect.poll(p.messages).toContainEqual({ sfPreview: 1, type: 'listening' });
    await p.page.evaluate(
      (src) =>
        new Promise<void>((resolve) => {
          const f = document.createElement('iframe');
          f.addEventListener('load', () => resolve(), { once: true });
          f.src = src;
          document.body.appendChild(f);
        }),
      `${EVIL}/attack`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect((await p.state()).played).toBe(0);
    expect(blobRequests).toEqual([]);

    // Still listening to the CMS.
    await p.post(draft({ label: 'Real draft' }));
    await p.until((s) => s.played >= 1);
    await expect.poll(p.onScreen).toMatchObject({ label: 'Real draft' });
  });
});
