// What the CMS says about a screen: its state as a fact, and what it should be showing now.
import type { ScreenManifest } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { screenState, shouldBeShowing, UNREACHABLE_AFTER_MS, type ScreenHeartbeat, type StateInput } from '../src';

const NOW = Date.parse('2026-11-18T15:00:00Z'); // Wed 10:00 in New York
const M1 = '1'.repeat(64);
const M2 = '2'.repeat(64);

const heartbeat = (over: Partial<ScreenHeartbeat> = {}): ScreenHeartbeat => ({
  at: NOW - 30_000,
  player: { version: '1.0.0', manifestSchemas: [2], protocols: [1, 2] },
  manifest: { active: M1, filesMissing: 0 },
  display: { on: true },
  clock: { offsetMs: 0, trusted: true },
  driftMs: 0,
  dataRejected: {},
  ...over,
});

const input = (over: Partial<StateInput> = {}): StateInput => ({
  status: 'active',
  timezone: 'America/New_York',
  displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }] },
  desiredManifestId: M1,
  reportedManifestId: M1,
  lastSeenAt: NOW - 30_000,
  heartbeat: heartbeat(),
  unreachableAfterMs: UNREACHABLE_AFTER_MS,
  ...over,
});

const state = (over: Partial<StateInput> = {}) => screenState(input(over), NOW);

describe('screenState', () => {
  it('is online when heard from lately, on the desired manifest, with the panel on', () => {
    expect(state()).toEqual({ kind: 'online', reason: null, wakesAt: null, filesMissing: null });
  });

  it('is updating while it is not yet on the desired manifest, with the files still to fetch', () => {
    expect(state({ desiredManifestId: M2, heartbeat: heartbeat({ manifest: { active: M1, filesMissing: 12 } }) })).toMatchObject({
      kind: 'updating',
      filesMissing: 12,
    });
  });

  it('is asleep on purpose with the panel off, and says when it wakes', () => {
    // Wed 20:00 local: wakes Thu 07:00 local.
    const at = Date.parse('2026-11-19T01:00:00Z');
    expect(screenState(input({ lastSeenAt: at - 1000, heartbeat: heartbeat({ display: { on: false } }) }), at)).toEqual({
      kind: 'asleep',
      reason: null,
      wakesAt: '2026-11-19T12:00:00.000Z',
      filesMissing: null,
    });
  });

  it('asleep by a "sleep now" override wakes when the override ends', () => {
    const until = '2026-11-18T17:00:00.000Z';
    expect(state({ heartbeat: heartbeat({ display: { on: false, override: { state: 'off', until } } }) })).toMatchObject({ kind: 'asleep', wakesAt: until });
  });

  it('is calmly unreachable when silent but on the latest version: it is still playing it', () => {
    expect(state({ lastSeenAt: NOW - UNREACHABLE_AFTER_MS - 1 })).toMatchObject({ kind: 'unreachable', reason: null });
    expect(state({ lastSeenAt: null, heartbeat: undefined })).toMatchObject({ kind: 'unreachable', reason: null });
  });

  it('needs you when unreachable and behind the latest publish', () => {
    expect(state({ lastSeenAt: NOW - 2 * 3_600_000, desiredManifestId: M2 })).toMatchObject({ kind: 'needs_you', reason: 'behind' });
  });

  it('needs you when revoked, when nothing is published to it, or when it fell back from a manifest that played nothing', () => {
    expect(state({ status: 'revoked' })).toMatchObject({ kind: 'needs_you', reason: 'revoked' });
    expect(state({ desiredManifestId: null, reportedManifestId: null })).toMatchObject({ kind: 'needs_you', reason: 'nothing_published' });
    expect(state({ heartbeat: heartbeat({ manifest: { active: M1, filesMissing: 0, fallbackFrom: M2 } }) })).toMatchObject({
      kind: 'needs_you',
      reason: 'fallback',
    });
  });
});

const manifest = (over: Partial<ScreenManifest> = {}): ScreenManifest =>
  ({
    schema: 2,
    id: M1,
    generatedAt: '2026-11-18T00:00:00Z',
    screen: { id: 'scr_1', name: 'Lobby', timezone: 'America/New_York', orientation: 'landscape' },
    files: { ['a'.repeat(64)]: { size: 10, type: 'image/jpeg' }, ['b'.repeat(64)]: { size: 10, type: 'text/html' } },
    templates: {},
    spots: {
      promo: {
        id: 'promo',
        name: 'Energy 3 for $7',
        durationMs: 10_000,
        kind: 'template',
        template: 'cstore-promo',
        data: {},
        assets: { photo: 'a'.repeat(64) },
      },
      clock: { id: 'clock', name: 'Clock', durationMs: 10_000, kind: 'template', template: 'clock', data: {}, assets: {} },
      menu: { id: 'menu', name: 'Breakfast', durationMs: 10_000, kind: 'image', file: 'a'.repeat(64), fit: 'cover' },
    },
    playlists: {
      main: { id: 'main', name: 'Main loop', transition: 'cut', items: [{ spot: 'promo' }, { spot: 'clock' }] },
      morning: { id: 'morning', name: 'Breakfast', transition: 'cut', items: [{ spot: 'menu' }] },
    },
    dataSources: {},
    schedule: [{ id: 'e1', playlist: 'morning', priority: 1, target: 'screen', from: '06:00', to: '09:00' }],
    defaultPlaylist: 'main',
    ...over,
  }) as ScreenManifest;

describe('shouldBeShowing', () => {
  it("names the scheduled playlist's first spot, with its template and an image to show", () => {
    expect(shouldBeShowing(manifest(), NOW)).toEqual({
      asleep: false,
      wakesAt: null,
      playlist: { id: 'main', name: 'Main loop' },
      takeover: false,
      spot: { id: 'promo', name: 'Energy 3 for $7', kind: 'template', template: 'cstore-promo', image: 'a'.repeat(64) },
      spots: 2,
    });
  });

  it('follows the schedule', () => {
    // 07:30 local.
    expect(shouldBeShowing(manifest(), Date.parse('2026-11-18T12:30:00Z'))).toMatchObject({
      playlist: { id: 'morning' },
      spot: { id: 'menu', kind: 'image', template: null, image: 'a'.repeat(64) },
    });
  });

  it('is asleep outside the display hours the screen was published with', () => {
    const m = manifest({ screen: { ...manifest().screen, displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '11:00', to: '19:00' }] } } });
    expect(shouldBeShowing(m, NOW)).toEqual({ asleep: true, wakesAt: '2026-11-18T16:00:00.000Z', playlist: null, takeover: false, spot: null, spots: 0 });
    // Woken by an override.
    expect(shouldBeShowing(m, NOW, { state: 'on', until: '2026-11-18T16:00:00.000Z' })).toMatchObject({ asleep: false, spot: { id: 'promo' } });
  });
});
