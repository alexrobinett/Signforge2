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
   * The feed photos the screen held (`SyncRequest.blobs`) and lacked, the end of each hash the reply asked it to
   * fetch (`ask`, the next reply's starting after its last), and whether its one retry is spent: the next sync comes
   * soon only while asked photos arrive or a reply's snapshots bring more than it asks for, with one retry (sync.ts,
   * `MORE_PHOTOS_SYNC_S`). `sent` fingerprints the snapshots the reply sent, so the same ones sent again bring no new
   * photos first. Absent before the fast sync.
   */
  photos?: { held: number; missing: number; retried: boolean; ask: string[]; sent?: string };
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
