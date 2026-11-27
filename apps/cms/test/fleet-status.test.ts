import { describe, expect, it } from 'vitest';
import { describeScreen } from '../src/lib/screen-status';
import { listOutOfDate, withStatus } from '../src/lib/fleet-status';
import type { ScreenStatus, ScreenView } from '../src/lib/screen-types';

const AT = Date.parse('2026-11-18T12:00:00Z');
const STATE = { reason: null, wakesAt: null, filesMissing: null };

/** A screen as the list loaded it: asleep for its display hours, its thumbnail saying so. */
const asleep: ScreenView = {
  id: 'scr_1',
  name: 'Window',
  timezone: 'UTC',
  locale: null,
  orientation: 'landscape',
  kind: 'device',
  displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '12:00', to: '20:00' }] },
  labels: {},
  systemLabels: { orientation: 'landscape', kind: 'device', timezone: 'UTC' },
  status: 'active',
  desiredManifestId: 'm1',
  previousManifestId: null,
  reportedManifestId: 'm1',
  lastSeenAt: AT - 60_000,
  playerVersion: '1.0.0',
  playerChannel: 'stable',
  displayOverride: null,
  state: { ...STATE, kind: 'asleep', wakesAt: '2026-11-18T12:00:00.000Z' },
  heartbeat: null,
  showing: { asleep: true, wakesAt: '2026-11-18T12:00:00.000Z', playlist: null, takeover: false, spot: null, spots: 0 },
  version: 1,
  createdAt: AT - 86_400_000,
  updatedAt: AT - 86_400_000,
};

const status = (over: Partial<ScreenStatus> = {}): ScreenStatus => ({
  id: 'scr_1',
  state: { ...STATE, kind: 'asleep', wakesAt: '2026-11-18T12:00:00.000Z' },
  lastSeenAt: AT - 60_000,
  desiredManifestId: 'm1',
  reportedManifestId: 'm1',
  ...over,
});

const woke = status({ state: { ...STATE, kind: 'online' }, lastSeenAt: AT + 30_000 });

describe('withStatus', () => {
  it("lays a newer poll's state over the list", () => {
    const [s] = withStatus([asleep], AT, { screens: [woke], at: AT + 30_000 });
    expect(s).toMatchObject({ name: 'Window', state: { kind: 'online' }, lastSeenAt: AT + 30_000 });
  });

  it('keeps the list when the poll is older than it, as after an action reread it', () => {
    expect(withStatus([asleep], AT, { screens: [woke], at: AT - 1 })).toEqual([asleep]);
    expect(withStatus([asleep], AT, undefined)).toEqual([asleep]);
  });
});

describe('listOutOfDate', () => {
  it('is not, while only the last-seen times move on', () => {
    expect(listOutOfDate([asleep], [status({ lastSeenAt: AT + 300_000 })])).toBe(false);
  });

  it('is, for a screen paired or removed since, or a publish to one', () => {
    expect(listOutOfDate([asleep], [status(), status({ id: 'scr_2' })])).toBe(true);
    expect(listOutOfDate([asleep], [])).toBe(true);
    expect(listOutOfDate([asleep], [status({ desiredManifestId: 'm2' })])).toBe(true);
  });

  it('is, when a screen wakes or sleeps, so its tile never says Online over an Asleep thumbnail', () => {
    // Laid over the list alone, the tile contradicts itself until the list is read again.
    const [tile] = withStatus([asleep], AT, { screens: [woke], at: AT + 30_000 });
    expect(describeScreen(tile!, AT + 30_000).word).toBe('Online');
    expect(tile!.showing?.asleep).toBe(true);
    expect(listOutOfDate([asleep], [woke])).toBe(true);
  });
});
