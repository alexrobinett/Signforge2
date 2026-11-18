// The sync loop against the device API (M3-07): one periodic sync carries the heartbeat and play
// counts, corrects the clock from server time, delivers snapshots, and hands the socket its ticket.
import { describe, expect, it } from 'vitest';
import type { Content, ContentOptions } from './content';
import type { FixtureServer } from './fixture-server';
import { useHarness, type Player, type PlayerState } from './harness';

const h = useHarness();
const HOUR = 3_600_000;
/** Content on another origin is the API: the player syncs and opens its socket. */
const api = (s: FixtureServer) => ({ content: `${s.localUrl}/content` });
const hh = (ms: number) => new Date(ms).toISOString().slice(11, 13);

/** Plays and ms per `hour spot` from the player's own log, for hours before `before`. */
function logged(s: PlayerState, before: number, durationMs: number) {
  const out: Record<string, { plays: number; ms: number }> = {};
  for (const l of s.log) {
    const at = Date.parse(l.startedAt);
    if (at >= before) continue;
    const key = `${new Date(Math.floor(at / HOUR) * HOUR).toISOString().slice(0, 13)}:00Z ${l.spot}`;
    const t = (out[key] ??= { plays: 0, ms: 0 });
    t.plays++;
    t.ms += durationMs;
  }
  return out;
}

/**
 * A screen whose display hours are closed all week, playing `content` from the API, once its panel
 * is off; `switches` lists the power requests the supervisor got. With nothing cached at boot, the
 * hours are first read at the display loop's next check, 15 s on.
 */
