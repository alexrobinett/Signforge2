/**
 * SignForge player shell. Boots from the cached manifest, keeps content in sync, and runs the
 * playback loop: play the current spot, prepare the next out of sight, swap when it is ready.
 *
 * Query options:  ?content=<url>  where manifest.json and blobs/ live (default ./content). On another
 *                                 origin it is the API's device base (`https://<api>/v1/device`) and every
 *                                 request carries the screen's credential, collected from the supervisor,
 *                                 if the credential is bound to this exact base (src/credential.ts)
 *                 ?poll=<seconds> static content: how often to look for a new manifest (default 30). With the
 *                                 API each look is a sync, every `nextSyncS` (5 minutes) with jitter, every
 *                                 2 minutes while the socket is down (src/sync-interval.ts), and this often
 *                                 after a failed one; a failed content fetch first retries after this long.
 *                                 Given explicitly, it is also the socket-down interval (testing)
 *                 ?stall=<seconds> give up on a download that receives nothing for this long (default 30; testing)
 *                 ?debug=1        show the on-screen status overlay
 *                 ?hb=1           with debug, also show a moving speck so every frame is drawn. It costs
 *                                 the Pi 4 about 7% of frames: use it only to validate measurements
 *                 ?spots=a,b      play only these spots, in order, ignoring the schedule (testing)
 *                 ?transition=cut|fade<ms>|<ms>  override the playlist transition (testing)
 *                 ?supervisor=<url>  the device supervisor that powers the panel (default http://127.0.0.1:8091)
 *                 ?source=preview  the CMS editor's preview: play drafts the framing CMS page posts (src/preview.ts)
 *                 ?pairmove=<seconds> how often the pairing code moves (default 60; testing)
 *                 ?kind=browser   a test screen in a browser tab (M3-41): content from the API even on the
 *                                 player's own origin, the credential kept in IndexedDB, no supervisor, and
 *                                 display power commands ignored
 *
 * Pairing (M3-08): from the API, a screen whose supervisor has no credential shows a pairing code
 * (src/pairing.ts) and plays once it is claimed. A credential the server refuses (a 401, or
 * `revoked` on the socket) is a revoke: the screen deletes it and everything it was sent, and
 * shows a code again (owner decision Q2, the default).
 */
import {
  SUPPORTED_MANIFEST_SCHEMAS,
  SUPPORTED_PROTOCOLS,
  parseSyncResponse,
  requiredFiles,
  type DeviceCommand,
  type ScreenKind,
  type ScreenManifest,
  type Spot,
  type SyncRequest,
  type Transition,
} from '@signforge/contract';
import { Sequencer, displayOn, localTime, spotFiles, type Step } from '@signforge/player-core';
import { clock, now, synced } from './clock';
import { BrowserCredential } from './browser-credential';
import { DeviceCredential, type ScreenCredential } from './credential';
import { identify } from './identify';
import { pair } from './pairing';
import { dataRejections, dataSettled, dataStatus, heldVersions, offerChecked, offerSnapshots, restoreSources, settleSources, startDataLoop } from './data';
import { activeOverride, setOverride, wakeable } from './override';
import { acknowledgePlays, loadPlays, pendingPlays, playBatch, recordPlay } from './plays';
import { startPreview, type Preview } from './preview';
import { Slot } from './slot';
import { NudgeSocket, UnauthorisedSync } from './socket';
import { contentRetryMs, syncGapMs, syncWaitMs, type SyncTiming } from './sync-interval';
import { SOURCE } from './source';
import { PinSet, UnauthorisedError, filesMissing, loadManifests, rememberGood, requestPersistence, sync, wipeContent } from './store';

declare const __SF_PLAYER_VERSION__: string;

const query = new URLSearchParams(location.search);
const CONTENT = query.get('content') ?? './content';
const POLL_MS = Number(query.get('poll') ?? 30) * 1000;
const POLL_OVERRIDE = query.has('poll');
const STALL_OVERRIDE_MS = query.get('stall') ? Number(query.get('stall')) * 1000 : undefined;
/** How long before the end of a spot the next one starts loading. */
const PREPARE_LEAD_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** The longest a spot waits for its data feeds' first load. */
const DATA_WAIT_MS = 3000;
const SUPERVISOR = query.get('supervisor') ?? 'http://127.0.0.1:8091';
/** How often the player tells the supervisor it is alive. Its `STALE_S` must allow for a few missed. */
const ALIVE_MS = 5000;
const KIND: ScreenKind = query.get('kind') === 'browser' ? 'browser' : 'device';
/** The supervisor's secret, collected from it at first use. Never in the URL: templates can read that. */
let supervisorToken = '';

