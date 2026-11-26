/**
 * A slot holds one spot. The player owns two and alternates: one is on screen while the
 * other loads the next spot out of sight, so a swap only happens between two finished frames.
 */
import {
  playsProtocol,
  THIS_PLAYER,
  isNewsImage,
  rowAsset,
  sampleAsset,
  type FrameClock,
  type FrameFont,
  type FrameTheme,
  type Orientation,
  type ScreenManifest,
  type Spot,
  type TemplateManifest,
} from '@signforge/contract';
import { alive, READY_TIMEOUT_MS, resolveSpotData, screenLocale } from '@signforge/player-core';
import { openFrameHost, type FrameHost } from '@signforge/player-core/frame-host';
import { parseBundle, type Frames } from './bundles';
import { clock, now } from './clock';
import { liveData, reportRejected } from './data';
import { getFile } from './source';

/** Corrected time and the offset the SDK's `now()` adds to the frame's own clock (src/clock.ts). */
const frameClock = (): FrameClock => ({ now: now(), offsetMs: clock.offsetMs });

const orientationOf = (w: number, h: number): Orientation => (w >= h ? 'landscape' : 'portrait');

/**
 * How a template fits the screen as it is now. On an orientation it does not support it is
 * letterboxed at the shape it does support, over the background it declares (`background`).
 */
function fitTo(t: TemplateManifest): { orientation: Orientation; viewport: { width: number; height: number }; background?: string } {
  const sw = innerWidth,
    sh = innerHeight;
  const screenIs = orientationOf(sw, sh);
  const orientation = t.orientations.includes(screenIs) ? screenIs : t.orientations[0]!;
  if (orientation === screenIs) return { orientation, viewport: { width: sw, height: sh } };
  const ratio = orientation === 'landscape' ? 16 / 9 : 9 / 16;
  const width = Math.min(sw, sh * ratio);
  return { orientation, viewport: { width, height: width / ratio }, background: t.background };
}

type TemplateSpot = Extract<Spot, { kind: 'template' }>;

/** A slot's template frame, and what its next `init` sends. */
interface LiveFrame {
  /** The template's frames and the protocol with it (player-core's Frame host). */
  host: FrameHost;
  protocol: number;
  /** The bundle's hash: an update to another bundle is a fresh load. */
  html: string;
  template: TemplateManifest;
  spot: TemplateSpot;
  manifest: ScreenManifest;
  data: Record<string, unknown>;
  /** The bound fields `data` holds on their fallback (`resolveSpotData`): `init` names them, protocol 2 (#225). */
  fallback: string[];
  locale: string;
  assets: Record<string, Blob>;
  /** The screen's brand kit as the frame takes it; protocol 2 only. */
  theme?: FrameTheme;
  orientation: Orientation;
  viewport: { width: number; height: number };
}

/**
 * A template spot's image fields, as Blobs: the frame has no network and an opaque origin. An
 * image with a sample has it beside it, under `sampleAsset(field)`, when the sample can be read.
 */
async function spotAssets(spot: TemplateSpot, manifest: ScreenManifest): Promise<Record<string, Blob>> {
  const assets: Record<string, Blob> = {};
  await Promise.all(
    Object.entries(spot.assets).map(async ([field, sha]) => {
      assets[field] = await getFile(sha);
      const sample = manifest.files[sha]?.sample;
      // A sample only spares the template a decode: one not held yet (a manifest a player stored
      // before it knew samples, until a sync fetches them) leaves the template to measure the photo.
      const blob = sample && (await getFile(sample).catch(() => undefined));
      if (blob) assets[sampleAsset(field)] = blob;
    }),
  );
  return assets;
}

/**
 * Resolve any list-row image blobs (`NewsImage` in list fields whose `item` declares an `image`
 * property) into `init.assets` under `rowAsset(field, i, prop)` and `rowAsset(..., 'thumb')`.
 * Missing blobs never fail the spot: the row's image property is omitted from `data` and neither
 * asset key is added, so the story plays cleanly as a story with no image.
 */
