import { describe, expect, it } from 'vitest';
import type { FixtureSpot } from './content';
import { useHarness } from './harness';

const h = useHarness();
const DATA = /^\/content\/data\/news\.json$/;
/**
 * The page's clock, Playwright's, from this instant: every age below counts from it, never from the wall clock (#625).
 * It is after any build of this player, so the screen trusts its clock (src/clock.ts) and a calendar's minutes count.
 */
const NOW = Date.parse('2100-01-01T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** A news spot whose headline and items are bound to the `news` source; the static values are its fallback. */
const news: FixtureSpot = {
  id: 'news',
  label: 'Fallback headline',
  items: [{ title: 'Fallback item' }],
  bindings: { label: { source: 'news', path: 'headline' }, items: { source: 'news', path: 'stories' } },
};
const snapshot = (data: unknown, fetchedAt = '2026-11-17T12:00:00.000Z') => ({
  id: 'news',
  version: Date.parse(fetchedAt),
  fetchedAt,
  checkedAt: ago(0),
  data,
});
const live = { headline: 'Live headline', stories: [{ title: 'Live 1' }, { title: 'Live 2' }] };

/** Open the player on the news spot with `data` as the source's snapshot, and wait for it to play. */
async function playWith(data: unknown) {
  const p = await h.openPlayer(
    (s) => {
      s.publish(h.content([news]));
      s.setData('news', snapshot(data));
    },
    {},
    { clockAt: new Date(NOW) },
  );
  await p.until((s) => s.log.length >= 1);
  return p;
}

describe('live data', () => {
  it('shows bound values that fit their fields', async () => {
    const p = await playWith(live);
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Live headline', items: 'Live 1, Live 2' });
    expect((await p.state()).dataRejected).toEqual({});
  });

  it('keeps the fallback for a value of the wrong type, and counts it against the source', async () => {
    const p = await playWith({ ...live, headline: 42 });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Fallback headline', items: 'Live 1, Live 2' });
    expect((await p.state()).dataRejected.news).toBeGreaterThanOrEqual(1);
    expect(p.console.join('\n')).toContain('field "label" must be text');
  });

  it('keeps the fallback for a value of the wrong shape, so the template does not throw', async () => {
    const p = await playWith({ ...live, stories: {} });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Live headline', items: 'Fallback item' });
    const s = await p.state();
    expect(s.skipped).toBe(0);
    expect(s.dataRejected.news).toBeGreaterThanOrEqual(1);
  });

  it('keeps the fallback for a list with more rows than the field allows', async () => {
    const stories = ['1', '2', '3', '4'].map((n) => ({ title: `Live ${n}` }));
    const p = await playWith({ ...live, stories });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Live headline', items: 'Fallback item' });
  });

  it('keeps the fallback for a path the snapshot does not have', async () => {
    const p = await playWith({ headline: 'Live headline' });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Live headline', items: 'Fallback item' });
    expect((await p.state()).dataRejected.news).toBeGreaterThanOrEqual(1);
  });

  it('does not keep a snapshot that fits no bound field as the latest, on disk or in memory', async () => {
    const p = await playWith(live);
    await p.until((s) => s.data.news === '2026-11-17T12:00:00.000Z');

    // A broken feed: nothing in it fits. A reload fetches it at once.
    p.server.setData('news', snapshot({ headline: 42, stories: {} }, '2026-11-17T13:00:00.000Z'));
    await p.page.reload();
    const s = await p.until((s) => (s.dataRejected.news ?? 0) >= 1 && s.log.length >= 1);
    expect(s.data.news).toBe('2026-11-17T12:00:00.000Z');
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Live headline', items: 'Live 1, Live 2' });

    // Offline after a restart, the stored snapshot is still the last good one.
    p.server.intercept(DATA, { status: 500 });
    await p.page.reload();
    await p.until((s) => s.log.length >= 1);
    expect((await p.state()).data.news).toBe('2026-11-17T12:00:00.000Z');
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Live headline', items: 'Live 1, Live 2' });
  });
});

describe('a template with two sources (#193)', () => {
  /** The label from a forecast and the rows from a feed: each field bound to its own source. */
  const frame: FixtureSpot = {
    id: 'frame',
    label: 'Fallback weather',
    items: [{ title: 'Fallback item' }],
    bindings: { label: { source: 'weather', path: 'current.summary' }, items: { source: 'news', path: 'stories' } },
  };
  const at = (id: string, data: unknown, checkedAt: string) => ({ ...snapshot(data), id, checkedAt });
  /** A day and an hour unconfirmed: stale for a source with no age of its own. */
  const stale = ago(25 * 60);

  /** `weatherStaleS`: the weather snapshot's own stale age, as the server gives a calendar's (#624). */
  async function playWith(data: { weather?: string; news?: string }, weatherStaleS?: number) {
    const p = await h.openPlayer(
      (s) => {
        s.publish(
          h.content([frame], {
            edit: (m) => {
              for (const t of Object.values(m.templates))
                t.manifest = {
                  ...t.manifest,
                  live: {
                    sources: {
                      weather: { label: 'Weather', source: 'open-meteo', fields: { label: 'current.summary' } },
                      headlines: { label: 'Headlines', source: 'rss', fields: { items: 'stories' } },
                    },
                  },
                };
            },
          }),
        );
        const age = weatherStaleS === undefined ? {} : { staleS: weatherStaleS };
        if (data.weather) s.setData('weather', { ...at('weather', { current: { summary: 'Sunny, 21°' } }, data.weather), ...age });
        if (data.news) s.setData('news', at('news', live, data.news));
      },
      {},
      { clockAt: new Date(NOW) },
    );
    await p.until((s) => s.log.length >= 1);
    return p;
  }

  it('plays both sources when both are fresh', async () => {
    const p = await playWith({ weather: ago(0), news: ago(0) });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Sunny, 21°', items: 'Live 1, Live 2', fallback: '' });
    expect((await p.state()).dataRejected).toEqual({});
  });

  it('plays the fallback of a stale source only, and the other source live, and tells the template which (#225)', async () => {
    const p = await playWith({ weather: stale, news: ago(0) });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Fallback weather', items: 'Live 1, Live 2', fallback: 'label' });
  });

  it("plays a source's fallback once it is older than its own stale age, a calendar's minutes, not a day (#624)", async () => {
    // Confirmed 24 minutes ago, with 25 minutes to live: live. The feed is failing, so its snapshot is not confirmed again.
    const p = await playWith({ weather: ago(24), news: ago(0) }, 1500);
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Sunny, 21°', fallback: '' });
    // Two minutes on, the next play of the spot finds it stale.
    await p.page.clock.fastForward(2 * 60_000);
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Fallback weather', items: 'Live 1, Live 2', fallback: 'label' });
  });

  it('plays every fallback with neither source, and tells the template so (#225)', async () => {
    const p = await playWith({});
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Fallback weather', items: 'Fallback item', fallback: 'label,items' });
  });
});