/** A request to the supervisor with its token. It makes a new token if its file is lost: then the token is collected again, once. */
async function supervisorFetch(path: string, init: RequestInit, retry = true): Promise<Response> {
  if (!supervisorToken) {
    const t = await fetch(`${SUPERVISOR}/token`, { signal: AbortSignal.timeout(5000) });
    if (t.ok) supervisorToken = ((await t.json()) as { token: string }).token;
  }
  const res = await fetch(`${SUPERVISOR}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), 'x-sf-token': supervisorToken },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 && retry) {
    supervisorToken = '';
    return supervisorFetch(path, init, false);
  }
  return res;
}
/** The content base, absolute: every request for content goes under it. */
const BASE = new URL(CONTENT, location.href).href.replace(/\/$/, '');
/**
 * Content on another origin is the API, which needs the screen's credential. Static content served
 * beside the player (the default, the demo) gets no credential, so it never leaves the device. A
 * browser test screen is served on the CMS's hostname, where the API is on its own origin.
 */
const credential: ScreenCredential | undefined =
  KIND === 'browser'
    ? new BrowserCredential(BASE)
    : new URL(BASE).origin === location.origin
      ? undefined
      : new DeviceCredential(BASE, SUPERVISOR, supervisorFetch);
const deviceHeaders = async () => (credential ? credential.headers() : {});
/** Static content: while nothing nudges, the manifest is polled this often. */
const SOCKET_POLL_MS = 300_000;
/** With the API, even an unchanged manifest is fetched this often, to put back files the browser evicted. */
const FILE_CHECK_MS = 3_600_000;
/** A reload command is obeyed at most this often, so a player that cannot play what it is sent does not reload in a loop. */
const RELOAD_GAP_MS = 15 * 60_000;

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
  /**
   * 'pairing' while a code is shown, 'revoked' while the screen wipes itself, 'no credential' while
   * the supervisor cannot be asked, 'paired with another API' while its credential is bound to an
   * API other than `content`; '' once the API accepts it.
   */
  auth: '',
  /** The pairing code on screen, or ''. */
  pairing: '',
  /** False outside the screen's display hours, or while an override turns the panel off. */
  displayOn: true,
  /** Whether the nudge socket to the API is open. While it is, the manifest is not polled. */
  socket: false,
  /** How the supervisor last switched the panel, or why it could not. */
  display: '',
  /** The correction from server time, and whether the player trusts its clock (src/clock.ts). */
  get clock(): { offsetMs: number; trusted: boolean } {
    return { offsetMs: clock.offsetMs, trusted: clock.trusted };
  },
  /** Plays counted and not yet acknowledged by a sync. */
  get playsPending(): number {
    return pendingPlays();
  },
  persistent: false,
  /** The id of the last manifest that verifiably started a spot (`promote`): the one the player falls back to. */
  lastGood: '',
  /**
   * The id of the newest manifest while the player falls back from it, because nothing in it
   * played for a full pass of its playlist; '' otherwise. Reported in the heartbeat (`manifest.fallbackFrom`).
   */
  fallback: '',
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
  /** How long each of the last 50 prepares took, from the start of loading to ready: the 500 ms budget. */
  prepares: [] as { spot: string; ms: number }[],
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
    `clock ${clock.offsetMs >= 0 ? '+' : ''}${(clock.offsetMs / 1000).toFixed(1)} s${clock.trusted ? '' : '  UNTRUSTED'}  plays pending ${pendingPlays()}\n` +
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
 * `started` is `next`'s `play()`; `done`, the end of the transition.
 */
function show(next: Slot, prev: Slot | undefined, transition: Transition): { started: Promise<void>; done: Promise<void> } {
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
    const revealed = sleep(half).then(() => {
      prev.el.style.transition = 'none';
      prev.el.style.zIndex = '1';
      prev.clear();
      next.el.style.transition = `opacity ${half}ms ease-out`;
      next.el.style.opacity = '1';
    });
    return { started: revealed.then(() => next.play()), done: revealed.then(() => sleep(half)) };
  }
  const ms = prev && transition.type === 'crossfade' ? transition.ms : 0;
  const started = next.play();
  if (prev && ms) {
    prev.el.style.transition = `opacity ${ms}ms linear`;
    prev.el.style.opacity = '0';
  }
  const done = sleep(ms).then(() => {
    next.el.style.zIndex = '2';
    if (prev) {
      prev.el.style.transition = 'none';
      prev.el.style.opacity = '0';
      prev.el.style.zIndex = '1';
      prev.clear();
    }
  });
  return { started, done };
}

async function prepareStep(slot: Slot, step: Step, manifest: ScreenManifest): Promise<boolean> {
  try {
    // Underneath the spot on screen, fully drawn. It must stay visible to the browser: Chromium
    // stops rendering a frame it considers invisible, so a template loading at opacity 0 never
    // reaches ready.
    slot.el.style.transition = 'none';
    slot.el.style.zIndex = '1';
    slot.el.style.opacity = '1';
    const t0 = performance.now();
    await slot.prepare(step.spot, manifest);
    state.prepares.push({ spot: step.spot.id, ms: Math.round(performance.now() - t0) });
    if (state.prepares.length > 50) state.prepares.shift();
    return true;
  } catch (err) {
    state.skipped++;
    state.lastError = `${step.spot.id}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn('[sf] skipped', state.lastError);
    preview?.failed(state.lastError);
    slot.el.style.opacity = '0';
    slot.clear();
    return false;
  }
}

