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
import { containedFrames, READY_TIMEOUT_MS, TEMPLATE_SANDBOX } from '@signforge/player-core';
import type { Browser, Frame, Page } from 'playwright-core';

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
  }
}

/** The given value, else the field's default, else a sample; brand tokens resolved as for a screen with no kit. */
function value(def: ScalarFieldDef, given: unknown): unknown {
  const v = given ?? def.default ?? fallback(def);
  const token = def.type === 'color' ? tokenName(v) : undefined;
  return token && isBrandColor(token) ? DEFAULT_BRAND_COLORS[token] : v;
}

/** Each field's example value, and which fields are images. */
function exampleData(fields: Record<string, FieldDef>): { data: Record<string, unknown>; images: string[] } {
  const data: Record<string, unknown> = {};
  const images: string[] = [];
  for (const [name, def] of Object.entries(fields)) {
    if (def.type === 'image') images.push(name);
    else if (def.type === 'list')
      data[name] = (def.default ?? []).map((row) => Object.fromEntries(Object.entries(def.item).map(([k, d]) => [k, value(d, row[k])])));
    else data[name] = value(def, undefined);
  }
  return { data, images };
}

interface RenderArgs {
  wrapperHtml: string;
  sandbox: string;
  html: string;
  protocol: number;
  init: Omit<InitPayload, 'assets' | 'clock' | 'theme'>;
  images: string[];
  readyTimeoutMs: number;
}

/**
 * Runs in the host page: the player's slot, reduced to one template spot. Resolves with the time
 * from `init` to `ready`, or the template's error, or neither when the player would have given up
 * on it: it navigated away (its frame loaded again) or the ready timeout passed. Leaves `__sfPlay`
 * on the window to send `play`.
 */
async function renderInHost(a: RenderArgs): Promise<{ readyMs: number | null; error: string | null }> {
  const wrapperFrame = document.createElement('iframe');
  wrapperFrame.title = 'template';
  wrapperFrame.style.cssText = `display:block;border:0;width:${a.init.viewport.width}px;height:${a.init.viewport.height}px`;
  wrapperFrame.srcdoc = a.wrapperHtml;
  const wrapped = new Promise((resolve) => wrapperFrame.addEventListener('load', resolve, { once: true }));
  document.body.appendChild(wrapperFrame);
  await wrapped;
  const wrapper = wrapperFrame.contentWindow;
  const relay: unknown = wrapper && Reflect.get(wrapper, 'relay');
  if (!wrapper || typeof relay !== 'function') throw new Error('the wrapper frame has no relay');
  const frame = wrapper.document.createElement('iframe');
  frame.setAttribute('sandbox', a.sandbox);
  frame.title = 'template';
  frame.srcdoc = a.html;

  // One small PNG for every image field: the template gets a real image to decode.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const pixel = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  const assets = Object.fromEntries(a.images.map((name) => [name, pixel]));
  const post = (m: object) => relay(frame.contentWindow, { sf: a.protocol, ...m });
  Reflect.set(window, '__sfPlay', () => post({ type: 'play' }));

  let sentAt = 0;
  let loads = 0;
  const outcome = new Promise<{ readyMs: number | null; error: string | null }>((resolve) => {
    // Counted from when the template's frame is added. The player counts from the start of the
    // spot's prepare, a few ms earlier, so this is no stricter than a screen.
    setTimeout(() => resolve({ readyMs: null, error: null }), a.readyTimeoutMs);
    frame.addEventListener('load', () => ++loads > 1 && resolve({ readyMs: null, error: null }));
    wrapper.addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow || e.data?.sf !== a.protocol) return;
      if (e.data.type === 'loaded' && !sentAt) {
        sentAt = performance.now();
        post({ type: 'init', ...a.init, assets, clock: { now: Date.now(), offsetMs: 0 } });
      } else if (e.data.type === 'ready' && sentAt) resolve({ readyMs: Math.round((performance.now() - sentAt) * 10) / 10, error: null });
      else if (e.data.type === 'error') resolve({ readyMs: null, error: String(e.data.message) });
    });
  });
  wrapper.document.body.appendChild(frame);
  return outcome;
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
      if (url === HOST) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Template check</title><body style="margin:0">' });
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
    page.on('framenavigated', (f) => {
      // A new fragment keeps the document (no second load), so the player does not count it either.
      if (f === templateFrame(page) && f.url().split('#')[0] !== 'about:srcdoc') problems.add('navigated its own frame (blocked)');
    });
    await page.goto(HOST);

    const { data, images } = exampleData(manifest.fields);
    const contained = containedFrames(html);
    const args: RenderArgs = {
      wrapperHtml: contained.wrapper,
      sandbox: TEMPLATE_SANDBOX,
      html: contained.template,
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
const CANARY_HTML = `<!doctype html><script>
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
