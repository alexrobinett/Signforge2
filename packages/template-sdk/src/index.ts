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
 * through `formatter(ctx, { hour: 'numeric' })`.
 */
import { PROTOCOL_VERSION, type HostMessage, type InitPayload, type TemplateMessage } from '@signforge/contract';

export interface TemplateContext extends Omit<InitPayload, 'assets'> {
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

export function defineTemplate(hooks: TemplateHooks = {}): void {
  let ctx: TemplateContext | undefined;

  addEventListener('message', async (e: MessageEvent<HostMessage>) => {
    // Only the player may drive a template; another frame on the page could otherwise forge an init.
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.sf !== PROTOCOL_VERSION) return;
    try {
      if (m.type === 'init') {
        const root = document.documentElement;
        const assets: Record<string, string> = {};
        for (const [k, blob] of Object.entries(m.assets)) assets[k] = URL.createObjectURL(blob);
        ctx = { data: m.data, assets, durationMs: m.durationMs, orientation: m.orientation, viewport: m.viewport, timezone: m.timezone, locale: m.locale, root };
        root.style.setProperty('--sf-duration', `${m.durationMs}ms`);
        root.dataset.orientation = m.orientation;
        bind(ctx);
        await hooks.prepare?.(ctx);
        await settle();
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
      }
    } catch (err) {
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
