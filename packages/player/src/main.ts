/**
 * SignForge player shell. Boots from the cached manifest, keeps content in sync, and runs the
 * playback loop: play the current spot, prepare the next out of sight, swap when it is ready.
 *
 * Query options:  ?content=<url>  where manifest.json and blobs/ live (default ./content). On another
 *                                 origin it is the API's device base (`https://<api>/v1/device`) and every
 *                                 request carries the screen's credential, collected from the supervisor
 *                 ?poll=<seconds> how often to look for a new manifest (default 30)
 *                 ?stall=<seconds> give up on a download that receives nothing for this long (default 30; testing)
 *                 ?debug=1        show the on-screen status overlay
 *                 ?hb=1           with debug, also show a moving speck so every frame is drawn. It costs
 *                                 the Pi 4 about 7% of frames: use it only to validate measurements
 *                 ?spots=a,b      play only these spots, in order, ignoring the schedule (testing)
 *                 ?transition=cut|fade<ms>|<ms>  override the playlist transition (testing)
 *                 ?supervisor=<url>  the device supervisor that powers the panel (default http://127.0.0.1:8091)
 */
import type { ScreenManifest, Spot, Transition } from '@signforge/contract';
import { Sequencer, displayOn, localTime, spotFiles, type Step } from '@signforge/player-core';
import { DeviceCredential } from './credential';
import { dataRejections, dataSettled, dataStatus, startDataLoop } from './data';
import { Slot } from './slot';
import { PinSet, UnauthorisedError, loadActiveManifest, requestPersistence, sync } from './store';

const query = new URLSearchParams(location.search);
const CONTENT = query.get('content') ?? './content';
const POLL_MS = Number(query.get('poll') ?? 30) * 1000;
const STALL_OVERRIDE_MS = query.get('stall') ? Number(query.get('stall')) * 1000 : undefined;
/** How long before the end of a spot the next one starts loading. */
const PREPARE_LEAD_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** The longest a spot waits for its data feeds' first load. */
const DATA_WAIT_MS = 3000;
const SUPERVISOR = query.get('supervisor') ?? 'http://127.0.0.1:8091';
/** The supervisor's secret, collected from it at first use. Never in the URL: templates can read that. */
let supervisorToken = '';
/**
 * Content on another origin is the API, which needs the screen's credential. Static content served
 * beside the player (the default, the demo) gets no credential, so it never leaves the device.
 */
const credential = new URL(CONTENT, location.href).origin === location.origin ? undefined : new DeviceCredential(SUPERVISOR);
const deviceHeaders = async () => (credential ? credential.headers() : {});

const statusEl = document.getElementById('status')!;
const hudEl = document.getElementById('hud')!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const status = (text: string) => {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'grid' : 'none';
};

interface PlayRecord {
  spot: string;
  playlist: string;
  manifest: string;
  startedAt: string;
  durationMs: number;
}

/** Live state, readable from DevTools and by the test rig. */
const state = {
  manifestId: '',
  playlist: '',
  spot: '',
  played: 0,
  skipped: 0,
  lastError: '',
  lastSync: '',
  online: navigator.onLine,
  /** Why the API refused this screen ('not authorised'), or '' while it accepts it. */
  auth: '',
  /** False outside the screen's display hours. */
  displayOn: true,
  /** How the supervisor last switched the panel, or why it could not. */
  display: '',
  persistent: false,
  /** JS heap in MB, where the browser reports it. */
  get heapMb(): number {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) : 0;
  },
  get data(): Record<string, string> {
    return dataStatus();
  },
  /** Live values and snapshots refused per data source: a broken feed shows here. */
  get dataRejected(): Record<string, number> {
    return dataRejections();
  },
  /** Frame pacing since the last reset. */
  frames: { count: 0, dropped: 0, maxMs: 0 },
  /** The same, split by what the player was doing: playing, loading the next spot, or transitioning. */
  byPhase: {} as Record<string, { count: number; dropped: number }>,
  log: [] as PlayRecord[],
  /** Frames longer than 50 ms: when in the spot they happened and what the player was doing. */
  stalls: [] as { spot: string; atMs: number; ms: number; phase: string; next: string }[],
};
Object.assign(window, { __sf: state });