async function resolveRowImages(
  fields: TemplateManifest['fields'],
  data: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; assets: Record<string, Blob> }> {
  const listFields: { name: string; imageProps: string[] }[] = [];
  for (const [name, def] of Object.entries(fields)) {
    if (def.type !== 'list') continue;
    const imageProps = Object.entries(def.item).flatMap(([k, d]) => (d.type === 'image' ? [k] : []));
    if (imageProps.length) listFields.push({ name, imageProps });
  }
  if (!listFields.length) return { data, assets: {} };

  const shas = new Set<string>();
  for (const { name, imageProps } of listFields) {
    const rows = data[name];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      for (const prop of imageProps) {
        if (!Object.hasOwn(row, prop)) continue;
        const img: unknown = Reflect.get(row, prop);
        if (!isNewsImage(img)) continue;
        shas.add(img.file);
        shas.add(img.thumb);
      }
    }
  }
  if (!shas.size) return { data, assets: {} };

  const loaded = new Map<string, Blob>();
  await Promise.all(
    [...shas].map(async (sha) => {
      const blob = await getFile(sha).catch(() => undefined);
      if (blob) loaded.set(sha, blob);
    }),
  );

  const nextData: Record<string, unknown> = { ...data };
  const assets: Record<string, Blob> = {};
  for (const { name, imageProps } of listFields) {
    const rows = data[name];
    if (!Array.isArray(rows)) continue;
    nextData[name] = rows.map((row: unknown, i) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
      let cloned: Record<string, unknown> | undefined;
      for (const prop of imageProps) {
        if (!Object.hasOwn(row, prop)) continue;
        const img: unknown = Reflect.get(row, prop);
        if (!isNewsImage(img)) continue;
        const fileBlob = loaded.get(img.file);
        const thumbBlob = loaded.get(img.thumb);
        if (fileBlob && thumbBlob) {
          assets[rowAsset(name, i, prop)] = fileBlob;
          assets[rowAsset(name, i, prop, 'thumb')] = thumbBlob;
        } else {
          cloned ??= Object.fromEntries(Object.entries(row));
          delete cloned[prop];
        }
      }
      return cloned ?? row;
    });
  }
  return { data: nextData, assets };
}

/** The last manifest's theme: every template spot of a manifest shares it, so its files are read once. */
let themeCache: { manifest: string; theme: Promise<FrameTheme | undefined> } | undefined;

/**
 * The manifest's brand kit as `init` sends it: fonts and logo as Blobs, like `assets`, since an
 * object URL made here would not resolve in the frame's opaque origin. Undefined without a kit.
 */
function brandTheme(manifest: ScreenManifest): Promise<FrameTheme | undefined> {
  if (themeCache?.manifest !== manifest.id) {
    const theme = loadTheme(manifest);
    themeCache = { manifest: manifest.id, theme };
    // A failed read is not kept: the next spot tries again.
    theme.catch(() => {
      if (themeCache?.theme === theme) themeCache = undefined;
    });
  }
  return themeCache.theme;
}

/**
 * `containedFrames` for each bundle of the manifest last prepared, by bundle hash, parsed in a worker
 * (`parseBundle`, #561). Reading a 400 kB bundle again cost about 150 ms of a prepare on a Pi 4
 * (spike/pi-perf/RESULTS.md, #213): once per bundle, not per play. By hash, so a new bundle is a new
 * entry, never another's. Held as promises, so a prepare and `warmBundles` reading one bundle at once
 * share the read. `unreadable`: the bundles `warmBundles` failed to read for this manifest, which it
 * then leaves to the prepare that needs one rather than trying again at every play.
 */
let framesCache: { manifest: string; frames: Map<string, Promise<Frames>>; unreadable: Set<string> } | undefined;

/** `framesCache`, made `manifest`'s if it is another's: what both use is kept. */
function cacheOf(manifest: ScreenManifest): NonNullable<typeof framesCache> {
  if (framesCache?.manifest !== manifest.id) {
    const bundles = new Set(Object.values(manifest.templates).map((t) => t.html));
    const kept = [...(framesCache?.frames ?? [])].filter(([k]) => bundles.has(k));
    framesCache = { manifest: manifest.id, frames: new Map(kept), unreadable: new Set() };
  }
  return framesCache;
}

function framesFor(manifest: ScreenManifest, sha: string): Promise<Frames> {
  const cache = cacheOf(manifest);
  let frames = cache.frames.get(sha);
  if (!frames) {
    const read = getFile(sha).then(parseBundle);
    cache.frames.set(sha, (frames = read));
    // A read that failed is not kept: the next prepare tries again. From the cache as it is then,
    // which a manifest prepared meanwhile has replaced, carrying this read over.
    read.catch(() => {
      if (framesCache?.frames.get(sha) === read) framesCache.frames.delete(sha);
    });
  }
  return frames;
}

