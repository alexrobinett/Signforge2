import { describe, expect, it } from 'vitest';
import { Clock } from './clock';

const BUILD = Date.UTC(2026, 10, 1);
const T = Date.UTC(2026, 10, 17, 12);

/** A device clock and a monotonic clock the test moves by hand. */
function device(start: number) {
  const d = { wall: start, mono: 1000 };
  return {
    d,
    advance: (ms: number) => ((d.wall += ms), (d.mono += ms)),
    step: (ms: number) => (d.wall += ms),
    opts: { deviceNow: () => d.wall, monoNow: () => d.mono, buildTime: BUILD },
  };
}

describe('Clock', () => {
  it('reads device time plus the offset measured at the last sync, and persists it with the corrected time', () => {
    const t = device(T - 3_600_000); // an hour slow
    const c = new Clock(t.opts);
    expect(c.trusted).toBe(true); // after the build, nothing to say otherwise
    // Sent at device T-1h, answered 200 ms later, server said T+100.
    const saved = c.synced(T + 100, T - 3_600_000, T - 3_600_000 + 200);
    expect(c.offsetMs).toBe(3_600_000);
    expect(saved).toEqual({ offsetMs: 3_600_000, syncedAt: T + 200 });
    t.advance(200);
    expect(c.now()).toBe(T + 200);
  });

  it('folds a jump of the device clock into the offset, so corrected time stays continuous', () => {
    const t = device(T);
    const c = new Clock(t.opts);
    c.synced(T, T, T);
    t.advance(1000);
    t.step(3_600_000); // NTP steps the device clock forward an hour
    expect(c.now()).toBe(T + 1000);
    t.advance(500);
    expect(c.now()).toBe(T + 1500);
    // A drift under 2 s is left alone.
    t.step(1500);
    expect(c.now()).toBe(T + 3000);
  });

  it('does not trust a persisted offset that puts time before its last sync, or before the build', () => {
    const back = device(T - 86_400_000);
    expect(new Clock({ ...back.opts, persisted: { offsetMs: 0, syncedAt: T } }).trusted).toBe(false);
    const ok = device(T + 60_000);
    const c = new Clock({ ...ok.opts, persisted: { offsetMs: 5000, syncedAt: T } });
    expect(c.trusted).toBe(true);
    expect(c.now()).toBe(T + 65_000);
    const early = device(BUILD - 1);
    expect(new Clock(early.opts).trusted).toBe(false);
    // A good sync makes it trusted again.
    const e = new Clock(early.opts);
    e.synced(T, BUILD - 1, BUILD - 1);
    expect(e.trusted).toBe(true);
  });

  it('untrusted, says the real time is at least its last sync or its build, for the schedule (#200)', () => {
    const back = device(T - 86_400_000);
    const c = new Clock({ ...back.opts, persisted: { offsetMs: 0, syncedAt: T } });
    expect(c.trust()).toEqual({ clockTrusted: false, notBefore: T });
    expect(new Clock(device(BUILD - 1).opts).trust()).toEqual({ clockTrusted: false, notBefore: BUILD });
    c.synced(T + 1000, T - 86_400_000, T - 86_400_000);
    expect(c.trust()).toEqual({});
  });
});