// ------------------------------------------------------------ frame monitor
let lastFrame = 0;
let interval = 0;
const warmup: number[] = [];
let phase = 'idle';
let preparing = '';
let spotStartedAt = 0;
function monitor(t: number): void {
  // Asleep, the panel may have no signal and the browser stops producing frames: nothing to measure.
  if (!state.displayOn) {
    lastFrame = 0;
    return void requestAnimationFrame(monitor);
  }
  if (lastFrame) {
    const d = t - lastFrame;
    // The display's frame interval is the median of the first two seconds of frames.
    if (!interval) {
      warmup.push(d);
      if (warmup.length < 120) return (void requestAnimationFrame(monitor), void (lastFrame = t));
      interval = warmup.sort((x, y) => x - y)[60]!;
    }
    const missed = Math.max(0, Math.round(d / interval) - 1);
    state.frames.count++;
    state.frames.dropped += missed;
    const p = (state.byPhase[phase] ??= { count: 0, dropped: 0 });
    p.count++;
    p.dropped += missed;
    state.frames.maxMs = Math.max(state.frames.maxMs, Math.round(d));
    if (d > 50) {
      state.stalls.push({ spot: state.spot, atMs: Math.round(t - spotStartedAt), ms: Math.round(d), phase, next: preparing });
      if (state.stalls.length > 100) state.stalls.shift();
    }
  }
  lastFrame = t;
  requestAnimationFrame(monitor);
}

function renderHud(): void {
  const f = state.frames;
  const pct = f.count ? ((100 * f.dropped) / (f.count + f.dropped)).toFixed(2) : '0';
  hudEl.textContent =
    `manifest ${state.manifestId}  ${state.online ? 'online' : 'OFFLINE'}${state.auth ? `  ${state.auth.toUpperCase()}` : ''}\n` +
    `playlist ${state.playlist}\nspot     ${state.spot}\n` +
    `played ${state.played}  skipped ${state.skipped}${state.displayOn ? '' : '  ASLEEP'}\n` +
    `frames ${f.count}  dropped ${pct}%  worst ${f.maxMs} ms` +
    Object.entries(dataStatus())
      .map(([id, at]) => `\ndata ${id}  ${at.slice(11, 19)}Z`)
      .join('') +
    Object.entries(dataRejections())
      .map(([id, n]) => `\ndata ${id}  ${n} REFUSED`)
      .join('') +
    (state.lastError ? `\nlast error: ${state.lastError}` : '');
}

// ------------------------------------------------------------------ playback
const slots = [new Slot(), new Slot()] as const;
let front = 0;
let lastProgress = performance.now();

/**
 * Swap to `next`. While it loaded, `next` sat fully drawn underneath `prev`, so the browser has
 * already painted it; revealing it costs nothing. A crossfade fades the old spot out on top of it.
 */
function show(next: Slot, prev: Slot | undefined, transition: Transition): Promise<void> {
  if (prev && transition.type === 'fade') {
    // Out to black, then in. The next spot is hidden while the old one fades so only one is
    // ever drawn; it was fully drawn underneath until now, so it appears without a stall.
    const half = transition.ms / 2;
    next.el.style.transition = 'none';
    next.el.style.opacity = '0';
    next.el.style.zIndex = '2';
    prev.el.style.zIndex = '3';
    prev.el.style.transition = `opacity ${half}ms ease-in`;
    prev.el.style.opacity = '0';
    return sleep(half).then(() => {
      prev.el.style.transition = 'none';
      prev.el.style.zIndex = '1';
      prev.clear();
      next.el.style.transition = `opacity ${half}ms ease-out`;
      next.el.style.opacity = '1';
      next.play();
      return sleep(half);
    });
  }
  const ms = prev && transition.type === 'crossfade' ? transition.ms : 0;
  next.play();
  if (prev && ms) {
    prev.el.style.transition = `opacity ${ms}ms linear`;
    prev.el.style.opacity = '0';
  }
  return sleep(ms).then(() => {
    next.el.style.zIndex = '2';
    if (prev) {
      prev.el.style.transition = 'none';
      prev.el.style.opacity = '0';
      prev.el.style.zIndex = '1';
      prev.clear();
    }
  });
}

