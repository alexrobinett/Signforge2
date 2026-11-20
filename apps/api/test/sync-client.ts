// A screen's side of the sync (M3-07), for the tests that need one: a request with nothing to report, and the call.
import { MANIFEST_SCHEMA, type SyncRequest, type SyncResponse } from '@signforge/contract';
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';

/** A sync request from a current player that has played nothing and holds no snapshot, with `over` on top. */
export const syncBody = (over: Partial<SyncRequest> = {}): SyncRequest => ({
  seq: 0,
  epoch: 'ep1',
  player: { version: '2.0.0', manifestSchemas: [MANIFEST_SCHEMA - 1, MANIFEST_SCHEMA], protocols: [1, 2] },
  manifest: { filesMissing: 0 },
  display: { on: true },
  deviceTime: new Date().toISOString(),
  clock: { offsetMs: 0, trusted: true },
  playCounts: [],
  snapshots: {},
  ...over,
});

/** `POST /v1/device/sync` with the screen's credential, expecting it to be answered. */
export async function syncAs(credential: string, req: SyncRequest): Promise<SyncResponse> {
  const res = await exports.default.fetch('https://api.test/v1/device/sync', {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SyncResponse;
}
