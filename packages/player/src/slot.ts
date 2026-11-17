/**
 * A slot holds one spot. The player owns two and alternates: one is on screen while the
 * other loads the next spot out of sight, so a swap only happens between two finished frames.
 */
import {
  SUPPORTED_PROTOCOLS,
  type FrameClock,
  type HostMessage,
  type Orientation,
  type ScreenManifest,
  type Spot,
  type TemplateMessage,
} from '@signforge/contract';
import { resolveSpotData } from '@signforge/player-core';
import { clock, now } from './clock';
import { liveData, reportRejected } from './data';
import { getFile } from './source';

/** A spot that has not reported ready by this point is skipped. */
export const READY_TIMEOUT_MS = 2000;

// A template gets no network at all: scripts and styles are inline, media arrives as blobs. No
// `frame-src`, so it falls back to `'none'`: the template cannot load a frame or navigate its own.
const TEMPLATE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src data:";
// The document around each template; see `template()`. Its one script is `relay`: templates
// accept messages only from their `parent`, which is now the wrapper, and a message's source is
// the window whose code called postMessage. So the player posts through a function of the wrapper.
const WRAPPER_HTML =
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${TEMPLATE_CSP}">` +
  '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>' +
  "<script>relay=(w,m)=>w.postMessage(m,'*')</script>";
type WrapperWindow = Window & { relay: (to: Window, m: HostMessage) => void };

/** Corrected time and the offset the SDK's `now()` adds to the frame's own clock (src/clock.ts). */
const frameClock = (): FrameClock => ({ now: now(), offsetMs: clock.offsetMs });

/** Throw if the load was cancelled while it waited. */
function alive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('cancelled');
}

const orientationOf = (w: number, h: number): Orientation => (w >= h ? 'landscape' : 'portrait');

type TemplateSpot = Extract<Spot, { kind: 'template' }>;

/** A slot's template frame, and what its next `init` sends. */
interface LiveFrame {
  frame: HTMLIFrameElement;
  /** The wrapper frame's window: the template's `parent`. */
  wrapper: WrapperWindow;
  protocol: number;
  /** The bundle's hash: an update to another bundle is a fresh load. */
  html: string;
  spot: TemplateSpot;
  manifest: ScreenManifest;
  assets: Record<string, Blob>;
  orientation: Orientation;
  viewport: { width: number; height: number };
  /** Settles on the frame's next `ready` or `error`. */
  waiter?: { resolve: () => void; reject: (err: Error) => void };
}

/** A template spot's image fields, as Blobs: the frame has no network and an opaque origin. */
async function spotAssets(spot: TemplateSpot): Promise<Record<string, Blob>> {
  const assets: Record<string, Blob> = {};
  await Promise.all(Object.entries(spot.assets).map(async ([field, sha]) => (assets[field] = await getFile(sha))));
  return assets;
}

export class Slot {
  readonly el = document.createElement('div');
  spot?: Spot;
  private startPlayback: () => void = () => {};
  private urls: string[] = [];
  private abort?: AbortController;
  private video?: HTMLVideoElement;

  constructor() {
    this.el.className = 'slot';
    document.body.appendChild(this.el);
  }