async function prepareStep(slot: Slot, step: Step, manifest: ScreenManifest): Promise<boolean> {
  try {
    // Underneath the spot on screen, fully drawn. It must stay visible to the browser: Chromium
    // stops rendering a frame it considers invisible, so a template loading at opacity 0 never
    // reaches ready.
    slot.el.style.transition = 'none';
    slot.el.style.zIndex = '1';
    slot.el.style.opacity = '1';
    await slot.prepare(step.spot, manifest);
    return true;
  } catch (err) {
    state.skipped++;
    state.lastError = `${step.spot.id}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn('[sf] skipped', state.lastError);
    slot.el.style.opacity = '0';
    slot.clear();
    return false;
  }
}

function record(step: Step, manifestId: string): void {
  state.spot = step.spot.id;
  state.playlist = step.playlist.id;
  state.played++;
  state.log.push({
    spot: step.spot.id,
    playlist: step.playlist.id,
    manifest: manifestId,
    startedAt: new Date().toISOString(),
    durationMs: step.spot.durationMs,
  });
  if (state.log.length > 500) state.log.shift();
  lastProgress = performance.now();
}

/** Resolves when the display goes to sleep, so a spot being held on screen gives way at once. */
let fellAsleep = new Promise<void>(() => {});
let markAsleep = () => {};
const resetSleepSignal = () => (fellAsleep = new Promise<void>((r) => (markAsleep = r)));
resetSleepSignal();
const hold = (ms: number) => Promise.race([sleep(ms), fellAsleep]);

let manifest: ScreenManifest | undefined;
let sequencer: Sequencer | undefined;
/**
 * Files cache cleanup must keep beyond the active manifest's: the spot on screen (`playing`) and
 * the spot loading (`preparing`), either of which may come from a manifest just replaced.
 */
const pins = new PinSet();

/**
 * Run a loop body forever. A bug or a bad value must never end playback: log it, wait, try again.
 */
async function forever(name: string, body: () => Promise<void>): Promise<never> {
  for (;;) {
    try {
      await body();
    } catch (err) {
      state.lastError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[sf] ${name} failed`, err);
      await sleep(5000);
    }
  }
}

async function playbackLoop(): Promise<never> {
  let current: Slot | undefined;
  let currentSpot: Spot | undefined;
  /** The manifest `currentSpot` came from: its files are named there. */
  let currentManifest: ScreenManifest | undefined;
  let startedAt = 0;
  let failures = 0;

  return forever('playback', async () => {
    if (!manifest || !sequencer) {
      await sleep(500);
      return;
    }
    if (!state.displayOn) {
      // Outside display hours: draw nothing at all, then start fresh when the panel wakes.
      for (const s of slots) {
        s.clear();
        s.el.style.opacity = '0';
      }
      current = undefined;
      currentSpot = undefined;
      pins.release('playing');
      pins.release('preparing');
      status('');
      state.spot = '';
      phase = 'sleep';
      while (!state.displayOn) await sleep(1000);
      lastProgress = performance.now();
      phase = 'play';
      return;
    }
    // Start loading the next spot shortly before the current one ends.
    if (currentSpot) await hold(startedAt + currentSpot.durationMs - PREPARE_LEAD_MS - performance.now());
    if (!state.displayOn) return;

    const m = manifest;
    const step = sequencer.next(new Date());
    if (!step) {
      for (const s of slots) {
        s.clear();
        s.el.style.opacity = '0';
      }
      current = undefined;
      currentSpot = undefined;
      pins.release('playing');
      status('SignForge\nNothing is scheduled for this screen.');
      lastProgress = performance.now(); // waiting on purpose, not stuck
      await sleep(5000);
      return;
    }
    const slot = slots[front === 0 ? 1 : 0];
    // A crossfade overlaps the end of the current spot; a fade's dark half does too.
    const tr = step.playlist.transition;
    const fadeMs = tr.type === 'crossfade' ? tr.ms : tr.type === 'fade' ? tr.ms / 2 : 0;
    // Pinned before the first await: a sync that replaces `m` meanwhile must not delete these files.
    pins.hold('preparing', spotFiles(step.spot, m));
    phase = 'prepare';
    preparing = step.spot.id;
    // A spot's data is fixed for its play: let its feeds finish their first load before it starts.
    if (step.spot.kind === 'template' && step.spot.bindings) {
      await dataSettled([...new Set(Object.values(step.spot.bindings).map((b) => b.source))], DATA_WAIT_MS);
    }
    const ok = await prepareStep(slot, step, m);
    preparing = '';
    if (!ok) pins.release('preparing');
    phase = 'play';
    if (!state.displayOn) return;
    if (!ok) {
      if (++failures >= MAX_CONSECUTIVE_FAILURES) {
        current?.clear();
        if (current) current.el.style.opacity = '0';
        current = undefined;
        currentSpot = undefined;
        pins.release('playing');
        status('SignForge\nContent is unavailable. Retrying…');
        lastProgress = performance.now();
        await sleep(5000);
        failures = 0;
      }
      return;
    }
    failures = 0;

    // Hold the current spot for its full length; a crossfade overlaps its last moments.
    if (currentSpot) await hold(startedAt + currentSpot.durationMs - fadeMs - performance.now());
    if (!state.displayOn) return;
    status('');
    startedAt = performance.now();
    spotStartedAt = startedAt;
    record(step, m.id);
    phase = 'transition';
    const done = show(slot, current, step.playlist.transition);
    // A video keeps reading its file from the cache while it plays, and the outgoing spot is
    // still on screen until the transition ends.
    const playing = spotFiles(step.spot, m);
    pins.hold('playing', currentSpot ? [...playing, ...spotFiles(currentSpot, currentManifest ?? m)] : playing);
    pins.release('preparing');
    front = front === 0 ? 1 : 0;
    current = slot;
    currentSpot = step.spot;
    currentManifest = m;
    await done;
    pins.hold('playing', playing);
    phase = 'play';
  });
}

