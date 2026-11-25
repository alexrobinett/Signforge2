/**
 * The playback loop: play the current spot, prepare the next out of sight, swap when it is ready.
 * It owns what plays and when: the two slots, the spot on screen, the files pinned for it and for
 * the one loading, the reasons the spot on screen gives way early (the display going to sleep, the
 * winning takeover changing, a newer preview draft), and falling back to the last good manifest.
 *
 * Everything it touches comes through the seam: a clock, the slots, the pins and the events it
 * reports. main.ts wires the browser to it; the unit tests (playback.test.ts) drive it with a fake
 * clock and fake slots, because the order of its calls between awaits is where bugs were (#123, M3-19).
 */
import { requiredFiles, type ScreenManifest, type Spot, type Transition } from '@signforge/contract';
import { Sequencer, activeTakeover, nextTakeoverEdge, spotFiles, type ClockTrust, type Step } from '@signforge/player-core';

/** How long before the end of a spot the next one starts loading. */
const PREPARE_LEAD_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** setTimeout's longest delay; a later takeover edge is checked again when this one fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface PlaybackClock {
  /** Monotonic ms (`performance.now()`): spot lengths and holds. */
  mono(): number;
  /** Corrected ms since the epoch (src/clock.ts): the schedule, takeovers and the play log. */
  now(): number;
  /** Whether the screen trusts `now()` (src/clock.ts). Untrusted, bounded schedule entries (takeovers) do not count, but for an alert's. */
  trust(): ClockTrust;
  /** Call `fn` after `ms` of monotonic time. Returns what cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export type SlotIndex = 0 | 1;

/** The two stacked slots (src/slot.ts), by index. */
export interface PlaybackSlots {
  /** Load `spot` into `slot`, under the one on screen and fully drawn. Resolves once it can be shown complete; rejects if it cannot. */
  prepare(slot: SlotIndex, spot: Spot, manifest: ScreenManifest): Promise<void>;
  /** Reveal `slot` over `prev` with `transition`. `started`: its spot plays (rejects if a video's `play()` is refused); `done`: the transition is over and `prev` is cleared. */
  show(slot: SlotIndex, prev: SlotIndex | undefined, transition: Transition): { started: Promise<void>; done: Promise<void> };
  /** Empty `slot` and hide it. */
  clear(slot: SlotIndex): void;
  /** Preview: show a new version of the spot in `slot` in place, and play it. Rejects as `prepare` does. */
  update(slot: SlotIndex, spot: Spot, manifest: ScreenManifest): Promise<void>;
}

/** The pin holders playback uses: `playing`, `preparing` and `last-good` (store.ts PinSet). */
interface PlaybackPins {
  hold(holder: string, hashes: Iterable<string>): void;
  release(holder: string): void;
}

/** What playback reports. */
interface PlaybackEvents {
  /** Show a line in the status overlay; '' hides it. */
  status(text: string): void;
  /** A spot shown at `at` (corrected time) has started and its transition ended: log and count it. */
  played(step: Step, manifestId: string, at: number): void;
  /** A spot was skipped: it did not become ready, or did not start. */
  skipped(message: string): void;
  /** Preview: a new version of the spot on screen could not be shown. */
  updateFailed(message: string): void;
  /** A spot was ready `ms` after its load started. */
  prepared(spotId: string, ms: number): void;
  /** Playback moved on, or waits on purpose: the watchdog's mark. */
  progress(): void;
  /** `manifest` is now the one playing: adopted, or fallen back to. */
  adopted(manifest: ScreenManifest): void;
  /** Nothing in manifest `from` played for a full pass of its playlist: the last good one plays instead. */
  fellBack(from: string): void;
  /** `manifest` played a spot and is now the last good one: store it. */
  good(manifest: ScreenManifest): void;
}

export interface PlaybackOptions {
  clock: PlaybackClock;
  slots: PlaybackSlots;
  pins: PlaybackPins;
  events: PlaybackEvents;
  /** The preview source: drafts replace each other at once, and none becomes the last good manifest. */
  preview: boolean;
  /** The manifest that plays for one as it arrived (the testing overrides `?spots=` and `?transition=`). */
  playing(arrived: ScreenManifest): ScreenManifest;
  /** Resolves once these data sources have had their first load, or the data wait is over. */
  dataSettled(sources: string[]): Promise<void>;
  /** Extra files a spot reads beyond the manifest's own (such as its bound snapshots' feed images). */
  extraFiles?(spot: Spot, manifest: ScreenManifest): Iterable<string>;
}