  /** Load a spot and resolve once it can be shown complete. Rejects on error or timeout. */
  async prepare(spot: Spot, manifest: ScreenManifest): Promise<void> {
    this.clear();
    this.spot = spot;
    this.abort = new AbortController();
    const work =
      spot.kind === 'template'
        ? this.template(spot, manifest, this.abort.signal)
        : spot.kind === 'image'
          ? this.image(spot, this.abort.signal)
          : spot.kind === 'video'
            ? this.playVideo(spot, this.abort.signal)
            : this.url(spot, this.abort.signal);
    // If the timeout wins, the load is cancelled and rejects later; that is expected, not an error.
    work.catch(() => undefined);
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`not ready within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  play(): void {
    this.startPlayback();
  }

  clear(): void {
    // Stops any load still in flight: each step checks the signal after it awaits, so work from a
    // spot that timed out can never touch the spot prepared after it.
    this.abort?.abort();
    if (this.video) {
      // Release the hardware decoder now rather than whenever the element is collected.
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = undefined;
    }
    this.el.replaceChildren();
    this.el.style.background = '';
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.spot = undefined;
    this.live = undefined;
    this.startPlayback = () => {};
  }

  private objectUrl(blob: Blob): string {
    const u = URL.createObjectURL(blob);
    this.urls.push(u);
    return u;
  }

  /** Set while a template spot is loaded. */
  private live?: LiveFrame;

  private post(m: HostMessage): void {
    const live = this.live;
    if (live?.frame.contentWindow) live.wrapper.relay(live.frame.contentWindow, m);
  }

  /** Wait for the frame's next `ready`; `send` starts what leads to it. */
  private nextReady(send: () => void, signal: AbortSignal): Promise<void> {
    const live = this.live!;
    live.waiter?.reject(new Error('superseded'));
    return new Promise<void>((resolve, reject) => {
      live.waiter = { resolve, reject };
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      send();
    });
  }

  private async template(spot: TemplateSpot, manifest: ScreenManifest, signal: AbortSignal): Promise<void> {
    const t = manifest.templates[spot.template];
    if (!t) throw new Error(`template ${spot.template} is not in the manifest`);
    // Speak the protocol the bundle was built against: published bundles never change.
    const protocol = t.manifest.protocol ?? 1;
    if (!SUPPORTED_PROTOCOLS.includes(protocol)) throw new Error(`template ${spot.template} speaks frame protocol ${protocol}, which this player does not`);
    const html = await (await getFile(t.html)).text();
    const assets = await spotAssets(spot);
    alive(signal);

    // Fit the template to the screen. On an orientation it does not support it is letterboxed
    // at the shape it does support, over the background it declares.
    const sw = innerWidth,
      sh = innerHeight;
    const screenIs = orientationOf(sw, sh);
    const orientation = t.manifest.orientations.includes(screenIs) ? screenIs : t.manifest.orientations[0]!;
    let w = sw,
      h = sh;
    if (orientation !== screenIs) {
      const ratio = orientation === 'landscape' ? 16 / 9 : 9 / 16;
      w = Math.min(sw, sh * ratio);
      h = w / ratio;
      this.el.style.background = t.manifest.background;
    }

    // The template runs in a wrapper frame the player writes and the template cannot touch. The
    // wrapper's policy is the template's too: a srcdoc document inherits its parent's, before any
    // markup of its own runs, and no document can drop a policy it was given. The wrapper's
    // policy, not the template's, also decides where the template's frame may navigate: nowhere
    // (`frame-src` falls back to `default-src 'none'`). A template that tries is replaced by an
    // error page, without a request. See "Template containment" in docs/architecture.md.
    const wrapperFrame = document.createElement('iframe');
    wrapperFrame.style.width = `${w}px`;
    wrapperFrame.style.height = `${h}px`;
    wrapperFrame.srcdoc = WRAPPER_HTML;
    const wrapped = new Promise<void>((resolve) => wrapperFrame.addEventListener('load', () => resolve(), { once: true, signal }));
    this.el.appendChild(wrapperFrame);
    await wrapped;
    alive(signal);
    const wrapper = wrapperFrame.contentWindow as WrapperWindow;
    const frame = wrapper.document.createElement('iframe');
    // Scripts only: an opaque origin, so no access to the player, the wrapper or their storage;
    // no popups, forms, or navigating any frame but its own.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = html;

    const live: LiveFrame = (this.live = { frame, wrapper, protocol, html: t.html, spot, manifest, assets, orientation, viewport: { width: w, height: h } });
    // A second load is a navigation, which the policy turned into an error page. Fail the spot; if
    // it is already playing, blank it until the next spot.
    let loads = 0;
    frame.addEventListener(
      'load',
      () => {
        if (++loads < 2) return;
        console.warn(`[sf] template ${spot.template} navigated away; removed`);
        wrapperFrame.remove();
        live.waiter?.reject(new Error('template navigated away'));
      },
      { signal },
    );
    // One listener for the frame's life. It reads `live`, so after an update (`reset`) the frame's
    // next `loaded` gets the new spot's init. The template's `parent` is the wrapper, so its
    // messages arrive there.
    wrapper.addEventListener(
      'message',
      (e: MessageEvent<TemplateMessage>) => {
        if (e.source !== frame.contentWindow || e.data?.sf !== protocol) return;
        if (e.data.type === 'loaded') {
          const { data, rejected } = resolveSpotData(live.spot, t.manifest.fields, liveData);
          reportRejected(rejected);
          this.post({
            sf: protocol,
            type: 'init',
            data,
            assets: live.assets,
            durationMs: live.spot.durationMs,
            orientation: live.orientation,
            viewport: live.viewport,
            timezone: live.manifest.screen.timezone,
            locale: live.manifest.screen.locale ?? 'en-US',
            clock: frameClock(),
          });
        } else if (e.data.type === 'ready') live.waiter?.resolve();
        else if (e.data.type === 'error') live.waiter?.reject(new Error(`template error: ${e.data.message}`));
      },
      { signal },
    );
    this.startPlayback = () => this.post({ sf: protocol, type: 'play' });
    const ready = this.nextReady(() => wrapper.document.body.appendChild(frame), signal);
    await ready;
    alive(signal);
  }

  /**
   * Show a new version of the spot on screen in place, and play it: the preview's instant edit.
   * A template of the same bundle that speaks protocol 2 takes it without a reload: `reset`, then
   * `init` with the new data when it answers `loaded`, then `play`. Anything else (protocol 1,
   * another bundle, another kind of spot) is loaded afresh in this slot. Rejects as `prepare` does.
   */
  async update(spot: Spot, manifest: ScreenManifest): Promise<void> {
    const live = this.live;
    const t = spot.kind === 'template' ? manifest.templates[spot.template] : undefined;
    if (!live || spot.kind !== 'template' || !t || t.html !== live.html || live.protocol < 2 || !this.abort || this.abort.signal.aborted) {
      await this.prepare(spot, manifest);
      this.play();
      return;
    }
    const signal = this.abort.signal;
    const assets = await spotAssets(spot);
    alive(signal);
    Object.assign(live, { spot, manifest, assets });
    this.spot = spot;
    let timer = 0;
    try {
      await Promise.race([
        this.nextReady(() => this.post({ sf: live.protocol, type: 'reset' }), signal),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(`not ready within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    alive(signal);
    this.play();
  }

