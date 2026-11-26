/**
 * The runtime check: render a template bundle in headless Chromium, in the frames the player gives
 * it (`containedFrames` and the sandbox from `@signforge/player-core`), with example data, at
 * 1920x1080 in each orientation it supports, and turn everything it tries into problems.
 *
 * What Chromium shows of a blocked attempt: a request the policy blocks never reaches the network
 * stack (no Playwright request event), but Chromium logs it to the console of the frame that made
 * it, out-of-process frames included. The console lines below are Chromium's own, not the
 * template's; a template can add lines that look like them, which only refuses itself. A template
 * frame navigated away lands on an error page. As on a screen, the template's frames have no
 * `RTCPeerConnection`: a template that reaches for it fails as it would there.
 *
 * A template can still behave differently here than on a screen (wait out the check, sniff the
 * browser): this check refuses what it sees. The sandbox and its policy remain the boundary on screens.
 */
import { DEFAULT_BRAND_COLORS, isBrandColor, tokenName } from '@signforge/compiler';
import type { FieldDef, InitPayload, Orientation, ScalarFieldDef, TemplateManifest, TemplateRender } from '@signforge/contract';
import { containedFrames, READY_TIMEOUT_MS } from '@signforge/player-core';
import type { FrameHost } from '@signforge/player-core/frame-host';
import type { Browser, Frame, Page } from 'playwright-core';

/** player-core's Frame host as a script for the host page (frame-host-script.ts): the host the player's slots drive. */
declare const __SF_FRAME_HOST__: string;

/** The page around the template, on an origin of its own that nothing else answers. */
const HOST = 'https://template-check.invalid/';
const VIEWPORTS: Record<Orientation, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};
/** How long a render plays after `ready`: what the template tries in `play` is seen. */
const PLAY_MS = 1000;
/** Console lines can arrive after the frame that logged them went quiet. */
const SETTLE_MS = 250;
/** Spare time for a measurement in a template frame that never answers. */
const GRACE_MS = 2000;

export interface CheckResult {
  problems: string[];
  renders: TemplateRender[];
}

/** Problems carry text the template chose (URLs, error messages): each is cut to this, and their number too. */
const MAX_PROBLEM_CHARS = 200;
const MAX_PROBLEMS = 20;
const clip = (text: string) => (text.length > MAX_PROBLEM_CHARS ? `${text.slice(0, MAX_PROBLEM_CHARS - 3)}...` : text);

/**
 * Chromium's console lines for an attempt it blocked, as problems. Chromium quotes the URL in '...'
 * without escaping it, so the URL runs to the last quote before the fixed words after it.
 */
const BLOCKED: [RegExp, (url: string) => string][] = [
  [/^Framing '(.*)' violates the following Content Security Policy directive/, (u) => `tried to open ${u} in a frame (blocked)`],
  [/^Blocked opening '(.*)' in a new window/, (u) => `tried to open ${u} in a new window (blocked)`],
  [/^Blocked form submission to '(.*)' because/, (u) => `tried to submit a form to ${u} (blocked)`],
  [/^Unsafe attempt to initiate navigation for frame()/, () => 'tried to navigate the page around it (blocked)'],
  // fetch, XHR, WebSocket, beacon, images, fonts, media, prefetch, workers: whatever Chromium calls it.
  [/'(.*)' violates the following Content Security Policy directive/, (u) => `requested ${u} (blocked)`],
];
/** Any other line with these words is something the policy stopped (eval, say): also a problem. */
const CSP_VIOLATION = 'violates the following Content Security Policy directive';
function consoleProblem(text: string): string | undefined {
  for (const [pattern, problem] of BLOCKED) {
    const m = pattern.exec(text);
    if (m) return problem(m[1] ?? '');
  }
  if (text.includes(CSP_VIOLATION)) return `did something the screen's policy blocks: ${text}`;
  return undefined;
}

/** A value of the field's type for a field with no default, so the template gets data it accepts. */
function fallback(def: ScalarFieldDef): unknown {
  switch (def.type) {
    case 'text':
      return def.label;
    case 'number':
      return def.min ?? 0;
    case 'boolean':
      return false;
    case 'color':
      return DEFAULT_BRAND_COLORS.accent;
    case 'select':
      return def.options[0];
    case 'url':
      // The first sample within the field's limit, else empty: a value a spot could hold, never one the contract refuses.
      return URL_SAMPLES.find((u) => !def.maxLength || u.length <= def.maxLength) ?? '';
    case 'date':
    case 'datetime': {
      // A fixed sample, never the day the check runs, so every run renders the same data; moved into the field's range.
      const sample = def.type === 'date' ? '2027-01-15' : '2027-01-15T18:00';
      return def.min !== undefined && sample < def.min ? def.min : def.max !== undefined && sample > def.max ? def.max : sample;
    }
  }
}

/** Sample addresses for a url field, longest first; the shortest is the shortest https address worth drawing. */
const URL_SAMPLES = ['https://example.com/', 'https://x.io'];

