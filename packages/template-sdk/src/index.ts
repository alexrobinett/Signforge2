/**
 * The template side of the frame protocol. A template calls `defineTemplate` once.
 *
 * The SDK:
 *  - fills `[data-sf="field"]` text and `[data-sf-src="field"]` image sources from the spot's data
 *  - exposes `--sf-duration` (and `data-orientation`) so CSS can time an outro to the spot's length
 *  - holds every animation paused until the player says play
 *  - reports ready only after fonts and images have decoded, so the first frame is complete
 *
 * Text shown to people should use `ctx.timezone` and `ctx.locale` (the screen's), for example
 * through `formatter(ctx, { hour: 'numeric' })`, and the time from `now()`, never `new Date()`:
 * the screen corrects its clock from the server, and the device's own clock may be wrong.
 *
 * New data (protocol 2). On `reset`, or an `init` after the first, the SDK stops the template,
 * restores the document exactly as it loaded, and initialises again, so `prepare` always starts
 * from clean markup. Look elements up inside the hooks, not once at the top of `main.ts`: a reset
 * replaces them. State a template keeps outside the DOM must be cleared in `stop`.
 */
import { PROTOCOL_VERSION, type HostMessage, type InitPayload, type TemplateMessage } from '@signforge/contract';

export interface TemplateContext extends Omit<InitPayload, 'assets' | 'theme'> {
  /** Image fields as object URLs. */
  assets: Record<string, string>;
  root: HTMLElement;
}

export interface TemplateHooks {
  /** Build anything the markup alone cannot. May be async; ready is reported after it resolves. */
  prepare?(ctx: TemplateContext): void | Promise<void>;
  /** Called on the frame the spot becomes visible. CSS and WAAPI animations start by themselves. */
  play?(ctx: TemplateContext): void;
  stop?(): void;
}

const send = (m: TemplateMessage) => parent.postMessage(m, '*');

let offsetMs = 0;
/** The screen's corrected time. Use it instead of `new Date()`. */
export const now = (): Date => new Date(Date.now() + offsetMs);

export function defineTemplate(hooks: TemplateHooks = {}): void {
  let ctx: TemplateContext | undefined;
  let urls: string[] = [];
  /** The document as it loaded, taken before the first init touches it. */
  let pristine: { body: HTMLElement; attrs: [string, string][] } | undefined;
  /** Counts inits and resets, so a prepare still running for older data never reports ready. */
  let generation = 0;

  /** Undo everything an init and its play did, so the next init starts from the loaded document. */
  const restore = () => {
    if (ctx) hooks.stop?.();
    ctx = undefined;
    generation++;
    document.getAnimations().forEach((a) => a.cancel());
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    if (!pristine) return;
    const root = document.documentElement;
    for (const a of [...root.attributes]) root.removeAttribute(a.name);
    for (const [k, v] of pristine.attrs) root.setAttribute(k, v);
    // A cloned script keeps its already-started flag, so the template's code does not run again.
    document.body.replaceWith(pristine.body.cloneNode(true));
  };

  addEventListener('message', async (e: MessageEvent<HostMessage>) => {
    // Only the player may drive a template; another frame on the page could otherwise forge an init.
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.sf !== PROTOCOL_VERSION) return;
    let run = -1;
    try {
      if (m.type === 'init') {
        const root = document.documentElement;
        if (pristine) restore();
        else pristine = { body: document.body.cloneNode(true) as HTMLElement, attrs: [...root.attributes].map((a) => [a.name, a.value]) };
        const clock = m.clock ?? { now: Date.now(), offsetMs: 0 };
        offsetMs = clock.offsetMs;
        run = ++generation;
        const assets: Record<string, string> = {};
        for (const [k, blob] of Object.entries(m.assets)) urls.push((assets[k] = URL.createObjectURL(blob)));
        ctx = {
          data: m.data,
          assets,
          durationMs: m.durationMs,
          orientation: m.orientation,
          viewport: m.viewport,
          timezone: m.timezone,
          locale: m.locale,
          clock,
          root,
        };
        root.style.setProperty('--sf-duration', `${m.durationMs}ms`);
        root.dataset.orientation = m.orientation;
        bind(ctx);
        await hooks.prepare?.(ctx);
        await settle();
        if (run !== generation) return;
        document.getAnimations().forEach((a) => a.pause());
        send({ sf: PROTOCOL_VERSION, type: 'ready' });
      } else if (m.type === 'play' && ctx) {
        document.getAnimations().forEach((a) => {
          a.currentTime = 0;
          a.play();
        });
        hooks.play?.(ctx);
      } else if (m.type === 'stop') {
        hooks.stop?.();
      } else if (m.type === 'reset') {
        restore();
        send({ sf: PROTOCOL_VERSION, type: 'loaded' });
      }
    } catch (err) {
      // An error from a prepare that a reset already superseded is not this play's error.
      if (run !== -1 && run !== generation) return;
      send({ sf: PROTOCOL_VERSION, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  addEventListener('error', (e) => send({ sf: PROTOCOL_VERSION, type: 'error', message: e.message }));
  send({ sf: PROTOCOL_VERSION, type: 'loaded' });
}

function bind(ctx: TemplateContext): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-sf]')) {
    const v = ctx.data[el.dataset.sf!];
    if (v !== undefined) el.textContent = String(v);
  }
  for (const el of document.querySelectorAll<HTMLImageElement>('[data-sf-src]')) {
    const url = ctx.assets[el.dataset.sfSrc!];
    if (url) el.src = url;
  }
}

/** Wait until fonts are loaded, every image is decoded, and the browser has painted the result. */
async function settle(): Promise<void> {
  await document.fonts.ready;
  await Promise.all([...document.images].filter((i) => i.src).map((i) => i.decode().catch(() => undefined)));
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/** An Intl date formatter in the screen's time zone and locale. */
export function formatter(ctx: Pick<TemplateContext, 'timezone' | 'locale'>, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(ctx.locale, { timeZone: ctx.timezone, ...options });
}

/** Calendar-day key (`YYYY-MM-DD`) of an instant in the screen's time zone. */
export function dayKey(ctx: Pick<TemplateContext, 'timezone'>, date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