  private async image(spot: Extract<Spot, { kind: 'image' }>, signal: AbortSignal): Promise<void> {
    const img = new Image();
    img.style.cssText = `width:100%;height:100%;object-fit:${spot.fit}`;
    const blob = await getFile(spot.file);
    alive(signal);
    img.src = this.objectUrl(blob);
    await img.decode();
    alive(signal);
    this.el.appendChild(img);
  }

  private async playVideo(spot: Extract<Spot, { kind: 'video' }>, signal: AbortSignal): Promise<void> {
    const blob = await getFile(spot.file);
    alive(signal);
    const v = (this.video = document.createElement('video'));
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.style.cssText = `width:100%;height:100%;object-fit:${spot.fit}`;
    v.src = this.objectUrl(blob);
    this.el.appendChild(v);
    await new Promise<void>((resolve, reject) => {
      v.addEventListener('canplaythrough', () => resolve(), { once: true, signal });
      v.addEventListener('error', () => reject(new Error('video could not be decoded')), { once: true, signal });
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    alive(signal);
    // Wait until the first frame has been decoded and composited, so the hardware decoder is
    // already running when the spot starts rather than spinning up on screen.
    await new Promise<void>((resolve) => {
      v.requestVideoFrameCallback(() => resolve());
      setTimeout(resolve, 600);
    });
    alive(signal);
    this.startPlayback = () => void v.play();
  }

  /** Online-only. A page that fails to load in time is skipped like any other spot. */
  private async url(spot: Extract<Spot, { kind: 'url' }>, signal: AbortSignal): Promise<void> {
    if (!navigator.onLine) throw new Error('offline');
    // The page gets scripts and its own origin, so it must never share the player's: same-origin
    // access would reach the player and its cache.
    const target = new URL(spot.url, location.href);
    if (target.protocol !== 'https:' || target.origin === location.origin) throw new Error('URL spots must be https pages on another site');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.style.cssText = 'width:100%;height:100%';
    const loaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true, signal }));
    frame.src = target.href;
    this.el.appendChild(frame);
    await loaded;
    alive(signal);
  }
}