/** The given value, else the field's default, else a sample; brand tokens resolved as for a screen with no kit. */
function value(def: ScalarFieldDef, given: unknown): unknown {
  const v = given ?? def.default ?? fallback(def);
  const token = def.type === 'color' ? tokenName(v) : undefined;
  return token && isBrandColor(token) ? DEFAULT_BRAND_COLORS[token] : v;
}

/** Each field's example value, and which fields are images. */
export function exampleData(fields: Record<string, FieldDef>): { data: Record<string, unknown>; images: string[] } {
  const data: Record<string, unknown> = {};
  const images: string[] = [];
  for (const [name, def] of Object.entries(fields)) {
    if (def.type === 'image') images.push(name);
    else if (def.type === 'list')
      data[name] = (def.default ?? []).map((row) =>
        Object.fromEntries(
          Object.entries(def.item).flatMap(([k, d]) => (d.type === 'image' ? (row[k] !== undefined ? [[k, row[k]]] : []) : [[k, value(d, row[k])]])),
        ),
      );
    else data[name] = value(def, undefined);
  }
  return { data, images };
}

interface RenderArgs {
  frames: { wrapper: string; template: string };
  protocol: number;
  init: Omit<InitPayload, 'assets' | 'clock' | 'theme'>;
  images: string[];
  readyTimeoutMs: number;
}

/**
 * Runs in the host page: the screen's Frame host (`window.SFFrameHost`, #331) on one template spot, as
 * a slot drives it. Resolves with the time from `init` to `ready`, or the template's error, or neither
 * when the player would have given up on it: it navigated away (its frame loaded again), the ready
 * timeout passed, or it said ready before it had `init` (the host gives that no time). Leaves `__sfPlay`
 * on the window to send `play`.
 */
async function renderInHost(a: RenderArgs): Promise<{ readyMs: number | null; error: string | null }> {
  const open: unknown = Reflect.get(Reflect.get(window, 'SFFrameHost') ?? {}, 'openFrameHost');
  if (typeof open !== 'function') throw new Error('the host page has no Frame host');
  // One small PNG for every image field: the template gets a real image to decode.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const pixel = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  const assets = Object.fromEntries(a.images.map((name) => [name, pixel]));
  const host: FrameHost = await open({
    container: document.body,
    frames: a.frames,
    protocol: a.protocol,
    title: 'template',
    size: a.init.viewport,
    init: () => ({ ...a.init, assets, clock: { now: Date.now(), offsetMs: 0 } }),
    label: 'template',
    signal: new AbortController().signal,
    // A navigation once ready is seen by the check itself (`framenavigated`).
    onNavigatedAway: () => {},
  });
  Reflect.set(window, '__sfPlay', () => host.play());
  return new Promise((resolve) => {
    // Counted from when the template's frame is added. The player counts from the start of the
    // spot's prepare, a few ms earlier, so this is no stricter than a screen.
    setTimeout(() => resolve({ readyMs: null, error: null }), a.readyTimeoutMs);
    host.start().then(
      (readyMs) => resolve({ readyMs, error: null }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const prefix = 'template error: ';
        resolve({ readyMs: null, error: message.startsWith(prefix) ? message.slice(prefix.length) : null });
      },
    );
  });
}

/** Runs in the template's frame, so the template could skew it: frame intervals for `ms`. */
function countFrames(ms: number): Promise<{ count: number; longestMs: number }> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const step = (t: number) => {
      times.push(t);
      if (t - (times[0] ?? t) < ms) requestAnimationFrame(step);
      else {
        const gaps = times.slice(1).map((x, i) => x - (times[i] ?? x));
        resolve({ count: gaps.length, longestMs: Math.round(Math.max(0, ...gaps) * 10) / 10 });
      }
    };
    requestAnimationFrame(step);
  });
}

const within = <T>(ms: number, work: Promise<T>): Promise<T | undefined> =>
  Promise.race([work, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]).catch(() => undefined);

/** The template's frame: the child of the wrapper, which is the child of the host page. */
const templateFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.parentFrame()?.parentFrame() === page.mainFrame());

