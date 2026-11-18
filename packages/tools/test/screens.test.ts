// The screen tools the CMS's Screens pages use: state, what it should be showing, display overrides, identify and restart.
import type { DeviceCommand } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, manifestKey, registry, type Caller, type ScreenHeartbeat } from '../src';

let o: SeededOrg;
let owner: Caller;
const sent: { screenId: string; command: DeviceCommand }[] = [];

const call = async <T = any>(name: string, input: unknown, caller = owner): Promise<T> => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};

const MANIFEST = 'c'.repeat(64);
const IMAGE = 'd'.repeat(64);

beforeAll(async () => {
  o = await seedOrg(env.DB, 'screens-org');
  owner = {
    org: scoped(env.DB, o.orgId),
    role: 'owner',
    actor: { kind: 'user', id: 'user-1', clientId: 'cms' },
    blobs: env.BLOBS,
    screens: {
      manifest: async () => {},
      revoked: async () => {},
      command: async (screenId, command) => void sent.push({ screenId, command }),
    },
  };
  const org = scoped(env.DB, o.orgId);
  await env.BLOBS.put(
    manifestKey(o.orgId, o.screen, MANIFEST),
    JSON.stringify({
      schema: 2,
      id: MANIFEST,
      generatedAt: '2026-11-18T00:00:00Z',
      screen: { id: o.screen, name: 'Lobby', timezone: 'Europe/London', orientation: 'landscape' },
      files: { [IMAGE]: { size: 1, type: 'image/png' } },
      templates: {},
      spots: { s1: { id: 's1', name: 'Spring menu', durationMs: 8000, kind: 'image', file: IMAGE, fit: 'cover' } },
      playlists: { main: { id: 'main', name: 'Main', transition: 'cut', items: [{ spot: 's1' }] } },
      dataSources: {},
      schedule: [],
      defaultPlaylist: 'main',
    }),
  );
  await org.screens.setDesiredManifest(o.screen, MANIFEST);
  const hb: ScreenHeartbeat = {
    at: Date.now(),
    player: { version: '1.2.3', manifestSchemas: [2], protocols: [1, 2] },
    manifest: { active: MANIFEST, filesMissing: 0 },
    display: { on: true },
    clock: { offsetMs: 12, trusted: true },
    driftMs: 40,
    dataRejected: {},
  };
  await org.screens.update(o.screen, { reportedManifestId: MANIFEST, lastSeenAt: Date.now(), heartbeatJson: JSON.stringify(hb), playerVersion: '1.2.3' });
});

describe('list_screens and get_screen', () => {
  it('say what each screen is doing, as a fact, and what it should be showing', async () => {
    const { screens } = await call('list_screens', {});
    expect(screens[0]).toMatchObject({
      id: o.screen,
      state: { kind: 'online', reason: null },
      heartbeat: { playerVersion: '1.2.3', activeManifestId: MANIFEST, filesMissing: 0, fallbackFrom: null, displayOn: true, clockTrusted: true },
      showing: { asleep: false, playlist: { name: 'Main' }, spot: { name: 'Spring menu', kind: 'image', image: IMAGE }, spots: 1 },
      displayOverride: null,
    });
  });

  it('show nothing to play for a screen with nothing published', async () => {
    const fresh = await scoped(env.DB, o.orgId).screens.insert({ name: 'New', timezone: 'UTC', orientation: 'portrait' });
    const { screen } = await call('get_screen', { screenId: fresh.id });
    expect(screen).toMatchObject({ state: { kind: 'unreachable' }, heartbeat: null, showing: null });
  });

  it("list a screen's recent events, newest first", async () => {
    await call('rename_screen', { screenId: o.screen, name: 'Lobby' });
    await call('rename_screen', { screenId: o.screen, name: 'Front lobby' });
    const { events } = await call('get_screen', { screenId: o.screen });
    expect(events.slice(0, 2)).toEqual([
      { at: expect.any(Number), action: 'rename_screen', actor: { kind: 'user', id: 'user-1' } },
      { at: expect.any(Number), action: 'rename_screen', actor: { kind: 'user', id: 'user-1' } },
    ]);
  });
});

describe('set_display_override', () => {
  it('wakes a screen until its next scheduled change, persists it and sends it', async () => {
    // Weekdays 07:00 to 19:00 in London.
    await call('update_screen_settings', { screenId: o.screen, displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }] } });
    sent.length = 0;
    const { screen } = await call('set_display_override', { screenId: o.screen, state: 'on' });
    expect(screen.displayOverride.state).toBe('on');
    const until = Date.parse(screen.displayOverride.until);
    expect(until).toBeGreaterThan(Date.now());
    expect(until - Date.now()).toBeLessThanOrEqual(3 * 86_400_000); // never past the weekend
    expect(new Date(until).getUTCMinutes()).toBe(0);
    expect(sent).toEqual([{ screenId: o.screen, command: { type: 'display', override: screen.displayOverride } }]);
    expect((await call('get_screen', { screenId: o.screen })).screen.displayOverride).toEqual(screen.displayOverride);
  });

  it('lasts a fixed time on a screen with no display hours, and clears back to the schedule', async () => {
    await call('update_screen_settings', { screenId: o.screen, displayHours: null });
    const { screen } = await call('set_display_override', { screenId: o.screen, state: 'off' });
    expect(Date.parse(screen.displayOverride.until) - Date.now()).toBeGreaterThan(11.9 * 3_600_000);
    sent.length = 0;
    const cleared = await call('set_display_override', { screenId: o.screen, state: null });
    expect(cleared.screen.displayOverride).toBeNull();
    expect(sent).toEqual([{ screenId: o.screen, command: { type: 'display', override: null } }]);
  });

  it('is refused to a viewer', async () => {
    const r = await dispatch(registry, 'set_display_override', { screenId: o.screen, state: 'on' }, { ...owner, role: 'viewer' });
    expect(r).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

describe('identify_screen and restart_screen', () => {
  it('send the command and record it, though nothing in the database changes', async () => {
    sent.length = 0;
    expect(await call('identify_screen', { screenId: o.screen })).toEqual({ screenId: o.screen, seconds: 10 });
    expect(await call('restart_screen', { screenId: o.screen })).toEqual({ screenId: o.screen });
    expect(sent).toEqual([
      { screenId: o.screen, command: { type: 'identify', name: 'Front lobby', seconds: 10 } },
      { screenId: o.screen, command: { type: 'restart' } },
    ]);
    const { events } = await call('get_screen', { screenId: o.screen });
    expect(events.slice(0, 2).map((e: { action: string }) => e.action)).toEqual(['restart_screen', 'identify_screen']);
  });
});