/** What the player is doing, for the frame monitor and `__sf`. */
export interface Activity {
  phase: 'idle' | 'sleep' | 'prepare' | 'transition' | 'play';
  /** The spot loading, or ''. */
  preparing: string;
  /** When the spot on screen started (monotonic). */
  spotStartedAt: number;
  /** The spot and playlist last played; the spot is '' while the display sleeps. */
  spot: string;
  playlist: string;
}

/** A promise that `raise` resolves, made anew by `reset`: something a hold races. */
class Signal {
  promise: Promise<void> = new Promise(() => {});
  raise: () => void = () => {};
  reset(): void {
    this.promise = new Promise((r) => (this.raise = r));
  }
}

export class Playback {
  readonly activity: Activity = { phase: 'idle', preparing: '', spotStartedAt: 0, spot: '', playlist: '' };

  #manifest?: ScreenManifest;
  /** `#manifest` as it arrived, before the testing overrides: what becomes the last good one. */
  #source?: ScreenManifest;
  #lastGood?: ScreenManifest;
  #fallbackFrom = '';
  #sequencer?: Sequencer;
  #displayOn = true;

  /** The slot on screen, or the one last on screen while `#onScreen` is unset. */
  #front: SlotIndex = 0;
  /** The spot on screen, the manifest its files are named in, and when it started (monotonic). */
  #onScreen?: { spot: Spot; manifest: ScreenManifest; startedAt: number };
  #failures = 0;
  /** Spots of `#failingManifest` that failed in a row, never reset by the pause after a few failures. */
  #failedInManifest = 0;
  #failingManifest = '';

  /** Resolves when the display goes to sleep, so a spot held on screen gives way at once. */
  #asleep = new Signal();
  /**
   * Takeovers (M3-19): the takeover the next spot was chosen under. When the one that should play
   * differs (one published, starting or ending), `#cutIn` is set and `#tookOver` raised: the spot on
   * screen gives way as soon as the next is ready, instead of at its end. Checked when a manifest is
   * adopted, after a sync moves the clock, and by a timer at the next takeover start or end, so a
   * takeover ends on time with the network down.
   */
  #chosenTakeover?: string;
  #cutIn = false;
  #tookOver = new Signal();
  #cancelTakeoverTimer = () => {};
  /** Preview: raised when a draft is adopted, so a play prepared from the older draft is prepared again at once. */
  #drafted = new Signal();

  constructor(private readonly o: PlaybackOptions) {
    this.#asleep.reset();
    this.#tookOver.reset();
  }

  /** The manifest playing, testing overrides applied. */
  get manifest(): ScreenManifest | undefined {
    return this.#manifest;
  }

  /** The last manifest that verifiably started a spot: the one playback falls back to. */
  get lastGood(): ScreenManifest | undefined {
    return this.#lastGood;
  }

  /** The id of the newest manifest while playback falls back from it, or ''. */
  get fallbackFrom(): string {
    return this.#fallbackFrom;
  }

  /** False while the display sleeps (display hours, an override). */
  get displayOn(): boolean {
    return this.#displayOn;
  }

  /** At boot: the last good manifest kept from before. Its files stay until a newer manifest has played. */
  restore(lastGood: ScreenManifest): void {
    this.#lastGood = lastGood;
    this.o.pins.hold('last-good', requiredFiles(lastGood));
  }

