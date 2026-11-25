// The screen tools the CMS's Screens pages use: state, what it should be showing, display overrides, identify and restart.
import type { DeviceCommand } from '@signforge/contract';
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch, manifestKey, registry, type Caller, type ScreenHeartbeat } from '../src';
import { memberOf } from './member';

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
// The file's clock: Date alone is faked, as D1 needs real timers. Later than every instant the override cases set,
// so their events are older than the rest.
const NOW = '2026-11-23T12:00:00Z';

beforeAll(async () => {
  vi.setSystemTime(NOW);
  o = await seedOrg(env.DB, 'screens-org');
  owner = memberOf(testScope(env.DB, o.orgId), 'owner', {
    notify: {
      manifest: async () => {},
      manifests: async () => {},
      revoked: async () => {},
      command: async (screenId, command) => void sent.push({ screenId, command }),
    },
  });
  const org = testScope(env.DB, o.orgId);
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

afterAll(() => vi.useRealTimers());

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
    const fresh = await testScope(env.DB, o.orgId).screens.insert({ name: 'New', timezone: 'UTC', orientation: 'portrait' });
    const { screen } = await call('get_screen', { screenId: fresh.id });
    expect(screen).toMatchObject({ state: { kind: 'unreachable' }, heartbeat: null, showing: null });
  });

  it("list a screen's recent events, newest first", async () => {
    await call('rename_screen', { screenId: o.screen, name: 'Lobby' });
    await call('rename_screen', { screenId: o.screen, name: 'Front lobby' });
    const { events } = await call('get_screen', { screenId: o.screen });
    expect(
      events
        .slice(0, 2)
        .map((e: { input: { name: string } }) => e.input.name)
        .sort(),
    ).toEqual(['Front lobby', 'Lobby']);
    expect(events[0]).toEqual({
      at: expect.any(Number),
      action: 'rename_screen',
      actor: { kind: 'user', id: 'user-1' },
      input: { screenId: o.screen, name: expect.any(String) },
    });
  });
});

describe('set_display_override', () => {
  afterEach(() => vi.setSystemTime(NOW));

  // Weekdays 07:00 to 19:00 in London. A wake lasts until the next change, and at most 12 hours.
  it.each([
    ['a weekday morning, until the close', '2026-11-18T10:30:00Z', '2026-11-18T19:00:00.000Z'],
    ['before 07:00, until the open', '2026-11-18T03:15:00Z', '2026-11-18T07:00:00.000Z'],
    ['at the close, until the open 12 hours on', '2026-11-19T19:00:00Z', '2026-11-20T07:00:00.000Z'],
    ['a Friday evening, for 12 hours: Monday is further', '2026-11-20T19:52:00Z', '2026-11-21T07:52:00.000Z'],
    ['a Saturday, for 12 hours', '2026-11-21T12:00:00Z', '2026-11-22T00:00:00.000Z'],
    ['a Sunday evening, until Monday 07:00', '2026-11-22T21:00:00Z', '2026-11-23T07:00:00.000Z'],
    ['the Sunday clocks go forward, until Monday 07:00 BST', '2026-03-29T20:00:00Z', '2026-03-30T06:00:00.000Z'],
    ['the Sunday clocks go forward, for 12 hours: 07:00 BST is 12.5 hours away', '2026-03-29T17:30:00Z', '2026-03-30T05:30:00.000Z'],
    ['the Friday before clocks go back, until 19:00 BST', '2026-10-23T09:00:00Z', '2026-10-23T18:00:00.000Z'],
    ['the Sunday clocks go back, until Monday 07:00 GMT', '2026-10-25T20:00:00Z', '2026-10-26T07:00:00.000Z'],
  ])('wakes a screen on %s, persists it and sends it', async (_, now, until) => {
    vi.setSystemTime(now);
    await call('update_screen_settings', { screenId: o.screen, displayHours: { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }] } });
    sent.length = 0;
    const { screen } = await call('set_display_override', { screenId: o.screen, state: 'on' });
    expect(screen.displayOverride).toEqual({ state: 'on', until });
    expect(sent).toEqual([{ screenId: o.screen, command: { type: 'display', override: screen.displayOverride } }]);
    expect((await call('get_screen', { screenId: o.screen })).screen.displayOverride).toEqual(screen.displayOverride);
  });

  it('lasts a fixed time on a screen with no display hours, and clears back to the schedule', async () => {
    vi.setSystemTime('2026-11-20T19:52:00Z');
    await call('update_screen_settings', { screenId: o.screen, displayHours: null });
    const { screen } = await call('set_display_override', { screenId: o.screen, state: 'off' });
    expect(screen.displayOverride).toEqual({ state: 'off', until: '2026-11-21T07:52:00.000Z' });
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
    // Both within a millisecond or two: their order may tie.
    expect(
      events
        .slice(0, 2)
        .map((e: { action: string }) => e.action)
        .sort(),
    ).toEqual(['identify_screen', 'restart_screen']);
  });
});

