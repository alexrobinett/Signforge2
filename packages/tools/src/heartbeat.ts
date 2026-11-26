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
   * The feed photos the screen held (`SyncRequest.blobs`), and whether the reply asked it to fetch more: the next sync
   * comes soon only while those asks bring photos in (sync.ts, `MORE_PHOTOS_SYNC_S`); `after` is the source the asked
   * photos ended on, which the next reply's turn starts after. Absent before the fast sync.
   */
  photos?: { held: number; asked: boolean; after?: string };
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