  /** Play `next` from the next spot boundary, or at once if the winning takeover changes. */
  adopt(next: ScreenManifest): void {
    this.#source = next;
    this.#fallbackFrom = '';
    const playing = this.o.playing(next);
    this.#manifest = playing;
    this.o.events.adopted(playing);
    // The sequencer keeps its place.
    if (this.#sequencer) this.#sequencer.setManifest(playing);
    else this.#sequencer = new Sequencer(playing);
    this.watchTakeover();
  }

  /** Preview: adopt a draft, and show the new version of the spot on screen at once if it has one. Resolves with that spot's id. */
  async adoptDraft(next: ScreenManifest): Promise<string | undefined> {
    this.adopt(next);
    this.#drafted.raise();
    const spot = this.#onScreen && this.#manifest?.spots[this.#onScreen.spot.id];
    if (!spot || !this.#manifest) return undefined;
    try {
      await this.o.slots.update(this.#front, spot, this.#manifest);
      return spot.id;
    } catch (err) {
      this.o.events.updateFailed(`${spot.id}: ${message(err)}`);
      return undefined;
    }
  }

  /** The display loop's decision. Off, the spot on screen gives way at once and nothing is drawn until it is on again. */
  display(on: boolean): void {
    if (on) this.#asleep.reset();
    this.#displayOn = on;
    if (!on) this.#asleep.raise();
  }

  /** The corrected clock moved (a sync): a takeover's start or end may have moved, or begun to count at all. */
  clockMoved(): void {
    this.watchTakeover();
  }

  /** One pass of the loop: at most one spot shown. main.ts runs it again and again. */
  async pass(): Promise<void> {
    const { clock, slots, pins, events } = this.o;
    if (!this.#manifest || !this.#sequencer) return this.wait(500);
    if (!this.#displayOn) {
      // Outside display hours: draw nothing at all, then start fresh when the panel wakes.
      this.blank('');
      this.activity.spot = '';
      this.activity.phase = 'sleep';
      while (!this.#displayOn) await this.wait(1000);
      events.progress();
      this.activity.phase = 'play';
      return;
    }
    // Start loading the next spot shortly before the current one ends, or at once when a takeover cuts in.
    if (this.#onScreen && !this.#cutIn) await this.hold(this.#onScreen.startedAt + this.#onScreen.spot.durationMs - PREPARE_LEAD_MS - clock.mono());
    if (!this.#displayOn) return;

    const m = this.#manifest;
    const chosenAt = new Date(clock.now());
    this.#drafted.reset();
    const drafted = this.#drafted.promise;
    const step = this.#sequencer.next(chosenAt, clock.trust());
    this.#chosenTakeover = activeTakeover(m, chosenAt, clock.trust());
    this.#tookOver.reset();
    this.watchTakeover();
    if (!step) {
      this.blank('SignForge\nNothing is scheduled for this screen.');
      events.progress(); // waiting on purpose, not stuck
      return this.wait(5000);
    }
    const slot: SlotIndex = this.#front === 0 ? 1 : 0;
    // A crossfade overlaps the end of the current spot; a fade's dark half does too.
    const tr = step.playlist.transition;
    const fadeMs = tr.type === 'crossfade' ? tr.ms : tr.type === 'fade' ? tr.ms / 2 : 0;
    // Pinned before the first await: a sync that replaces `m` meanwhile must not delete these files.
    pins.hold('preparing', this.filesFor(step.spot, m));
    this.activity.phase = 'prepare';
    this.activity.preparing = step.spot.id;
    // A spot's data is fixed for its play: let its feeds finish their first load before it starts.
    if (step.spot.kind === 'template' && step.spot.bindings) {
      await this.o.dataSettled([...new Set(Object.values(step.spot.bindings).map((b) => b.source))]);
    }
    const ok = await this.prepare(slot, step, m);
    this.activity.preparing = '';
    if (!ok) pins.release('preparing');
    this.activity.phase = 'play';
    if (!this.#displayOn) return;
    if (!ok) return this.failed(step, m);

    // Hold the current spot for its full length; a crossfade overlaps its last moments. A takeover cuts it short.
    if (this.#onScreen && !this.#cutIn)
      await Promise.race([this.hold(this.#onScreen.startedAt + this.#onScreen.spot.durationMs - fadeMs - clock.mono()), drafted]);
    if (!this.#displayOn) return;
    // Preview: a draft posted while this spot loaded or waited has made it old. The spot on screen
    // took the draft at once (adoptDraft); this place is loaded again from it, so the stage never
    // shows an older draft (#123). A screen plays it: a new manifest shows from the next spot.
    if (this.o.preview && this.#manifest !== m) {
      slots.clear(slot);
      this.#sequencer.again();
      return;
    }
    // The takeover changed while this spot was chosen and loaded: choose again, so the old schedule never shows.
    if (activeTakeover(this.#manifest, new Date(clock.now()), clock.trust()) !== this.#chosenTakeover) {
      slots.clear(slot);
      pins.release('preparing');
      this.#cutIn = true;
      return;
    }
    this.#cutIn = false;
    events.status('');
    const startedAt = clock.mono();
    this.activity.spotStartedAt = startedAt;
    const shownAt = clock.now();
    this.activity.phase = 'transition';
    const prev = this.#onScreen;
    const { started, done } = slots.show(slot, prev ? this.#front : undefined, tr);
    // A video keeps reading its file from the cache while it plays, and the outgoing spot is
    // still on screen until the transition ends.
    const playing = this.filesFor(step.spot, m);
    pins.hold('playing', prev ? [...playing, ...this.filesFor(prev.spot, prev.manifest)] : playing);
    pins.release('preparing');
    this.#front = slot;
    this.#onScreen = { spot: step.spot, manifest: m, startedAt };
    // A spot counts, and plays, once it has started: a video whose play() the browser refuses is a failed spot.
    const playedOk = await started.then(
      () => true,
      (err: unknown) => {
        events.skipped(`${step.spot.id}: did not start: ${message(err)}`);
        return false;
      },
    );
    await done;
    pins.hold('playing', playing);
    this.activity.phase = 'play';
    if (!playedOk) return this.failed(step, m);
    // After the transition: storing the play and a new last good manifest costs frames on a Pi.
    this.#failures = 0;
    this.#failedInManifest = 0;
    this.record(step, m.id, shownAt);
    this.promote(step.spot, m.id);
  }

  private filesFor(spot: Spot, manifest: ScreenManifest): Set<string> {
    const out = spotFiles(spot, manifest);
    if (this.o.extraFiles) for (const sha of this.o.extraFiles(spot, manifest)) out.add(sha);
    return out;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.o.clock.after(Math.max(0, ms), r));
  }

  private hold(ms: number): Promise<void> {
    return Promise.race([this.wait(ms), this.#asleep.promise, this.#tookOver.promise]);
  }

  private watchTakeover(): void {
    this.#cancelTakeoverTimer();
    const m = this.#manifest;
    if (!m) return;
    const at = new Date(this.o.clock.now());
    const trust = this.o.clock.trust();
    if (activeTakeover(m, at, trust) !== this.#chosenTakeover) {
      this.#cutIn = true;
      this.#tookOver.raise();
    }
    // On a clock it does not trust, an alert takeover starts and ends by the earliest the real time
    // can be, which runs on with the monotonic clock: count the next edge from there.
    const from = trust.clockTrusted === false ? new Date(trust.notBefore) : at;
    const edge = nextTakeoverEdge(m, from);
    if (edge) this.#cancelTakeoverTimer = this.o.clock.after(Math.min(edge.getTime() - from.getTime(), MAX_TIMER_MS), () => this.watchTakeover());
  }

  /** Nothing on screen: both slots cleared, their pins released, `text` in the status overlay. */
  private blank(text: string): void {
    this.o.slots.clear(0);
    this.o.slots.clear(1);
    this.#onScreen = undefined;
    this.o.pins.release('playing');
    this.o.pins.release('preparing');
    this.o.events.status(text);
  }

  private async prepare(slot: SlotIndex, step: Step, m: ScreenManifest): Promise<boolean> {
    try {
      const t0 = this.o.clock.mono();
      await this.o.slots.prepare(slot, step.spot, m);
      this.o.events.prepared(step.spot.id, Math.round(this.o.clock.mono() - t0));
      return true;
    } catch (err) {
      this.o.events.skipped(`${step.spot.id}: ${message(err)}`);
      this.o.slots.clear(slot);
      return false;
    }
  }

  /** A spot of `m` failed to prepare or to start: fall back after a full pass of them, pause after a few in a row. */
  private async failed(step: Step, m: ScreenManifest): Promise<void> {
    if (this.#failingManifest !== m.id) {
      this.#failingManifest = m.id;
      this.#failedInManifest = 0;
    }
    if (++this.#failedInManifest >= step.playlist.items.length && this.#lastGood && m.id !== this.#lastGood.id) {
      this.#failures = 0;
      this.#failedInManifest = 0;
      this.fallBack();
      return;
    }
    if (++this.#failures >= MAX_CONSECUTIVE_FAILURES) {
      this.blank('SignForge\nContent is unavailable. Retrying…');
      this.o.events.progress();
      await this.wait(5000);
      this.#failures = 0;
    }
  }

  /** Nothing in the current manifest has played for a full pass of its playlist: play the last good one until a newer one comes. */
  private fallBack(): void {
    const lastGood = this.#lastGood;
    if (!lastGood || !this.#manifest || lastGood.id === this.#manifest.id) return;
    const from = this.#manifest.id;
    console.warn(`[sf] manifest ${from} played nothing in a full pass; falling back to ${lastGood.id}`);
    this.adopt(lastGood);
    this.#fallbackFrom = from;
    this.o.events.fellBack(from);
  }

  private record(step: Step, manifestId: string, at: number): void {
    this.activity.spot = step.spot.id;
    this.activity.playlist = step.playlist.id;
    this.o.events.played(step, manifestId, at);
    this.o.events.progress();
  }

  /**
   * A spot of `manifestId` started playing, as far as the player can check: its manifest becomes
   * the last good one. A URL spot never counts: its frame loads even when the page failed, onto the
   * browser's error page. A draft in the preview is never a screen's last good manifest.
   */
  private promote(spot: Spot, manifestId: string): void {
    const source = this.#source;
    if (this.o.preview || spot.kind === 'url' || manifestId === this.#lastGood?.id || !source || source.id !== manifestId) return;
    this.#lastGood = source;
    this.o.pins.hold('last-good', requiredFiles(source));
    this.o.events.good(source);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