/** The read-ahead running, if one is: the manifest it reads for, and the run, so one that a later run replaced stops. */
let warming: { manifest: string; run: object } | undefined;

/**
 * Read the bundles of `manifest` not read yet, one at a time when the page is idle, those of the
 * spots in `first` first: while a spot plays, so a template's first prepare does not pay for it
 * (#232). On a Pi 4 a 400 kB bundle's first read and parse took 75 to 210 ms of its first prepare,
 * of 450 to 610 in all; the template plays in its own process. Each starts when the page is idle and
 * parses in the bundle worker (`parseBundle`). `manifest` is the one playing, so the cache is
 * made its own here, whatever kind of spot came first; it stops once another manifest has been
 * prepared. Not in a browser without `requestIdleCallback` (Safari): the budget it serves is the
 * Pi's, and a timer could start a parse in the middle of a prepare.
 */
export function warmBundles(manifest: ScreenManifest, first: readonly string[]): void {
  // Each play asks again: one read-ahead a manifest at a time. Another manifest's in between ends this
  // one's run, so a manifest that flaps back (A, B, A) within one idle wait starts one run, not two.
  if (typeof requestIdleCallback !== 'function' || warming?.manifest === manifest.id) return;
  const run = {};
  warming = { manifest: manifest.id, run };
  cacheOf(manifest);
  const firstBundles = first.flatMap((id) => {
    const spot = manifest.spots[id];
    const html = spot?.kind === 'template' && manifest.templates[spot.template]?.html;
    return html ? [html] : [];
  });
  // Each once: a file that cannot be read is left to the prepare that needs it, at this play and the next.
  const left = new Set([...firstBundles, ...Object.values(manifest.templates).map((t) => t.html)]);
  const done = () => {
    if (warming?.run === run) warming = undefined;
  };
  // Another manifest prepared while this waited: reading for this one would put its cache back.
  const ours = () => warming?.run === run && framesCache?.manifest === manifest.id;
  const next = () => {
    const cache = framesCache;
    const sha = ours() && cache ? [...left].find((s) => !cache.frames.has(s) && !cache.unreadable.has(s)) : undefined;
    if (!sha || !cache) return done();
    left.delete(sha);
    requestIdleCallback(() => {
      if (!ours()) return done();
      void framesFor(manifest, sha).then(next, () => {
        cache.unreadable.add(sha);
        next();
      });
    });
  };
  next();
}

async function loadTheme({ brand }: ScreenManifest): Promise<FrameTheme | undefined> {
  if (!brand) return undefined;
  const font = async (f: NonNullable<typeof brand.fonts.body>): Promise<FrameFont> => ({
    family: f.family,
    files: await Promise.all(f.files.map(async (x) => ({ weight: x.weight, style: x.style, data: await getFile(x.file) }))),
  });
  const [display, body, onDark, onLight] = await Promise.all([
    brand.fonts.display && font(brand.fonts.display),
    brand.fonts.body && font(brand.fonts.body),
    brand.logo && getFile(brand.logo.onDark),
    brand.logo?.onLight && getFile(brand.logo.onLight),
  ]);
  return {
    colors: brand.colors,
    shape: brand.shape,
    fonts: { ...(display ? { display } : {}), ...(body ? { body } : {}) },
    ...(onDark ? { logo: { onDark, ...(onLight ? { onLight } : {}) } } : {}),
  };
}

export class Slot {
  readonly el = document.createElement('div');
  spot?: Spot;
  private startPlayback: () => Promise<void> = () => Promise.resolve();
  private urls: string[] = [];
  private abort?: AbortController;
  private video?: HTMLVideoElement;
  /** Settles when the spot's load is done, whatever its outcome. */
  private loading: Promise<void> = Promise.resolve();
  /**
   * Settles when the load and every refit queued are done; rejects if the last refit failed.
   * `play` waits for it, so a spot is never played drawn for a size it no longer has.
   */
  private fitted: Promise<void> = Promise.resolve();
  /** A refit is queued and has not started: later resizes join it. */
  private refitQueued = false;
  /** The frame was sent `play` since its load: a refit plays it again. */
  private started = false;

  /**
   * `died` hears that the spot loaded here died after its load, and the slot is blank: a refit
   * failed, or the template navigated away. A failure while loading rejects `prepare` instead.
   */
  constructor(private readonly died: (why: string) => void) {
    this.el.className = 'slot';
    document.body.appendChild(this.el);
    addEventListener('resize', () => this.refit());
  }

