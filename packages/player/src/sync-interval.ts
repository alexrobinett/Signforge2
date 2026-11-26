/**
 * How long the sync loop waits between passes (`syncLoop` in main.ts).
 *
 * From the API every pass is a `POST /v1/device/sync`, one D1 row written (docs/backend-plan.md,
 * Screens: Sync). The server's interval (`nextSyncS`, 5 minutes, or 15 s while feed photos the screen lacks wait and
 * those it was last asked for arrive or more go missing, with one retry) with 10% jitter holds while the socket is up.
 * The budgets here count 5 minutes: the server ends the 15 s syncs once photos stop coming in, so a screen that cannot
 * store them syncs 288 times a day, plus one 15 s sync for each sync that finds more of its photos missing (about 550
 * a day at most, with its feeds turning over every interval). While it is down the socket cannot nudge, so the sync comes sooner, but only to
 * `SOCKET_DOWN_SYNC_S`: with every screen's socket down at once (a Durable Object outage), 1,000
 * screens at 2 minutes write 21.6M heartbeat rows a month, plus the 21.6M of play counts, about
 * 43M against the 50M included. A minute would be 65M. A failed sync retries at the poll interval:
 * it wrote nothing. Static content has no sync: it polls the manifest at the poll interval.
 *
 * A sync the server answered counts as good even when fetching the manifest or its files then
 * fails (a missing blob, a rejected manifest): the heartbeat was written. Were it retried at the
 * poll interval, 1,000 such screens would write 86M heartbeat rows a month. The fetch retries on
 * its own instead (`contentRetryMs`), and a fetch writes no D1 row.
 */
export const SOCKET_DOWN_SYNC_S = 120;

export interface SyncTiming {
  /** Content from the API. */
  api: boolean;
  /** The last sync succeeded. */
  ok: boolean;
  socketOpen: boolean;
  /** The server's interval, from the last sync. */
  nextSyncS: number;
  /** `?poll=` (default 30 s). */
  pollMs: number;
  /** `?poll=` was given: it then sets the socket-down interval too (tests). */
  pollOverride: boolean;
}

const JITTER = 0.1;

/** The wait before the next pass, in ms. `random` is Math.random. */
export function syncWaitMs(t: SyncTiming, random: () => number = Math.random): number {
  if (!t.api || (t.ok && !t.socketOpen && t.pollOverride)) return t.pollMs;
  const base = !t.ok ? t.pollMs : t.socketOpen ? t.nextSyncS * 1000 : Math.min(t.nextSyncS, SOCKET_DOWN_SYNC_S) * 1000;
  return base * (1 - JITTER + random() * 2 * JITTER);
}

/**
 * The shortest time between syncs that a socket ticket request or a socket drop may force: the
 * low end of the socket-down interval. A socket reconnecting with backoff would otherwise sync on
 * every attempt; instead it waits for the next sync's ticket.
 */
export function syncGapMs(t: SyncTiming): number {
  return syncWaitMs({ ...t, ok: true, socketOpen: false }, () => 0);
}

/**
 * The wait before fetching content again after `failures` fetches in a row failed, in ms: the
 * poll interval, doubling, up to the server's sync interval, with 10% jitter.
 */
export function contentRetryMs(failures: number, t: Pick<SyncTiming, 'pollMs' | 'nextSyncS'>, random: () => number = Math.random): number {
  const base = Math.min(t.pollMs * 2 ** (failures - 1), t.nextSyncS * 1000);
  return base * (1 - JITTER + random() * 2 * JITTER);
}
