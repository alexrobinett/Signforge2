// The sync loop against the device API (M3-07): one periodic sync carries the heartbeat and play
// counts, corrects the clock from server time, delivers snapshots, and hands the socket its ticket.
import { describe, expect, it } from 'vitest';
import type { FixtureServer } from './fixture-server';
import { useHarness, type PlayerState } from './harness';

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
});

describe('snapshots', () => {
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