// ------------------------------------------------------------------- display
/** Ask the device supervisor to power the panel. Without one (a browser, the demo) the player just goes dark. */
async function setPanel(on: boolean, retry = true): Promise<void> {
  try {
    if (!supervisorToken) {
      const t = await fetch(`${SUPERVISOR}/token`, { signal: AbortSignal.timeout(5000) });
      if (t.ok) supervisorToken = ((await t.json()) as { token: string }).token;
    }
    const res = await fetch(`${SUPERVISOR}/display/${on ? 'on' : 'off'}`, {
      method: 'POST',
      headers: { 'x-sf-token': supervisorToken },
      signal: AbortSignal.timeout(15_000),
    });
    // The supervisor makes a new token if its file is lost: collect it again, once.
    if (res.status === 403 && retry) {
      supervisorToken = '';
      return setPanel(on, false);
    }
    state.display = res.ok ? JSON.stringify(await res.json()) : `supervisor ${res.status}`;
  } catch {
    state.display = 'no supervisor';
  }
}

/** Follow the screen's display hours. Checked often rather than timed, so clock and DST changes are harmless. */
async function displayLoop(): Promise<never> {
  let applied: boolean | undefined;
  return forever('display', async () => {
    if (manifest) {
      const on = displayOn(manifest.screen.displayHours, localTime(new Date(), manifest.screen.timezone));
      if (on !== applied) {
        applied = on;
        console.info(`[sf] display ${on ? 'on' : 'off'}`);
        if (on) {
          // Never let a slow or missing supervisor keep the screen dark during opening hours.
          await Promise.race([setPanel(true), sleep(6000)]);
          // A panel takes a few seconds to lock onto a returning signal or come out of standby;
          // start after that so the first spot's intro is seen and the mode change is not measured.
          await sleep(3000);
          resetSleepSignal();
          state.displayOn = true; // wakes the playback loop
        } else {
          state.displayOn = false;
          markAsleep();
          await sleep(1500); // let the playback loop clear the slots before the signal goes
          await setPanel(false);
        }
      }
    }
    await sleep(15_000);
  });
}