  /**
   * Load a spot and resolve once it can be shown complete. Rejects on error or timeout, and a
   * timeout cancels the load, so it always settles. `report: false` (a protocol 1 refit, the
   * same play loaded again) leaves out the data refused, which its first load counted.
   */
  async prepare(spot: Spot, manifest: ScreenManifest, report = true): Promise<void> {
    this.clear();
    this.spot = spot;
    const abort = (this.abort = new AbortController());
    const work =
      spot.kind === 'template'
        ? this.template(spot, manifest, this.abort.signal, report)
        : spot.kind === 'image'
          ? this.image(spot, this.abort.signal)
          : spot.kind === 'video'
            ? this.playVideo(spot, this.abort.signal)
            : this.url(spot, this.abort.signal);
    // If the timeout wins, the load is cancelled and rejects; that is expected, not an error.
    work.catch(() => undefined);
    this.loading = work.catch(() => undefined);
    // A refit queued for the spot this replaced still runs, after this load: see `refit`.
    this.fitted = Promise.all([this.fitted.catch(() => undefined), this.loading]).then(() => undefined);
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        // Rejected before the abort settles `work`, so the race always reports the timeout.
        reject(new Error(`not ready within ${READY_TIMEOUT_MS} ms`));
        abort.abort();
      }, READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Start the prepared spot, after any refit queued for it. Resolves once it plays: then for a
   * template, an image or a URL spot, and when its `play()` does for a video. Rejects if the
   * video's is refused, or if the refit failed.
   */
  play(): Promise<void> {
    return this.fitted.then(() => {
      this.started = true;
      return this.startPlayback();
    });
  }

  /**
   * Fit a template spot to the viewport again, after a resize or a rotation. Its frames take the
   * new size, and the template is initialised again for it (`reset`, then `init`; protocol 1
   * reloads its frame), as playing if it was. Image, video and URL spots fill the slot, so they
   * need nothing. A refit waits for the load and the refit before it, and later resizes join the
   * one waiting, so a burst of resizes costs at most two inits, and the last one has the last size.
   * A refit that fails blanks the slot and reports it (`died`), as a template that navigates away
   * does: the frame has been reset by then, and shows its markup without data.
   */
  private refit(): void {
    if (this.refitQueued) return;
    this.refitQueued = true;
    const run = this.fitted
      .catch(() => undefined)
      .then(async () => {
        this.refitQueued = false;
        // A spot loaded since this was queued is fitted after its load, which may have read the old size.
        for (let l = this.loading; ; l = this.loading) {
          await l;
          if (l === this.loading) break;
        }
        return this.fitAgain();
      });
    this.fitted = run;
    run.catch(() => undefined);
  }