async function render(
  browser: Browser,
  manifest: TemplateManifest,
  html: string,
  orientation: Orientation,
): Promise<{ render: TemplateRender; problems: Set<string> }> {
  const viewport = VIEWPORTS[orientation];
  const problems = new Set<string>();
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  try {
    // Nothing but the host page is answered. A request that gets this far got past the policy.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url === HOST)
        return route.fulfill({
          contentType: 'text/html',
          // As a slot shows its frames: no border, a block of its own.
          body: '<!doctype html><title>Template check</title><style>iframe{display:block;border:0}</style><body style="margin:0">',
        });
      problems.add(`requested ${url} (blocked)`);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    context.on('page', () => problems.add('opened a window (blocked)'));
    page.on('console', (m) => {
      const problem = consoleProblem(m.text());
      if (problem) problems.add(problem);
    });
    page.on('pageerror', (e) => problems.add(`threw an uncaught error: ${e.message}`));
    let navigated = false;
    page.on('framenavigated', (f) => {
      // A new fragment keeps the document (no second load), so the player does not count it either.
      if (f !== templateFrame(page) || f.url().split('#')[0] === 'about:srcdoc') return;
      navigated = true;
      problems.add('navigated its own frame (blocked)');
    });
    await page.goto(HOST);
    // Inline: nothing is requested, so the rule above, that nothing but the host page is answered, stands.
    await page.addScriptTag({ content: __SF_FRAME_HOST__ });

    const { data, images } = exampleData(manifest.fields);
    const args: RenderArgs = {
      frames: containedFrames(html),
      protocol: manifest.protocol ?? 1,
      init: { data, durationMs: manifest.duration.defaultMs, orientation, viewport, timezone: 'UTC', locale: 'en-US' },
      images,
      readyTimeoutMs: READY_TIMEOUT_MS,
    };
    const { readyMs, error } = await page.evaluate(renderInHost, args);
    // The SDK forwards an uncaught error as `Uncaught <name>: <message>`; Chromium's own report of it is the problem.
    if (error !== null && !error.startsWith('Uncaught ')) problems.add(`failed to prepare: ${error}`);

    let frames: TemplateRender['frames'] = null;
    if (readyMs !== null) {
      await page.evaluate(() => {
        const play: unknown = Reflect.get(window, '__sfPlay');
        if (typeof play === 'function') play();
      });
      const counted = await within(PLAY_MS + GRACE_MS, templateFrame(page)?.evaluate(countFrames, PLAY_MS) ?? Promise.resolve(undefined));
      // Numbers from the template's own frame: kept only when they are numbers.
      if (counted && Number.isSafeInteger(counted.count) && Number.isFinite(counted.longestMs)) frames = counted;
    }
    await page.waitForTimeout(SETTLE_MS);
    // Never ready, and nothing above says why: a template that only stalls, or that reports an error it never threw.
    if (readyMs === null && !problems.size) problems.add(`did not report ready within ${READY_TIMEOUT_MS} ms`);
    // Ready, then no second of frames: wedged in `play`, or it broke the count. On a screen a wedged template holds
    // the player's frame. A frame that navigated away has no frames to count, and is refused for the navigation.
    if (readyMs !== null && frames === null && !navigated) problems.add(`froze after play: did not draw a second of frames within ${PLAY_MS + GRACE_MS} ms`);
    return { render: { orientation, viewport, readyMs, frames }, problems };
  } finally {
    await context.close();
  }
}

/** Check a built template in every orientation it supports. */
export async function checkTemplate(browser: Browser, manifest: TemplateManifest, html: string): Promise<CheckResult> {
  const problems = new Set<string>();
  const renders: TemplateRender[] = [];
  // Each once: a repeat in the list (the contract refuses one) would only make the check longer.
  for (const orientation of new Set(manifest.orientations)) {
    const r = await render(browser, manifest, html, orientation);
    renders.push(r.render);
    for (const p of r.problems) problems.add(clip(p));
  }
  const all = [...problems];
  const shown = all.length > MAX_PROBLEMS ? [...all.slice(0, MAX_PROBLEMS - 1), `and ${all.length - MAX_PROBLEMS + 1} more problems`] : all;
  return { problems: shown, renders };
}

/** A template that makes one request the policy blocks, with a quote in its URL. Protocol 1, no SDK. */
const CANARY_URL = "https://canary.invalid/a'b";
const CANARY_HTML = `<!doctype html><script>"use strict";
addEventListener('message', (e) => {
  if (e.source !== parent || e.data?.type !== 'init') return;
  fetch(${JSON.stringify(CANARY_URL)}).catch(() => {});
  setTimeout(() => parent.postMessage({ sf: 1, type: 'ready' }, '*'), 50);
});
parent.postMessage({ sf: 1, type: 'loaded' }, '*');
</script>`;
const CANARY_MANIFEST: TemplateManifest = {
  id: 'canary',
  version: '1.0.0',
  name: 'Canary',
  fields: {},
  duration: { defaultMs: 4000, minMs: 4000, maxMs: 4000 },
  orientations: ['landscape'],
  uses: [],
  background: '#000',
  protocol: 1,
};

/**
 * Whether this browser still shows the check a blocked request: the canary must come back with
 * exactly its one problem. Detection reads Chromium's console lines, whose wording a new Chromium
 * may change; the runner refuses every check until its canary passes.
 */
export async function canary(browser: Browser): Promise<{ ok: boolean; problems: string[] }> {
  const { problems } = await checkTemplate(browser, CANARY_MANIFEST, CANARY_HTML);
  return { ok: problems.length === 1 && problems[0] === `requested ${CANARY_URL} (blocked)`, problems };
}
