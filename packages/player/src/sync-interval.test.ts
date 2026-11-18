import { describe, expect, it } from 'vitest';
import { SOCKET_DOWN_SYNC_S, contentRetryMs, syncGapMs, syncWaitMs } from './sync-interval';

const mid = () => 0.5; // no jitter
const low = () => 0; // -10%
const high = () => 1; // +10%
const api = { api: true, ok: true, socketOpen: true, nextSyncS: 300, pollMs: 30_000, pollOverride: false };

describe('the sync interval', () => {
  it("is the server's 5 minutes with 10% jitter while the socket is up", () => {
    expect(syncWaitMs(api, mid)).toBe(300_000);
    expect(syncWaitMs(api, low)).toBe(270_000);
    expect(syncWaitMs(api, high)).toBe(330_000);
  });

  it('shortens to 2 minutes, jittered, while the socket is down, never the old 30 seconds', () => {
    expect(SOCKET_DOWN_SYNC_S).toBe(120);
    const down = { ...api, socketOpen: false };
    expect(syncWaitMs(down, mid)).toBe(120_000);
    expect(syncWaitMs(down, low)).toBe(108_000);
    expect(syncWaitMs(down, high)).toBe(132_000);
    // A server asking for less than that is obeyed.
    expect(syncWaitMs({ ...down, nextSyncS: 60 }, mid)).toBe(60_000);
  });

  it('retries a failed sync at the poll interval, jittered', () => {
    expect(syncWaitMs({ ...api, ok: false }, low)).toBe(27_000);
  });

  it('keeps an explicit ?poll= for the socket-down interval (testing)', () => {
    expect(syncWaitMs({ ...api, socketOpen: false, pollMs: 1000, pollOverride: true }, mid)).toBe(1000);
  });

  it('keeps static content on its plain poll', () => {
    expect(syncWaitMs({ ...api, api: false }, high)).toBe(30_000);
  });

  it('lets a socket ticket or a drop force a sync only once the shortest gap has passed', () => {
    expect(syncGapMs({ ...api, socketOpen: false })).toBe(108_000);
    expect(syncGapMs({ ...api, socketOpen: false, pollMs: 1000, pollOverride: true })).toBe(1000);
  });
});

describe('a content retry', () => {
  it("starts at the poll interval and doubles, jittered, up to the server's interval", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => contentRetryMs(n, api, mid))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(contentRetryMs(1, api, low)).toBe(27_000);
    expect(contentRetryMs(20, api, high)).toBe(330_000);
  });
});