async function asleep(content: Content) {
  const p = await h.openPlayer((s) => s.publish(content), api);
  await p.until((s) => s.clock.trusted && !s.displayOn, 20_000);
  const switches = () => p.server.requestsTo(/^\/supervisor\/display\//).map((r) => r.path);
  await expect.poll(switches, { timeout: 5000 }).toEqual(['/supervisor/display/off']);
  return { p, switches };
}
const closedAllWeek: ContentOptions['edit'] = (m) => void (m.screen.displayHours = { weekly: [] });

/**
 * Cut the network and boot again as a Pi with no clock does: the device clock a day behind the last
 * sync, with a "sleep" override saved ending at `sleepUntil` if given. Returns what restores the network.
 */
async function coldBootWithoutClock(p: Player, sleepUntil?: number): Promise<() => void> {
  const cut = p.server.intercept(/^\/content\//, { status: 503 });
  await p.page.evaluate(
    ({ syncedAt, until }) => {
      localStorage.setItem('sf.clock', JSON.stringify({ offsetMs: -86_400_000, syncedAt }));
      if (until) localStorage.setItem('sf.displayOverride', JSON.stringify({ state: 'off', until }));
    },
    { syncedAt: Date.now(), until: sleepUntil === undefined ? '' : new Date(sleepUntil).toISOString() },
  );
  await p.page.reload();
  return cut;
}

describe('play counts', () => {
  it('reach the server once an hour ends, counted once although a reply was lost', async () => {
    // Server time a few seconds before the hour: the hour ends during the test.
    const boundary = Math.ceil((Date.now() + 2 * HOUR) / HOUR) * HOUR;
    const content = h.content([
      { id: 'a', durationMs: 500 },
      { id: 'b', durationMs: 500 },
    ]);
    const p = await h.openPlayer((s) => {
      s.serverOffsetMs = boundary - 4000 - Date.now();
      s.nextSyncS = 1;
      s.loseCountReplies = 1;
      s.publish(content);
    }, api);
    const ended = `${new Date(boundary - HOUR).toISOString().slice(0, 13)}:00Z`;
    await expect.poll(() => Object.keys(p.server.storedCounts()).some((k) => k.startsWith(ended)), { timeout: 20_000 }).toBe(true);
    const s = await p.state();
    expect(p.server.storedCounts()).toEqual(logged(s, boundary, 500));
    // The batch whose reply was lost went again with the same seq and counts.
    const sent = p.server.syncs.filter((x) => x.playCounts.length);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[1]).toMatchObject({ seq: sent[0]!.seq, epoch: sent[0]!.epoch, playCounts: sent[0]!.playCounts });
  });
});

describe('the clock', () => {
  it('follows server time after one sync: schedule, display hours, play log', async () => {
    const offset = 6 * HOUR;
    const server = Date.now() + offset;
    const window = { from: `${hh(server)}:00`, to: `${hh(server + 2 * HOUR)}:00` };
    const content = h.content([{ id: 'a' }, { id: 'b' }], {
      edit: (m) => {
        m.playlists.main!.items = [{ spot: 'a' }];
        m.playlists.late = { id: 'late', name: 'Late', transition: { type: 'cut' }, items: [{ spot: 'b' }] };
        m.schedule = [{ id: 'late', playlist: 'late', priority: 1, target: 'screen', ...window }];
        // Off by the device clock, on by the server's.
        m.screen.displayHours = { weekly: [{ ...window, days: [0, 1, 2, 3, 4, 5, 6] }] };
      },
    });
    const p = await h.openPlayer((s) => {
      s.serverOffsetMs = offset;
      s.publish(content);
    }, api);
    const s = await p.until((s) => s.log.length >= 2);
    expect(s.displayOn).toBe(true);
    expect(new Set(s.log.map((l) => l.spot))).toEqual(new Set(['b']));
    expect(Math.abs(Date.parse(s.log.at(-1)!.startedAt) - (Date.now() + offset))).toBeLessThan(60_000);
    expect(Math.abs(s.clock.offsetMs - offset)).toBeLessThan(5000);
    expect(s.clock.trusted).toBe(true);

    // The offset is kept across a reload, before any sync answers.
    p.server.intercept(/^\/content\/sync$/, { status: 503 });
    await p.page.reload();
    const again = await p.until((s) => s.log.length >= 1);
    expect(Math.abs(again.clock.offsetMs - offset)).toBeLessThan(5000);
    expect(again.log[0]!.spot).toBe('b');
  });

  it('keeps the panel on while it is untrusted, whatever the hours and a saved override say, and applies them once a sync trusts it', async () => {
    const { p, switches } = await asleep(h.content([{ id: 'a', durationMs: 500 }], { edit: closedAllWeek }));

    // A "sleep" override saved that ended an hour ago, though by the clock a day behind it has a day to run.
    const cut = await coldBootWithoutClock(p, Date.now() - HOUR);
    await expect.poll(switches, { timeout: 10_000 }).toHaveLength(2);
    expect(switches()[1]).toBe('/supervisor/display/on');
    const s = await p.until((s) => s.played >= 2);
    expect(s.clock.trusted).toBe(false);
    expect(s.displayOn).toBe(true);
    expect(switches()).toHaveLength(2);

    // The network back: the first sync trusts the clock, the expired override is dropped, and the closed hours apply.
    cut();
    await p.until((s) => s.clock.trusted && !s.displayOn);
    await expect.poll(switches, { timeout: 10_000 }).toEqual(['/supervisor/display/off', '/supervisor/display/on', '/supervisor/display/off']);
    expect(await p.page.evaluate(() => localStorage.getItem('sf.displayOverride'))).toBeNull();
  });
});

describe('an untrusted clock', () => {
  it('asks for the panel on with nothing cached to play', async () => {
    const p = await h.openPlayer((s) => s.intercept(/^\/content\//, { status: 503 }), api);
    await p.until((s) => !s.online);
    await p.page.evaluate((syncedAt) => localStorage.setItem('sf.clock', JSON.stringify({ offsetMs: 0, syncedAt })), Date.now() + 86_400_000);
    await p.page.reload();
    const s = await p.until((s) => !s.clock.trusted && !s.online);
    expect(s.manifestId).toBe('');
    await expect
      .poll(() => p.server.requestsTo(/^\/supervisor\/display\//).map((r) => `${r.path} ${r.status}`), { timeout: 5000 })
      .toEqual(['/supervisor/display/on 200']);
  });

  it('leaves a saved override alone while syncs fail', async () => {
    const content = h.content([{ id: 'a', durationMs: 500 }]);
    const p = await h.openPlayer((s) => s.publish(content), api);
    await p.until((s) => s.clock.trusted && s.played > 0);

    // The last sync was a day ahead of this clock, and the override ended an hour before it reads.
    p.server.intercept(/^\/content\//, { status: 503 });
    const saved = JSON.stringify({ state: 'off', until: new Date(Date.now() - HOUR).toISOString() });
    await p.page.evaluate(
      ({ syncedAt, saved }) => {
        localStorage.setItem('sf.clock', JSON.stringify({ offsetMs: 0, syncedAt }));
        localStorage.setItem('sf.displayOverride', saved);
      },
      { syncedAt: Date.now() + 86_400_000, saved },
    );
    await p.page.reload();
    const refused = () => p.server.requestsTo(/^\/content\/sync$/).filter((r) => r.bearer && r.status === 503).length;
    const before = refused();
    await expect.poll(refused, { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 3);
    expect((await p.state()).clock.trusted).toBe(false);
    expect(await p.page.evaluate(() => localStorage.getItem('sf.displayOverride'))).toBe(saved);
  });
});

describe('the first trusted sync', () => {
  it('clears a saved override the CMS cleared while the screen was offline, before the display looks', async () => {
    const p = await h.openPlayer((s) => s.publish(h.content([{ id: 'a', durationMs: 500 }])), api);
    await p.until((s) => s.clock.trusted && s.played > 0);

    // A "sleep" saved with an hour to run, which the CMS cleared while the screen was offline.
    p.server.displayOverride = null;
    const reloaded = Date.now();
    const cut = await coldBootWithoutClock(p, Date.now() + HOUR);
    const switches = () =>
      p.server
        .requestsTo(/^\/supervisor\/display\//)
        .filter((r) => r.at >= reloaded)
        .map((r) => r.path);
    await expect.poll(switches, { timeout: 10_000 }).toEqual(['/supervisor/display/on']);
    // Past the 3 s a panel is given to wake: the display loop waits for its next check.
    await new Promise((r) => setTimeout(r, 4000));

    cut();
    await p.until((s) => s.clock.trusted);
    await expect.poll(() => p.page.evaluate(() => localStorage.getItem('sf.displayOverride')), { timeout: 5000 }).toBeNull();
    // Longer than an off switch takes (1.5 s).
    await new Promise((r) => setTimeout(r, 4000));
    expect(switches()).toEqual(['/supervisor/display/on']);
  });

  it('applies the wake override it carries before the hours, so a panel kept on is never switched off', async () => {
    const content = h.content([{ id: 'a', durationMs: 500, label: 'Fallback', bindings: { label: { source: 'news', path: 'headline' } } }], {
      edit: closedAllWeek,
    });
    const snap = (version: number) => ({
      id: 'news',
      version,
      fetchedAt: new Date(version).toISOString(),
      checkedAt: new Date().toISOString(),
      data: { headline: 'x' },
    });
    const { p, switches } = await asleep(content);

    // An untrusted cold boot with no network: on, whatever the closed hours say.
    const cut = await coldBootWithoutClock(p);
    await expect.poll(switches, { timeout: 10_000 }).toEqual(['/supervisor/display/off', '/supervisor/display/on']);
    // Past the 3 s a panel is given to wake: the display loop now waits for its next check.
    await new Promise((r) => setTimeout(r, 4000));

    // Meanwhile someone woke the screen from the CMS: the first answer carries that override, and new data.
    p.server.setData('news', snap(Date.now()));
    p.server.commands.push({ type: 'display', override: { state: 'on', until: new Date(Date.now() + HOUR).toISOString() } });
    cut();
    await p.until((s) => s.clock.trusted);
    await expect.poll(() => p.page.evaluate(() => localStorage.getItem('sf.displayOverride')), { timeout: 5000 }).toContain('"on"');
    // Longer than an off switch takes (1.5 s).
    await new Promise((r) => setTimeout(r, 4000));
    expect(switches()).toEqual(['/supervisor/display/off', '/supervisor/display/on']);
    expect((await p.state()).displayOn).toBe(true);
  });
});

describe('snapshots', () => {
  it('of a source a new manifest binds hold up none of its spots: it is loaded once the manifest is adopted', async () => {
    const first = h.content([{ id: 'a', durationMs: 500 }], { variant: 'first' });
    const bound = h.content([{ id: 'n', durationMs: 500, label: 'Fallback', bindings: { label: { source: 'news', path: 'headline' } } }], {
      variant: 'bound',
    });
    const p = await h.openPlayer((s) => s.publish(first), api);
    await p.until((s) => s.manifestId === first.manifest.id && s.socket);
    // Published with its feed's first snapshot; the socket nudges, and no other sync comes (every 5 minutes).
    p.server.publish(bound);
    p.server.setData('news', { id: 'news', version: 1, fetchedAt: new Date(1).toISOString(), checkedAt: new Date().toISOString(), data: { headline: 'Live' } });
    p.server.push({ type: 'manifest', id: bound.manifest.id });
    await p.until((s) => s.log.some((l) => l.manifest === bound.manifest.id));
    await expect.poll(() => p.onScreen(), { timeout: 3000 }).toMatchObject({ label: 'Live' });
    // 0.5 s spots: about 12 in 6 s, not one every 3 s (the data wait) as when the source never counts as loaded.
    const before = (await p.state()).log.filter((l) => l.manifest === bound.manifest.id).length;
    await new Promise((r) => setTimeout(r, 6000));
    const after = (await p.state()).log.filter((l) => l.manifest === bound.manifest.id).length;
    expect(after - before).toBeGreaterThanOrEqual(8);
  });

  it('arrive on the sync, and a changed one reaches the screen on its next sync', async () => {
    const snap = (headline: string, version: number) => ({
      id: 'news',
      version,
      fetchedAt: new Date(version).toISOString(),
      checkedAt: new Date().toISOString(),
      data: { headline },
    });
    const p = await h.openPlayer((s) => {
      s.publish(h.content([{ id: 'news', durationMs: 500, label: 'Fallback', bindings: { label: { source: 'news', path: 'headline' } } }]));
      s.setData('news', snap('First', 1000));
    }, api);
    await expect.poll(() => p.onScreen(), { timeout: 10_000 }).toMatchObject({ label: 'First' });
    p.server.setData('news', snap('Second', 2000));
    // The socket is open, so the next sync is the server's to call: a nudge.
    await p.until((s) => s.socket);
    p.server.push({ type: 'manifest', id: 'nudge' });
    await expect.poll(() => p.onScreen(), { timeout: 10_000 }).toMatchObject({ label: 'Second' });
    // That sync reported the version held; the next reports the new one, and is sent nothing.
    expect(p.server.syncs.at(-1)!.snapshots).toEqual({ news: 1000 });
    p.server.push({ type: 'manifest', id: 'nudge' });
    await expect.poll(() => p.server.syncs.at(-1)!.snapshots, { timeout: 10_000 }).toEqual({ news: 2000 });
    // Nothing polls the source itself.
    expect(p.server.requestsTo(/^\/content\/data\//)).toEqual([]);
  });
});

describe('a stale snapshot', () => {
  it('shows the fallback, until a sync says the server checked it again', async () => {
    const dayAndMore = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const snap = (checkedAt: string) => ({ id: 'news', version: 1000, fetchedAt: dayAndMore, checkedAt, data: { headline: 'Old news' } });
    const p = await h.openPlayer((s) => {
      s.publish(h.content([{ id: 'news', durationMs: 500, label: 'Fallback', bindings: { label: { source: 'news', path: 'headline' } } }]));
      s.setData('news', snap(dayAndMore));
    }, api);
    await p.until((s) => s.socket);
    await expect.poll(() => p.onScreen(), { timeout: 10_000 }).toMatchObject({ label: 'Fallback' });
    // The poller found the feed unchanged: the same version, checked now. Only the check is sent.
    p.server.setData('news', snap(new Date().toISOString()));
    p.server.push({ type: 'manifest', id: 'nudge' });
    await expect.poll(() => p.onScreen(), { timeout: 10_000 }).toMatchObject({ label: 'Old news' });
    expect(p.server.syncs.at(-1)!.snapshots).toEqual({ news: 1000 });
  });
});

describe('the heartbeat', () => {
  it('reports the player, manifest, display, clock and refused data, under one epoch kept across reloads', async () => {
    const content = h.content([{ id: 'news', durationMs: 500, label: 'Fallback', bindings: { label: { source: 'news', path: 'headline' } } }]);
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(content);
      s.setData('news', { id: 'news', version: 5, fetchedAt: new Date(5).toISOString(), checkedAt: new Date().toISOString(), data: { headline: 42 } });
    }, api);
    await p.until((s) => (s.dataRejected.news ?? 0) >= 1);
    await expect.poll(() => p.server.syncs.at(-1)?.dataRejected?.news ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const last = p.server.syncs.at(-1)!;
    expect(last.player.version).not.toBe('dev');
    expect(last.player.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(last.manifest).toEqual({ active: content.manifest.id, filesMissing: 0, lastGood: content.manifest.id });
    expect(last.display.on).toBe(true);
    expect(last.clock.trusted).toBe(true);
    expect(last.snapshots).toEqual({ news: 5 });
    // The socket took its ticket from the sync loop: every sync is a full one.
    expect(new Set(p.server.syncs.map((x) => x.epoch)).size).toBe(1);

    await p.page.reload();
    const before = p.server.syncs.length;
    await expect.poll(() => p.server.syncs.length, { timeout: 10_000 }).toBeGreaterThan(before);
    expect(p.server.syncs.at(-1)!.epoch).toBe(last.epoch);
  });

  it('reports only the sources of the manifests it holds, once a source is gone from them', async () => {
    const news = h.content([{ id: 'news', durationMs: 500, label: 'Fallback', bindings: { label: { source: 'news', path: 'headline' } } }]);
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(news);
      s.setData('news', { id: 'news', version: 5, fetchedAt: new Date(5).toISOString(), checkedAt: new Date().toISOString(), data: { headline: 42 } });
    }, api);
    await expect.poll(() => p.server.syncs.at(-1)?.dataRejected?.news ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(p.server.syncs.at(-1)!.snapshots).toEqual({ news: 5 });

    const plain = h.content([{ id: 'a', durationMs: 500 }], { variant: 'plain' });
    p.server.publish(plain);
    await p.until((s) => s.lastGood === plain.manifest.id);
    await expect.poll(() => p.server.syncs.at(-1)?.manifest.lastGood, { timeout: 10_000 }).toBe(plain.manifest.id);
    const last = p.server.syncs.at(-1)!;
    expect(last.snapshots).toEqual({});
    expect(last.dataRejected).toEqual({});
    // __sf still counts every refusal since the start.
    expect((await p.state()).dataRejected.news).toBeGreaterThanOrEqual(1);
  });

  it('reports the last good manifest, so the server serves its files, while falling back to it', async () => {
    const good = h.content([{ id: 'a', durationMs: 500 }], { variant: 'good' });
    const broken = h.content([{ id: 'x', mode: 'throw', durationMs: 500 }], { variant: 'broken' });
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(good);
    }, api);
    await p.until((s) => s.lastGood === good.manifest.id);
    p.server.publish(broken);
    await p.until((s) => s.fallback === broken.manifest.id);
    await expect
      .poll(() => p.server.syncs.at(-1)?.manifest, { timeout: 10_000 })
      .toEqual({ active: good.manifest.id, filesMissing: 0, fallbackFrom: broken.manifest.id, lastGood: good.manifest.id });
  });
});

describe('a failed content fetch', () => {
  it("leaves the heartbeat at the server's interval, while the fetch retries on its own", async () => {
    const content = h.content([{ id: 'a', durationMs: 500 }]);
    let restore = () => {};
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 4;
      s.publish(content);
      restore = s.intercept(/^\/content\/blobs\//, { status: 404 });
    }, api);
    await p.until((s) => s.socket);
    const syncs = p.server.syncs.length;
    const fetches = () => p.server.requestsTo(/^\/content\/blobs\//).length;
    const tried = fetches();
    await new Promise((r) => setTimeout(r, 9000));
    // Every 4 s (±10%), not every second (`poll=1`) as after a failed sync.
    expect(p.server.syncs.length - syncs).toBeGreaterThanOrEqual(2);
    expect(p.server.syncs.length - syncs).toBeLessThanOrEqual(3);
    expect(fetches() - tried).toBeGreaterThanOrEqual(3);
    expect((await p.state()).online).toBe(true);

    // The file back: it plays within a retry, which never waits longer than the sync interval.
    restore();
    await p.until((s) => s.manifestId === content.manifest.id, 6000);
  });

  it('never holds back the next heartbeat while a download is still going', async () => {
    const content = h.content([{ id: 'a', durationMs: 500 }]);
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 2;
      s.publish(content);
      s.intercept(/^\/content\/blobs\//, 'stall');
    }, api);
    await p.until((s) => s.socket);
    const syncs = p.server.syncs.length;
    await new Promise((r) => setTimeout(r, 7000));
    // The download has neither finished nor been given up on (the stall timeout is 30 s). A CORS
    // preflight carries no credential.
    const blobs = p.server.requestsTo(/^\/content\/blobs\//).filter((r) => r.bearer);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.abortedAt).toBeUndefined();
    // Every 2 s (±10%) all the same.
    expect(p.server.syncs.length - syncs).toBeGreaterThanOrEqual(3);
  });
});

describe('commands on the sync', () => {
  it('reload the player, but not again within minutes', async () => {
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(h.content([{ id: 'a', durationMs: 500 }]));
    }, api);
    await p.until((s) => s.log.length >= 1);
    const loads = () => p.server.requestsTo(/^\/$/).length;
    expect(loads()).toBe(1);
    p.server.commands.push({ type: 'reload' });
    await expect.poll(loads, { timeout: 10_000 }).toBe(2);
    await p.until((s) => s.log.length >= 1);
    p.server.commands.push({ type: 'reload' });
    const sent = p.server.syncs.length;
    await expect.poll(() => p.server.syncs.length, { timeout: 10_000 }).toBeGreaterThan(sent + 1);
    expect(loads()).toBe(2);
  });
});
