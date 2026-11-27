/**
 * The Frame host: the screen's side of the template frame protocol (#331). Given a bundle's contained
 * frames (`containedFrames`), it builds the wrapper frame and the sandboxed template frame inside it,
 * answers the template's `loaded` with `init`, waits for `ready` or `error`, sends `play` and `reset`,
 * and guards against a template that navigates its own frame. What goes in `init`, and when a spot is
 * shown, is the caller's (the player's `Slot`).
 *
 * The template runs in a wrapper frame the host writes and the template cannot touch. The wrapper's
 * policy is the template's too: a srcdoc document inherits its parent's, before any markup of its own
 * runs, and no document can drop a policy it was given. The wrapper's policy, not the template's, also
 * decides where the template's frame may navigate: nowhere (`frame-src` falls back to
 * `default-src 'none'`). A template that tries is replaced by an error page, without a request. It runs
 * only the bundle's own scripts, each of which first takes WebRTC away from its realm (`containedFrames`).
 * See "Template containment" in docs/architecture.md.
 *
 * DOM only, and nothing runs at import. Its own entry (`@signforge/player-core/frame-host`), so packages
 * that read the rest of player-core without the DOM's types (the tools, the API) never compile it.
 */
import type { HostMessage, InitPayload, TemplateMessage } from '@signforge/contract';
import { alive, READY_TIMEOUT_MS, TEMPLATE_SANDBOX } from './frame';

export interface FrameHostOptions {
  /** Where the wrapper frame goes. */
  container: HTMLElement;
  /** The bundle's wrapper and template documents (`containedFrames`). */
  frames: { wrapper: string; template: string };
  /** The frame protocol the bundle speaks. */
  protocol: number;
  /** Both frames' title: a frame needs one for assistive technology (WCAG 4.1.2). */
  title: string;
  /** The wrapper frame's size in CSS pixels. */
  size: { width: number; height: number };
  /** What `init` carries, read at each `loaded`: after a `reset`, what is current then. */
  init: () => InitPayload;
  /** Named in the log when the template navigates away. */
  label: string;
  /** Ends the host: a wait in progress rejects, and its listeners go. */
  signal: AbortSignal;
  /** The template navigated away once it was loaded, with no wait in progress: its frames are removed. */
  onNavigatedAway: () => void;
}

export interface FrameHost {
  /**
   * Add the template's frame and wait for its first `ready`. Resolves with the ms from `init` to `ready`, or null for
   * a `ready` that came with no `init` sent since the wait began; rejects on its error or a navigation.
   */
  start(): Promise<number | null>;
  /** `reset`, which the template answers with `loaded` and then gets `init`; resolves on its `ready` as `start` does, within READY_TIMEOUT_MS. */
  reset(): Promise<number | null>;
  play(): void;
  resize(size: { width: number; height: number }): void;
  setTitle(title: string): void;
}

