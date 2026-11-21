import { describe, expect, it } from 'vitest';
import type { FixtureSpot } from './content';
import { useHarness } from './harness';

const h = useHarness();
const DATA = /^\/content\/data\/news\.json$/;

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
  checkedAt: new Date().toISOString(),
  data,
});
const live = { headline: 'Live headline', stories: [{ title: 'Live 1' }, { title: 'Live 2' }] };

/** Open the player on the news spot with `data` as the source's snapshot, and wait for it to play. */
async function playWith(data: unknown) {
  const p = await h.openPlayer((s) => {
    s.publish(h.content([news]));
    s.setData('news', snapshot(data));
  });
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
  const at = (id: string, data: unknown, checkedAt = new Date().toISOString()) => ({ ...snapshot(data), id, checkedAt });
  /** A day and an hour unconfirmed: stale, whatever the time. */
  const stale = () => new Date(Date.now() - 25 * 3_600_000).toISOString();

  async function playWith(data: { weather?: string; news?: string }) {
    const p = await h.openPlayer((s) => {
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
      if (data.weather) s.setData('weather', at('weather', { current: { summary: 'Sunny, 21°' } }, data.weather));
      if (data.news) s.setData('news', at('news', live, data.news));
    });
    await p.until((s) => s.log.length >= 1);
    return p;
  }

  it('plays both sources when both are fresh', async () => {
    const now = new Date().toISOString();
    const p = await playWith({ weather: now, news: now });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Sunny, 21°', items: 'Live 1, Live 2' });
    expect((await p.state()).dataRejected).toEqual({});
  });

  it('plays the fallback of a stale source only, and the other source live', async () => {
    const p = await playWith({ weather: stale(), news: new Date().toISOString() });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Fallback weather', items: 'Live 1, Live 2' });
  });

  it('plays every fallback with neither source', async () => {
    const p = await playWith({});
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'Fallback weather', items: 'Fallback item' });
  });
});
