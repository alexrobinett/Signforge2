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
}

export function parseHeartbeat(json: string | null | undefined): ScreenHeartbeat | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as ScreenHeartbeat;
  } catch {
    return undefined;
  }
}