/** Build the wrapper frame in `o.container` and resolve once it has loaded, the template's frame not yet added. */
export async function openFrameHost(o: FrameHostOptions): Promise<FrameHost> {
  const { protocol, signal } = o;
  const wrapperFrame = document.createElement('iframe');
  wrapperFrame.title = o.title;
  const resize = (size: { width: number; height: number }) => {
    wrapperFrame.style.width = `${size.width}px`;
    wrapperFrame.style.height = `${size.height}px`;
  };
  resize(o.size);
  wrapperFrame.srcdoc = o.frames.wrapper;
  // Rejects on abort, so a load ended here settles.
  const wrapped = new Promise<void>((resolve, reject) => {
    wrapperFrame.addEventListener('load', () => resolve(), { once: true, signal });
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  o.container.appendChild(wrapperFrame);
  await wrapped;
  alive(signal);
  const wrapper = wrapperFrame.contentWindow!;
  // The wrapper's one script (`containedFrames`): it posts to the template's frame for the host.
  const relay: unknown = Reflect.get(wrapper, 'relay');
  if (typeof relay !== 'function') throw new Error('the wrapper frame has no relay');
  const frame = wrapper.document.createElement('iframe');
  // Scripts only: an opaque origin, so no access to the screen's page, the wrapper or their storage;
  // no popups, forms, or navigating any frame but its own.
  frame.setAttribute('sandbox', TEMPLATE_SANDBOX);
  frame.title = o.title;
  frame.srcdoc = o.frames.template;

  /** Settles on the frame's next `ready` or `error`; set only while a start, or a reset, waits. */
  let waiter: { resolve: () => void; reject: (err: Error) => void } | undefined;
  /** When `init` was sent in the wait in progress: `ready` is counted from it. Unset while none has been. */
  let initAt: number | undefined;
  const post = (m: HostMessage) => {
    if (frame.contentWindow) relay(frame.contentWindow, m);
  };
  /** Wait for the frame's next `ready`; `send` starts what leads to it. */
  const nextReady = (send: () => void): Promise<number | null> => {
    waiter?.reject(new Error('superseded'));
    initAt = undefined;
    return new Promise<number | null>((resolve, reject) => {
      const w = {
        resolve: () => {
          if (waiter === w) waiter = undefined;
          resolve(initAt === undefined ? null : Math.round((performance.now() - initAt) * 10) / 10);
        },
        reject: (err: Error) => {
          if (waiter === w) waiter = undefined;
          reject(err);
        },
      };
      waiter = w;
      signal.addEventListener('abort', () => w.reject(new Error('cancelled')), { once: true });
      send();
    });
  };

  // A second load is a navigation, which the policy turned into an error page. Fail the start or
  // reset waiting; once loaded, remove the frames and say so.
  let loads = 0;
  frame.addEventListener(
    'load',
    () => {
      if (++loads < 2) return;
      console.warn(`[sf] template ${o.label} navigated away; removed`);
      wrapperFrame.remove();
      if (waiter) waiter.reject(new Error('template navigated away'));
      else o.onNavigatedAway();
    },
    { signal },
  );
  // One listener for the frame's life: after a `reset`, the frame's next `loaded` gets what `init()`
  // gives then. The template's `parent` is the wrapper, so its messages arrive there.
  wrapper.addEventListener(
    'message',
    (e: MessageEvent<TemplateMessage>) => {
      if (e.source !== frame.contentWindow || e.data?.sf !== protocol) return;
      if (e.data.type === 'loaded') {
        initAt = performance.now();
        post({ sf: protocol, type: 'init', ...o.init() });
      } else if (e.data.type === 'ready') waiter?.resolve();
      else if (e.data.type === 'error') waiter?.reject(new Error(`template error: ${e.data.message}`));
    },
    { signal },
  );

  return {
    start: async () => {
      const ms = await nextReady(() => wrapper.document.body.appendChild(frame));
      alive(signal);
      return ms;
    },
    reset: async () => {
      let timer = 0;
      try {
        const ms = await Promise.race([
          nextReady(() => post({ sf: protocol, type: 'reset' })),
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => reject(new Error(`not ready within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
          }),
        ]);
        alive(signal);
        return ms;
      } finally {
        clearTimeout(timer);
      }
    },
    play: () => post({ sf: protocol, type: 'play' }),
    resize,
    setTitle: (title) => {
      frame.title = wrapperFrame.title = title;
    },
  };
}

/**
 * A spare template frame (#232): a wrapper frame as `openFrameHost` builds one, around a frame sandboxed with no
 * allowances at all, under a policy that allows nothing, holding an empty document. Chromium runs a template's sandboxed frame
 * in a renderer of its own, started afresh on each page load; the spare, kept for the page's life from its start, starts
 * that renderer before the first prepare and keeps it running between templates, so a template finds it warm.
 */
export function openSpareFrame(container: HTMLElement): void {
  const wrapperFrame = document.createElement('iframe');
  wrapperFrame.title = 'Spare template frame';
  wrapperFrame.setAttribute('aria-hidden', 'true');
  wrapperFrame.tabIndex = -1;
  wrapperFrame.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  wrapperFrame.srcdoc =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'">` +
    `<iframe sandbox="" title="Spare template frame" srcdoc="&lt;!doctype html&gt;"></iframe>`;
  container.appendChild(wrapperFrame);
}