// ---------------------------------------------------------------------- sync
async function syncLoop(): Promise<never> {
  return forever('sync', async () => {
    try {
      const result = await sync(CONTENT, {
        currentId: manifest?.id,
        headers: await deviceHeaders(),
        ...(STALL_OVERRIDE_MS ? { stallMs: STALL_OVERRIDE_MS } : {}),
        pinned: pins,
      });
      state.online = true;
      state.auth = '';
      state.lastSync = new Date().toISOString();
      if (result.changed && result.manifest) {
        console.info(`[sf] manifest ${result.manifest.id} active (${result.downloaded} files downloaded)`);
        adopt(result.manifest);
      }
    } catch (err) {
      if (err instanceof UnauthorisedError) {
        // The server answered, so this is not offline. Keep playing; pairing (M3-08) takes it from here.
        state.online = true;
        state.auth = credential?.held ? 'not authorised' : 'no credential';
        credential?.forget();
        if (!manifest) status('SignForge\nThis screen is not authorised.');
        await sleep(POLL_MS);
        return;
      }
      state.online = false;
      if (!manifest) status(`SignForge\nWaiting for content…\n${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(POLL_MS);
  });
}

/** Testing override: an ad hoc playlist of the given spots, replacing the schedule. */
function applyOverrides(m: ScreenManifest): ScreenManifest {
  const ids = query
    .get('spots')
    ?.split(',')
    .filter((id) => m.spots[id]);
  const t = query.get('transition');
  const transition: Transition | undefined =
    t === 'cut'
      ? { type: 'cut' }
      : t?.startsWith('fade')
        ? { type: 'fade', ms: Number(t.slice(4)) || 500 }
        : t
          ? { type: 'crossfade', ms: Number(t) }
          : undefined;
  if (!ids?.length && !transition) return m;
  const playlists = { ...m.playlists };
  if (ids?.length) playlists.__test = { id: '__test', name: 'Test', transition: transition ?? { type: 'cut' }, items: ids.map((spot) => ({ spot })) };
  else if (transition) for (const [id, p] of Object.entries(playlists)) playlists[id] = { ...p, transition };
  return { ...m, playlists, ...(ids?.length ? { schedule: [], defaultPlaylist: '__test' } : {}) };
}

/** Runs a data pass now; set once the data loop starts. */
let wakeData = () => {};

function adopt(next: ScreenManifest): void {
  next = applyOverrides(next);
  manifest = next;
  wakeData();
  state.manifestId = next.id;
  // The sequencer keeps its place; the change shows at the next spot boundary.
  if (sequencer) sequencer.setManifest(next);
  else sequencer = new Sequencer(next);
}

// ---------------------------------------------------------------------- boot
async function boot(): Promise<void> {
  if (query.get('debug')) {
    hudEl.style.display = 'block';
    const beat = document.getElementById('heartbeat')!;
    if (query.get('hb') === '1') beat.style.display = 'block';
    if (query.get('hud') === '0') hudEl.style.display = 'none';
    // Testing happens on an OLED panel: never leave debug pixels in one place.
    const corners = [
      { left: '1vmin', top: '1vmin', right: '', bottom: '' },
      { left: '', top: '1vmin', right: '1vmin', bottom: '' },
      { left: '', top: '', right: '1vmin', bottom: '1vmin' },
      { left: '1vmin', top: '', right: '', bottom: '1vmin' },
    ];
    let corner = 0;
    setInterval(() => {
      corner = (corner + 1) % corners.length;
      Object.assign(hudEl.style, corners[corner]);
      Object.assign(beat.style, corners[(corner + 2) % corners.length]);
    }, 60_000);
    setInterval(renderHud, 500);
  }
  requestAnimationFrame(monitor);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[sf] no service worker', e));
  state.persistent = await requestPersistence();

  const cached = await loadActiveManifest().catch(() => undefined);
  if (cached) adopt(cached);
  else status('SignForge\nWaiting for content…');

  // If playback stops advancing for far longer than any spot should take, start over.
  setInterval(() => {
    const longest = Math.max(60_000, ...Object.values(manifest?.spots ?? {}).map((s) => s.durationMs));
    if (!state.displayOn) lastProgress = performance.now();
    else if (manifest && performance.now() - lastProgress > longest + 30_000) location.reload();
  }, 10_000);

  void syncLoop();
  wakeData = startDataLoop(CONTENT, () => manifest, deviceHeaders);
  void playbackLoop();
  void displayLoop();
}

void boot();