  private async fitAgain(): Promise<void> {
    const live = this.live;
    if (!live || !this.abort || this.abort.signal.aborted) return;
    // `live.spot` follows a preview update; this is the spot the refit is for.
    const spot = live.spot;
    const fit = fitTo(live.template);
    if (fit.orientation === live.orientation && fit.viewport.width === live.viewport.width && fit.viewport.height === live.viewport.height) return;
    const replay = this.started;
    try {
      if (live.protocol < 2) {
        await this.prepare(spot, live.manifest, false);
      } else {
        live.host.resize(fit.viewport);
        this.background(fit);
        live.orientation = fit.orientation;
        live.viewport = fit.viewport;
        await live.host.reset();
      }
    } catch (err) {
      // Cleared, or given another spot or a new draft meanwhile: nothing of this refit is on screen.
      if (this.spot !== spot) throw err;
      const why = `refit failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[sf] ${spot.id}: ${why}`);
      this.abort?.abort();
      this.el.replaceChildren();
      this.died(`${spot.id}: ${why}`);
      throw err;
    }
    if (replay) {
      this.started = true;
      await this.startPlayback();
    }
  }

  /** Behind a letterboxed template, the background it declares. */
  private background(fit: ReturnType<typeof fitTo>): void {
    if (fit.background) this.el.style.setProperty('--slot-bg', fit.background);
    else this.el.style.removeProperty('--slot-bg');
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
    this.el.style.removeProperty('--slot-bg');
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.spot = undefined;
    this.live = undefined;
    this.started = false;
    this.startPlayback = () => Promise.resolve();
  }

  private objectUrl(blob: Blob): string {
    const u = URL.createObjectURL(blob);
    this.urls.push(u);
    return u;
  }

  /** Set while a template spot is loaded. */
  private live?: LiveFrame;

  private async template(spot: TemplateSpot, manifest: ScreenManifest, signal: AbortSignal, report: boolean): Promise<void> {
    const t = manifest.templates[spot.template];
    if (!t) throw new Error(`template ${spot.template} is not in the manifest`);
    // Speak the protocol the bundle was built against: published bundles never change.
    const protocol = t.manifest.protocol ?? 1;
    if (!playsProtocol(THIS_PLAYER, protocol)) throw new Error(`template ${spot.template} speaks frame protocol ${protocol}, which this player does not`);
    const locale = screenLocale(manifest);
    const { data: resolvedData, rejected, fallback } = resolveSpotData(spot, t.manifest.fields, liveData, now(), locale);
    if (report) reportRejected(rejected);
    const [{ wrapper: wrapperHtml, template: templateHtml }, baseAssets, rowImages, theme] = await Promise.all([
      framesFor(manifest, t.html),
      spotAssets(spot, manifest),
      resolveRowImages(t.manifest.fields, resolvedData),
      // Protocol 1 bundles predate the theme.
      protocol >= 2 ? brandTheme(manifest) : Promise.resolve(undefined),
    ]);
    const assets = { ...baseAssets, ...rowImages.assets };
    const data = rowImages.data;
    alive(signal);

    const fit = fitTo(t.manifest);
    this.background(fit);
    // The frames, their containment and the handshake are the Frame host's (player-core). Set once
    // the wrapper has loaded, before the template's frame is added: what each `init` sends.
    let live: LiveFrame | undefined;
    const host = await openFrameHost({
      container: this.el,
      frames: { wrapper: wrapperHtml, template: templateHtml },
      protocol,
      title: spot.name,
      size: fit.viewport,
      // Read at each `loaded`: after an update (`reset`), the new spot's.
      init: () => ({
        data: live!.data,
        assets: live!.assets,
        durationMs: live!.spot.durationMs,
        orientation: live!.orientation,
        viewport: live!.viewport,
        timezone: live!.manifest.screen.timezone,
        locale: live!.locale,
        clock: frameClock(),
        ...(live!.theme ? { theme: live!.theme } : {}),
        fallback: live!.fallback,
      }),
      label: spot.template,
      signal,
      // Once loaded: blank the slot and report it (`died`), so playback moves on. Aborted, so a resize
      // before the slot is cleared cannot refit it and report a second death.
      onNavigatedAway: () => {
        this.abort?.abort();
        this.died(`${live!.spot.id}: template navigated away`);
      },
    });
    live = this.live = {
      host,
      protocol,
      html: t.html,
      template: t.manifest,
      spot,
      manifest,
      data,
      fallback,
      locale,
      assets,
      theme,
      orientation: fit.orientation,
      viewport: fit.viewport,
    };
    this.startPlayback = () => {
      host.play();
      return Promise.resolve();
    };
    await host.start();
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
      await this.play();
      return;
    }
    const signal = this.abort.signal;
    const work = (async () => {
      const locale = screenLocale(manifest);
      const { data: resolvedData, rejected, fallback } = resolveSpotData(spot, t.manifest.fields, liveData, now(), locale);
      reportRejected(rejected);
      const [baseAssets, rowImages, theme] = await Promise.all([
        spotAssets(spot, manifest),
        resolveRowImages(t.manifest.fields, resolvedData),
        brandTheme(manifest),
      ]);
      alive(signal);
      Object.assign(live, { spot, manifest, data: rowImages.data, fallback, locale, assets: { ...baseAssets, ...rowImages.assets }, theme });
      // The frames are reused, so a rename in the editor must reach their titles too.
      live.host.setTitle(spot.name);
      this.spot = spot;
      await live.host.reset();
    })();
    // Queued as a load: a refit waits for it, and one it supersedes gives way quietly (see `fitAgain`).
    this.loading = work.catch(() => undefined);
    this.fitted = Promise.all([this.fitted.catch(() => undefined), this.loading]).then(() => undefined);
    await work;
    await this.play();
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
    // Ready at canplaythrough. A paused video that has never played presents no frame, so waiting
    // for a frame callback here only ever waited out a timer: 600 ms on every video prepare.
    this.startPlayback = () => v.play();
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
    frame.title = spot.name;
    frame.style.cssText = 'width:100%;height:100%';
    // Rejects on abort, so a page that never loads settles once skipped: `play` waits for it (`fitted`).
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true, signal });
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    frame.src = target.href;
    this.el.appendChild(frame);
    await loaded;
    alive(signal);
  }
}
