/**
 * The screen's corrected clock (docs/architecture.md, Player, Clock). A Pi has no battery-backed
 * clock, so the player keeps an offset from server time and reads `now()` wherever it needs the
 * time: the schedule, display hours, play counts and templates.
 *
 * - Each sync measures `offsetMs` (server time minus device time, taking the request's midpoint)
 *   and returns it with the corrected time it was measured at (`syncedAt`), for the caller to persist.
 * - A jump of the device clock against the monotonic clock of more than 2 s (NTP stepping it) is
 *   folded into the offset, so corrected time stays continuous until the next sync.
 * - At start the persisted offset is used, but the clock is not trusted if corrected time is
 *   before `syncedAt` (it went backwards: a reboot with no clock) or before the player was built.
 *   A good sync makes it trusted.
 */

/** What the caller persists after a sync. */
export interface PersistedClock {
  offsetMs: number;
  syncedAt: number;
}

export interface ClockOptions {
  /** The device's wall clock, uncorrected (`Date.now`). */
  deviceNow: () => number;
  /** A clock that never jumps (`performance.now`). */
  monoNow: () => number;
  /** When this player was built: no real time is earlier. */
  buildTime: number;
  persisted?: PersistedClock;
}

/**
 * How far the screen trusts `now`. Untrusted, the clock is behind by an unknown amount, and
 * `notBefore` is the earliest the real time can be: when the player was built, or its last sync,
 * whichever is later, plus the time the screen has run since this page started (both were before
 * it, and the monotonic clock never jumps).
 */
export type ClockTrust = { clockTrusted?: true } | { clockTrusted: false; notBefore: number };

/** A device clock jump bigger than this is a step, not drift. */
export const CLOCK_JUMP_MS = 2000;

export class Clock {
  offsetMs: number;
  trusted: boolean;
  private markWall: number;
  private markMono: number;
  /** The monotonic clock when this page started: `trust()` counts the time run since. */
  private readonly startMono: number;

  constructor(private readonly o: ClockOptions) {
    this.offsetMs = Number.isFinite(o.persisted?.offsetMs) ? o.persisted!.offsetMs : 0;
    this.markWall = o.deviceNow();
    this.markMono = o.monoNow();
    this.startMono = this.markMono;
    const corrected = this.markWall + this.offsetMs;
    this.trusted = corrected >= o.buildTime && (o.persisted === undefined || corrected >= o.persisted.syncedAt);
  }

  /** Whether the schedule may trust `now()`, and if not, the earliest the real time can be. */
  trust(): ClockTrust {
    if (this.trusted) return {};
    const known = Math.max(this.o.buildTime, this.o.persisted?.syncedAt ?? this.o.buildTime);
    return { clockTrusted: false, notBefore: known + (this.o.monoNow() - this.startMono) };
  }

  /** Corrected time, in ms since the epoch. */
  now(): number {
    const wall = this.o.deviceNow();
    const mono = this.o.monoNow();
    const jump = wall - (this.markWall + (mono - this.markMono));
    if (Math.abs(jump) > CLOCK_JUMP_MS) this.offsetMs -= jump;
    this.markWall = wall;
    this.markMono = mono;
    return wall + this.offsetMs;
  }

  /**
   * A sync answered: `serverMs` is its server time; `sentAt` and `receivedAt` are the device clock
   * when the request went and the answer came. Returns what to persist.
   */
  synced(serverMs: number, sentAt: number, receivedAt: number): PersistedClock {
    this.offsetMs = Math.round(serverMs - (sentAt + receivedAt) / 2);
    this.markWall = this.o.deviceNow();
    this.markMono = this.o.monoNow();
    this.trusted = true;
    return { offsetMs: this.offsetMs, syncedAt: receivedAt + this.offsetMs };
  }
}
