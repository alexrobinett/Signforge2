/**
 * The player's corrected clock (docs/architecture.md, Player, Clock): device time plus the offset
 * the last sync measured, persisted so a reload with no network keeps it. Read `now()` wherever the
 * time matters (schedule, display hours, play counts, the frame clock), never `Date.now()`.
 */
import { Clock, type PersistedClock } from '@signforge/player-core';

declare const __SF_BUILD_TIME__: number;

const KEY = 'sf.clock';

function read(): PersistedClock | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PersistedClock | null;
    return v && Number.isFinite(v.offsetMs) && Number.isFinite(v.syncedAt) ? v : undefined;
  } catch {
    return undefined;
  }
}

export const clock = new Clock({ deviceNow: () => Date.now(), monoNow: () => performance.now(), buildTime: __SF_BUILD_TIME__, persisted: read() });

/** Corrected time, in ms since the epoch. */
export const now = (): number => clock.now();

/** A sync answered with `serverTime`; `sentAt` and `receivedAt` are `Date.now()` around it. */
export function synced(serverTime: string, sentAt: number, receivedAt: number): void {
  const saved = clock.synced(Date.parse(serverTime), sentAt, receivedAt);
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable: the offset holds until a reload.
  }
}