describe('a revoked screen', () => {
  it('needs you once every credential it had is revoked, though one never paired does not', async () => {
    const org = testScope(env.DB, o.orgId);
    const waiting = await org.screens.insert({ name: 'Waiting', timezone: 'UTC', orientation: 'landscape' });
    expect((await call('get_screen', { screenId: waiting.id })).screen.state).toMatchObject({ kind: 'unreachable', reason: null });

    await call('revoke_screen_credential', { screenId: o.screen, credentialId: o.credential });
    expect((await call('get_screen', { screenId: o.screen })).screen.state).toMatchObject({ kind: 'needs_you', reason: 'revoked' });
    const listed = (await call('list_screens', {})).screens.find((s: { id: string }) => s.id === o.screen);
    expect(listed.state).toMatchObject({ kind: 'needs_you', reason: 'revoked' });
  });

  it('gets no identify or restart: refused, and nothing sent (#180)', async () => {
    // Revoked here too, so the case stands alone: revoking a revoked credential changes nothing.
    await call('revoke_screen_credential', { screenId: o.screen, credentialId: o.credential });
    sent.length = 0;
    for (const name of ['identify_screen', 'restart_screen']) {
      const r = await dispatch(registry, name, { screenId: o.screen }, owner);
      expect(r).toMatchObject({ ok: false, error: 'conflict', message: expect.stringContaining('revoked') });
    }
    expect(sent).toEqual([]);
  });
});

describe('get_screen: the publish a screen fell back from (#367, review of #458)', () => {
  it('names the latest publish that gave the screen the manifest it fell back from, and none when nothing did', async () => {
    const org = testScope(env.DB, o.orgId);
    const FAILED = 'e'.repeat(64);
    const before = (await org.screens.get(o.screen))!;
    const hb: ScreenHeartbeat = {
      at: Date.now(),
      player: { version: '1.2.3', manifestSchemas: [2], protocols: [1, 2] },
      manifest: { active: MANIFEST, filesMissing: 0, fallbackFrom: FAILED },
      display: { on: true },
      clock: { offsetMs: 12, trusted: true },
      driftMs: 40,
      dataRejected: {},
    };
    await org.screens.update(o.screen, { heartbeatJson: JSON.stringify(hb) });
    expect((await call('get_screen', { screenId: o.screen })).fallbackPublish).toBeNull();
    const made = org.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'u', revision: 7 });
    await org.commit([...made.writes, ...org.publishes.stage.addScreens(made.row.id, [{ screenId: o.screen, manifestId: FAILED }]).writes]);
    expect((await call('get_screen', { screenId: o.screen })).fallbackPublish).toEqual({ id: made.row.id, revision: 7 });
    await org.screens.update(o.screen, { heartbeatJson: before.heartbeatJson });
  });
});