/**
 * A spot of `manifestId` started playing, as far as the player can check: its manifest becomes
 * the last good one. A URL spot never counts: its frame loads even when the page failed, onto the
 * browser's error page. A draft in the preview is never a screen's last good manifest.
 */
function promote(spot: Spot, manifestId: string): void {
  if (SOURCE !== 'device' || spot.kind === 'url' || manifestId === state.lastGood || source?.id !== manifestId) return;
  state.lastGood = manifestId;
  lastGood = source;
  pins.hold('last-good', requiredFiles(source));
  rememberGood(source).catch((err: unknown) => console.warn('[sf] could not store the last good manifest', err));
}

/** A spot shown at `at` (corrected time) has played: logged, and counted. */
function record(step: Step, manifestId: string, at: number): void {
  preview?.played(manifestId, step.spot.id);
  state.spot = step.spot.id;
  state.playlist = step.playlist.id;
  state.played++;
  // On a clock it does not trust the screen cannot say which hour a play was in: not counted.
  if (SOURCE === 'device' && clock.trusted) recordPlay(at, step.spot.id, step.spot.durationMs);
  state.log.push({
    spot: step.spot.id,
    playlist: step.playlist.id,
    manifest: manifestId,
    startedAt: new Date(at).toISOString(),
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
/** `manifest` as it arrived, before testing overrides: what is stored as the last good one. */
let source: ScreenManifest | undefined;
/** The last manifest that played a spot. */
let lastGood: ScreenManifest | undefined;
let sequencer: Sequencer | undefined;
/**
 * Files cache cleanup must keep beyond the active manifest's: the spot on screen (`playing`) and
 * the spot loading (`preparing`), either of which may come from a manifest just replaced.
 */
const pins = new PinSet();

/**
 * Nothing in the current manifest has played for a full pass of its playlist: go back to the
 * last manifest that played, until the server sends a newer one.
 */
function fallBack(): void {
  if (!lastGood || !manifest || lastGood.id === manifest.id) return;
  const from = manifest.id;
  console.warn(`[sf] manifest ${from} played nothing in a full pass; falling back to ${lastGood.id}`);
  adopt(lastGood);
  state.fallback = from;
}

/**
 * Run a loop body again and again, restarting it 5 s after it throws: a bug or a bad value must
 * never end playback. The error is logged and shown as `lastError`.
 */
async function loopRestartingOnError(name: string, body: () => Promise<void>): Promise<never> {
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
  /** Spots of the current manifest that failed in a row, never reset by the pause below. */
  let failedInManifest = 0;
  let failingManifest = '';

  /** A spot of `m` failed to prepare or to start: fall back after a full pass of them, pause after a few in a row. */
  async function failed(step: Step, m: ScreenManifest): Promise<void> {
    if (failingManifest !== m.id) {
      failingManifest = m.id;
      failedInManifest = 0;
    }
    if (++failedInManifest >= step.playlist.items.length && m.id !== state.lastGood && lastGood) {
      failures = 0;
      failedInManifest = 0;
      fallBack();
      return;
    }
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
  }

  return loopRestartingOnError('playback', async () => {
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
    const step = sequencer.next(new Date(now()), { clockTrusted: clock.trusted });
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
    if (!ok) return failed(step, m);

    // Hold the current spot for its full length; a crossfade overlaps its last moments.
    if (currentSpot) await hold(startedAt + currentSpot.durationMs - fadeMs - performance.now());
    if (!state.displayOn) return;
    status('');
    startedAt = performance.now();
    spotStartedAt = startedAt;
    const shownAt = now();
    phase = 'transition';
    const { started, done } = show(slot, current, step.playlist.transition);
    // A video keeps reading its file from the cache while it plays, and the outgoing spot is
    // still on screen until the transition ends.
    const playing = spotFiles(step.spot, m);
    pins.hold('playing', currentSpot ? [...playing, ...spotFiles(currentSpot, currentManifest ?? m)] : playing);
    pins.release('preparing');
    front = front === 0 ? 1 : 0;
    current = slot;
    currentSpot = step.spot;
    currentManifest = m;
    // A spot counts, and plays, once it has started: a video whose play() the browser refuses is a failed spot.
    const playedOk = await started.then(
      () => true,
      (err: unknown) => {
        state.skipped++;
        state.lastError = `${step.spot.id}: did not start: ${err instanceof Error ? err.message : String(err)}`;
        console.warn('[sf] skipped', state.lastError);
        preview?.failed(state.lastError);
        return false;
      },
    );
    await done;
    pins.hold('playing', playing);
    phase = 'play';
    if (!playedOk) return failed(step, m);
    // After the transition: storing the play and a new last good manifest costs frames on a Pi.
    failures = 0;
    failedInManifest = 0;
    record(step, m.id, shownAt);
    promote(step.spot, m.id);
  });
}

// ------------------------------------------------------------------- display
/** What the supervisor reported for each power method at the last switch, for the heartbeat. */
let displayMethods: Record<string, string> | undefined;

/** Ask the device supervisor to power the panel; true once it confirms. Without one (a browser, the demo) the player just goes dark. */
async function setPanel(on: boolean): Promise<boolean> {
  if (KIND === 'browser') {
    state.display = 'browser: no panel';
    return true;
  }
  try {
    const res = await supervisorFetch(`/display/${on ? 'on' : 'off'}`, { method: 'POST' });
    if (res.ok) {
      const reply = (await res.json()) as Record<string, unknown>;
      state.display = JSON.stringify(reply);
      displayMethods = Object.fromEntries(Object.entries(reply).filter((e): e is [string, string] => typeof e[1] === 'string'));
      return true;
    }
    state.display = `supervisor ${res.status}`;
  } catch {
    state.display = 'no supervisor';
  }
  return false;
}

/** A switch the supervisor did not confirm (restarting, busy) is asked for again this soon. */
const PANEL_RETRY_MS = 5000;

/** Follow the screen's display hours. Checked often rather than timed, so clock and DST changes are harmless. */
const display = wakeable();
async function displayLoop(): Promise<never> {
  /** What the loop last decided: playback follows this. */
  let applied: boolean | undefined;
  /** The switch the supervisor last confirmed. */
  let confirmed: boolean | undefined;
  return loopRestartingOnError('display', async () => {
    // An untrusted clock is behind, by any amount: neither the hours nor a saved override can be
    // read against it, and a dark screen in opening hours is the worse mistake, with or without
    // content to show. The first good sync wakes this loop to read them again.
    let on: boolean | undefined;
    if (!clock.trusted) on = true;
    else if (manifest) {
      const at = new Date(now());
      const override = activeOverride(at);
      on = override ? override.state === 'on' : displayOn(manifest.screen.displayHours, localTime(at, manifest.screen.timezone));
    }
    if (on !== undefined && on !== applied) {
      applied = on;
      console.info(`[sf] display ${on ? 'on' : 'off'}`);
      if (on) {
        // Never let a slow or missing supervisor keep the screen dark during opening hours.
        confirmed = (await Promise.race([setPanel(true), sleep(6000).then(() => false)])) ? true : undefined;
        // A panel takes a few seconds to lock onto a returning signal or come out of standby;
        // start after that so the first spot's intro is seen and the mode change is not measured.
        await sleep(3000);
        resetSleepSignal();
        state.displayOn = true; // wakes the playback loop
      } else {
        state.displayOn = false;
        markAsleep();
        await sleep(1500); // let the playback loop clear the slots before the signal goes
        confirmed = (await setPanel(false)) ? false : undefined;
      }
    } else if (applied !== undefined && confirmed !== applied) {
      confirmed = (await setPanel(applied)) ? applied : undefined;
    }
    // A display override from the socket wakes this at once.
    await display.wait(confirmed === applied ? 15_000 : PANEL_RETRY_MS);
  });
}

// ---------------------------------------------------------------------- sync
const poll = wakeable();

let revoking: Promise<void> | undefined;

/**
 * The server refused the credential this screen sent: it was revoked. Delete it from the
 * supervisor and wipe everything the screen was sent, then pair again. A screen that held content
 * reloads, so nothing of it stays in memory either; one that held none pairs where it is.
 */
function revoked(): Promise<void> {
  revoking ??= (async () => {
    console.warn("[sf] the server refused this screen's credential: wiping what it holds and pairing again");
    state.online = true;
    state.auth = 'revoked';
    const held = !!manifest || !!lastGood || pendingPlays() > 0;
    // No content fetch may store or adopt anything after the wipe: stop the one in flight, and any retry.
    contentDue = false;
    contentAbort.abort(new Error('revoked'));
    await contentFetch?.catch(() => undefined);
    contentAbort = new AbortController();
    await credential?.revoke();
    setOverride(null);
    await wipeContent().catch((err: unknown) => console.warn('[sf] could not wipe the cache', err));
    if (held) {
      location.reload();
      await new Promise(() => {}); // the page is going
    }
  })().finally(() => (revoking = undefined));
  return revoking;
}

/** Show a code until it is claimed, or until a credential turns up another way (installed by hand, the supervisor back). */
async function pairScreen(): Promise<void> {
  if (!credential) return;
  state.auth = 'pairing';
  status('');
  const got = await pair({
    base: BASE,
    kind: KIND,
    moveMs: query.get('pairmove') ? Number(query.get('pairmove')) * 1000 : undefined,
    // A credential for another API turning up stops it too: pairing here would replace it.
    stop: async () => ['held', 'elsewhere'].includes(await credential.check()),
    onCode: (code) => (state.pairing = code),
  });
  if (got) {
    console.info('[sf] paired');
    await credential.adopt(got);
  }
  state.auth = '';
  if (!manifest) status('SignForge\nWaiting for content…');
}

function command(c: DeviceCommand): void {
  console.info(`[sf] command ${c.type}`);
  if (c.type === 'reload') reload();
  else if (c.type === 'restart') location.reload();
  else if (c.type === 'identify') identify(c.name, c.seconds);
  // A browser tab has no panel to power.
  else if (c.type === 'display' && KIND === 'browser') console.info('[sf] display: ignored on a browser screen');
  else if (c.type === 'display') {
    setOverride(c.override);
    display.wake();
  } else console.warn('[sf] reboot: the supervisor cannot reboot the device yet');
}

/**
 * Reload the player, unless it did so recently: the server sends `reload` on every sync while
 * this build cannot play what it compiles, and a reload only helps once the device has a newer one.
 */
function reload(): void {
  const KEY = 'sf.reloadedAt';
  let last = 0;
  try {
    last = Number(localStorage.getItem(KEY)) || 0;
  } catch {
    // Storage unavailable: reload anyway.
  }
  const t = Date.now();
  if (t >= last && t - last < RELOAD_GAP_MS) return console.warn('[sf] reload: already reloaded in the last 15 minutes');
  try {
    localStorage.setItem(KEY, String(t));
  } catch {
    // As above.
  }
  location.reload();
}

/** Content from the API (on another origin, with a credential): the sync carries everything. */
const API = !!credential && SOURCE === 'device';

/** The nudge socket, when a screen's content comes from the API (never in the preview). */
const socket = API
  ? new NudgeSocket({
      base: BASE,
      ticket: () => nextTicket(),
      onNudge: () => poll.wake(),
      onCommand: command,
      // `revoked` on the socket. A refused sync is handled by the sync loop.
      onUnauthorised: () => {
        if (credential?.held) void revoked().then(() => poll.wake());
      },
      onChange: (open) => {
        state.socket = open;
        // Down: sync now for any nudge missed (as often as the socket-down interval allows), then poll.
        if (!open) syncSoon();
      },
    })
  : undefined;

/** Fetch the manifest; adopt it if new. Downloads every file it names that is missing. `signal` stops it, adopting nothing. */
async function fetchManifest(signal?: AbortSignal): Promise<void> {
  // While falling back, the manifest that failed counts as current: the server's answer is
  // 304 until it publishes something newer.
  const result = await sync(BASE, {
    currentId: state.fallback || manifest?.id,
    headers: await deviceHeaders(),
    ...(STALL_OVERRIDE_MS ? { stallMs: STALL_OVERRIDE_MS } : {}),
    pinned: pins,
    ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) return;
  if (result.changed && result.manifest) {
    console.info(`[sf] manifest ${result.manifest.id} active (${result.downloaded} files downloaded)`);
    adopt(result.manifest);
  }
}

// ------------------------------------------------------------ sync with the API
/** Callers waiting for the next sync's socket ticket. */
let ticketWaiters: { resolve: (t: string) => void; reject: (e: unknown) => void }[] = [];
/** The last sync's ticket while nobody has used it, and when it came (`performance.now()`). */
let spareTicket: { value: string; at: number } | undefined;

/** A socket ticket: one a sync brought in the last 30 seconds (they last 60), or the next sync's. */
function nextTicket(): Promise<string> {
  if (spareTicket && performance.now() - spareTicket.at < 30_000) {
    const t = spareTicket.value;
    spareTicket = undefined;
    return Promise.resolve(t);
  }
  return new Promise((resolve, reject) => {
    ticketWaiters.push({ resolve, reject });
    // A sync soon, but no sooner than the socket-down interval allows: else it waits for the next one.
    syncSoon();
  });
}

function settleTickets(result: { ticket: string } | { error: unknown }): void {
  const waiting = ticketWaiters;
  ticketWaiters = [];
  if ('ticket' in result) {
    spareTicket = waiting.length ? undefined : { value: result.ticket, at: performance.now() };
    for (const w of waiting) w.resolve(result.ticket);
  } else for (const w of waiting) w.reject(result.error);
}

/** When the manifest was last fetched in full, to put back evicted files (`performance.now()`). */
let lastFileCheck = Number.NEGATIVE_INFINITY;

const content = wakeable();
/** A sync asked for the content, and it has not been fetched since. */
let contentDue = false;
/** Stops the content worker's fetch in flight (a revoke), and the fetch itself while it runs. */
let contentAbort = new AbortController();
let contentFetch: Promise<void> | undefined;

/**
 * The one worker that fetches content from the API: the manifest the server wants now, and its
 * files. A sync only asks for it, so a long download or a failure never holds back the next
 * heartbeat. A failure retries on its own, backing off (src/sync-interval.ts); a sync meanwhile
 * makes it try at once, and every attempt fetches the latest desired manifest.
 */
async function contentLoop(): Promise<never> {
  let failures = 0;
  return loopRestartingOnError('content', async () => {
    if (!contentDue) return content.wait(FILE_CHECK_MS);
    contentDue = false;
    const { signal } = contentAbort;
    try {
      await (contentFetch = fetchManifest(signal));
      lastFileCheck = performance.now();
      failures = 0;
    } catch (err) {
      // Stopped by a revoke, which also cancelled what was due.
      if (signal.aborted) return;
      // Refused: the sync revokes.
      if (err instanceof UnauthorisedError) return poll.wake();
      contentDue = true;
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = `content: ${message}`;
      console.warn('[sf] could not fetch the content', err);
      if (!manifest) status(`SignForge\nWaiting for content…\n${message}`);
      await content.wait(contentRetryMs(++failures, timing()));
    } finally {
      contentFetch = undefined;
    }
  });
}

/** The heartbeat and play counts up; manifest, snapshots, server time, ticket and commands down. */
async function apiSync(): Promise<void> {
  const batch = playBatch(now());
  const req: SyncRequest = {
    seq: batch.seq,
    epoch: batch.epoch,
    player: { version: __SF_PLAYER_VERSION__, manifestSchemas: SUPPORTED_MANIFEST_SCHEMAS, protocols: SUPPORTED_PROTOCOLS },
    manifest: { ...(manifest ? { active: manifest.id } : {}), filesMissing: filesMissing(), ...(state.fallback ? { fallbackFrom: state.fallback } : {}) },
    display: { on: state.displayOn, ...(displayMethods ? { methods: displayMethods } : {}), ...withOverride() },
    deviceTime: new Date().toISOString(),
    clock: { offsetMs: clock.offsetMs, trusted: clock.trusted },
    playCounts: batch.counts,
    snapshots: heldVersions(),
    dataRejected: dataRejections(),
  };
  const sentAt = Date.now();
  const res = await fetch(`${BASE}/sync`, {
    method: 'POST',
    cache: 'no-store',
    // Never the session cookie a test screen on the CMS's hostname has: the API refuses it.
    credentials: 'omit',
    headers: { ...(await deviceHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(20_000),
  });
  const receivedAt = Date.now();
  if (res.status === 401) throw new UnauthorisedError();
  if (!res.ok) throw new Error(`sync: HTTP ${res.status}`);
  const parsed = parseSyncResponse(await res.json());
  if (!parsed.ok) throw new Error(`sync: ${parsed.problems.join('; ')}`);
  const r = parsed.value;
  syncTiming.nextSyncS = r.nextSyncS;
  const wasTrusted = clock.trusted;
  synced(r.serverTime, sentAt, receivedAt);
  if (r.epoch === batch.epoch) acknowledgePlays(r.epoch, r.ackSeq);
  settleTickets({ ticket: r.socketTicket });
  state.online = true;
  state.auth = '';
  state.lastSync = new Date(now()).toISOString();
  // Before anything awaits: a display override in this answer must be in place when the display
  // loop next looks, or the first trusted look could switch the panel off and the override on again.
  for (const c of r.commands) command(c);
  // Display hours and any saved override were set aside while the clock was untrusted.
  if (!wasTrusted) display.wake();

  const current = state.fallback || manifest?.id;
  if (r.desiredManifest && (r.desiredManifest !== current || filesMissing() > 0 || performance.now() - lastFileCheck > FILE_CHECK_MS)) {
    contentDue = true;
    content.wake();
  }
  await offerSnapshots(r.snapshots, manifest);
  await offerChecked(r.checked ?? {});
}

// Untrusted, the player applies no override (displayLoop), so it reports none: reading one would
// also expire it against that clock. The first trusted look at the display does.
const withOverride = () => {
  const o = clock.trusted ? activeOverride(new Date(now())) : null;
  return o ? { override: o } : {};
};

/** The sync loop's timing inputs (src/sync-interval.ts). */
const syncTiming = {
  nextSyncS: SOCKET_POLL_MS / 1000,
  ok: false,
  /** When the last pass started (`performance.now()`). */
  at: Number.NEGATIVE_INFINITY,
};
const timing = (): SyncTiming => ({
  api: API,
  ok: syncTiming.ok,
  socketOpen: !!socket?.open,
  nextSyncS: syncTiming.nextSyncS,
  pollMs: POLL_MS,
  pollOverride: POLL_OVERRIDE,
});

/** Wake the sync loop if the last pass was at least the socket-down interval ago. */
function syncSoon(): void {
  if (performance.now() - syncTiming.at >= syncGapMs(timing())) poll.wake();
}

async function syncLoop(): Promise<never> {
  return loopRestartingOnError('sync', async () => {
    syncTiming.at = performance.now();
    syncTiming.ok = false;
    try {
      if (API && credential) {
        const has = await credential.check();
        // No supervisor to ask, with content playing: keep playing it rather than cover it with a code.
        if (has === 'none' || (has === 'unknown' && !manifest)) await pairScreen();
        else if (has === 'unknown') state.auth = 'no credential';
        else if (has === 'elsewhere') {
          // Neither sent nor replaced. What is cached keeps playing.
          state.auth = 'paired with another API';
          if (!manifest) status('SignForge\nThis screen is paired with another API than its address names.');
        }
        if (credential.held) {
          await apiSync();
          syncTiming.ok = true;
        }
      } else {
        await fetchManifest();
        state.online = true;
        state.auth = '';
        state.lastSync = new Date(now()).toISOString();
      }
    } catch (err) {
      if (API) settleTickets({ error: err instanceof UnauthorisedError ? new UnauthorisedSync('sync: not authorised') : err });
      // The sync's own data has gone as far as it will: spots waiting for feeds start with what is stored.
      if (API) settleSources(manifest);
      if (err instanceof UnauthorisedError) {
        // Refused with a credential: revoked. Refused without one cannot happen (no request goes without).
        if (credential?.held) await revoked();
        return;
      }
      state.online = false;
      if (!manifest) status(`SignForge\nWaiting for content…\n${err instanceof Error ? err.message : String(err)}`);
    }
    // The server says when to look; sooner while the socket is down, or after a failure.
    await poll.wait(syncWaitMs(timing()));
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
  source = next;
  state.fallback = '';
  next = applyOverrides(next);
  manifest = next;
  wakeData();
  if (API) void restoreSources(next);
  state.manifestId = next.id;
  socket?.reportApplied(next.id);
  // The sequencer keeps its place; the change shows at the next spot boundary.
  if (sequencer) sequencer.setManifest(next);
  else sequencer = new Sequencer(next);
}

// ------------------------------------------------------------------- preview
/** Set in preview mode: where the playback loop reports to the CMS. */
let preview: Preview | undefined;

/** Preview: adopt a draft, and show the new version of the spot on screen at once if it has one. */
async function adoptDraft(next: ScreenManifest): Promise<string | undefined> {
  adopt(next);
  const slot = slots[front === 0 ? 0 : 1];
  const spot = slot.spot && manifest?.spots[slot.spot.id];
  if (!spot || !manifest) return undefined;
  try {
    await slot.update(spot, manifest);
    return spot.id;
  } catch (err) {
    state.lastError = `${spot.id}: ${err instanceof Error ? err.message : String(err)}`;
    preview?.failed(state.lastError);
    return undefined;
  }
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
  if (SOURCE === 'preview') {
    // No service worker, storage, sync, data loop, display hours or watchdog reload: the CMS page
    // owns what plays, and a reload would lose the draft.
    preview = startPreview({ adopt: adoptDraft, status });
    void playbackLoop();
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[sf] no service worker', e));
  state.persistent = await requestPersistence();
  await loadPlays();

  const stored = await loadManifests().catch((err: unknown) => {
    console.warn('[sf] could not read stored manifests', err);
    return {} as Awaited<ReturnType<typeof loadManifests>>;
  });
  lastGood = stored.lastGood;
  // Its files stay until a newer manifest has played, in case the active one plays nothing.
  if (lastGood) pins.hold('last-good', requiredFiles(lastGood));
  state.lastGood = lastGood?.id ?? '';
  const cached = stored.active ?? stored.lastGood;
  if (cached) adopt(cached);
  else status('SignForge\nWaiting for content…');

  // If playback stops advancing for far longer than any spot should take, start over.
  setInterval(() => {
    const longest = Math.max(60_000, ...Object.values(manifest?.spots ?? {}).map((s) => s.durationMs));
    if (!state.displayOn) lastProgress = performance.now();
    else if (manifest && performance.now() - lastProgress > longest + 30_000) location.reload();
  }, 10_000);
  // That watchdog runs in the renderer it watches. The supervisor restarts the kiosk when these
  // beats stop (device/pi/supervisor.py). Without a supervisor (the demo in a browser) nobody hears them.
  if (KIND === 'device') setInterval(() => void supervisorFetch('/alive', { method: 'POST' }).catch(() => undefined), ALIVE_MS);

  void syncLoop();
  if (API) void contentLoop();
  socket?.start();
  // From the API, snapshots come on the sync; static content has no sync, so each source is fetched.
  // Never with the credential: from the API, data comes on the sync.
  if (!API) wakeData = startDataLoop(BASE, () => manifest);
  void playbackLoop();
  void displayLoop();
}

void boot();
