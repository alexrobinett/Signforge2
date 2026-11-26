/**
 * What a screen's last sync reported, kept on its row as `heartbeat_json`. Written by the API's
 * sync route; read by the screen tools for the CMS.
 */
import type { SyncRequest } from '@signforge/contract';

export interface ScreenHeartbeat {
  at: number;
  player: SyncRequest['player'];
  manifest: SyncRequest['manifest'];
  display: SyncRequest['display'];
  clock: SyncRequest['clock'];
  /** Server time minus the screen's own uncorrected clock when it sent the sync, in ms. */
  driftMs: number;
  dataRejected: Record<string, number>;
  /**
   * The feed photos the screen held (`SyncRequest.blobs`) and lacked, whether the reply asked it to fetch some, and
   * whether it was a retry with the count missing unchanged: the next sync comes soon only while that count moves,
   * with one retry (sync.ts, `MORE_PHOTOS_SYNC_S`); `after` is the photo the ask ended on, which the next reply's ask
   * starts after. Absent before the fast sync.
   */
  photos?: { held: number; missing: number; asked: boolean; retried: boolean; after?: string };
}

export function parseHeartbeat(json: string | null | undefined): ScreenHeartbeat | undefined {
  if (!json) return undefined;
  try {
    // Written by the API's sync route from a validated SyncRequest.
    const heartbeat: ScreenHeartbeat = JSON.parse(json);
    return heartbeat;
  } catch {
    return undefined;
  }
}
