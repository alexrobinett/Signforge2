import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import { type FrameTheme, NEWS_SUMMARY_MAX, type Orientation } from '@signforge/contract';
import { rowAsset } from '@signforge/template-sdk/rows';
import {
  at,
  DEMO_KIT,
  host,
  layoutFaults,
  LIGHT_KIT,
  motion,
  noDemoAndLight,
  NOW,
  paintedContrast,
  spotData,
  useTemplate,
  type Data,
} from '@signforge/template-test';

const img = { file: 'a'.repeat(64), thumb: 'b'.repeat(64) };
const t = useTemplate(new URL('..', import.meta.url), {
  a: { look: 'night', items: [] },
  b: { look: 'poster', showList: false, items: [{ title: 'Ferry runs late', published: '', source: 'Wire', summary: 'By an hour.', image: img }] },
  assetsB: { [rowAsset('items', 0, 'image')]: '#369', [rowAsset('items', 0, 'image', 'thumb')]: '#369' },
});

describe('news 2.0 (#202)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  const toggles = ['showImages', 'showSummary', 'showList', 'showMeta', 'showCrawl'];
  const demo: FrameTheme = { colors: DEMO_KIT, shape: 'soft', fonts: {} };

  interface Story {
    title: string;
    published: string;
    source: string;
    summary: string;
    image?: typeof img;
  }
  const story = (i: number, over: Partial<Story> = {}): Story => ({
    title: `Council approves the riverside park, story ${i + 1}`,
    published: at(-(i + 1)),
    source: 'Metro Desk',
    summary: 'The park opens in phases from next spring, with a boardwalk and a ferry stop.',
    image: img,
    ...over,
  });
  /** Each story's photo (`lead` wide, as the server stores a large one) and thumbnail, but for the indices in `missing`: their blobs never arrived. */
  const photos = (n: number, missing: number[] = [], lead = '1920x1080') =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => i)
        .filter((i) => !missing.includes(i))
        .flatMap((i) => [
          [rowAsset('items', i, 'image'), `${lead}: #4b86b4`],
          [rowAsset('items', i, 'image', 'thumb'), '480x270: #a0522d'],
        ]),
    );
  /** Every text at its longest: 30 stories, each headline at 200 characters and summary at 240. */
  const sentence = 'Harbor commission votes to rebuild the north pier and widen the ferry terminal before the summer season begins. ';
  const longest = (bare = false): Story[] =>
    Array.from({ length: 30 }, (_, i) =>
      story(i, {
        title: sentence.repeat(2).slice(0, 200),
        summary: sentence.repeat(3).slice(0, 240),
        source: 'Metropolitan Harbor Authority Newsroom',
        ...(bare && i === 0 ? { image: undefined } : {}),
      }),
    );

  /** One frame at a screen's own size; `show` inits it and waits for ready. One turn per play unless `rotate`. */
  async function frame(orientation: Orientation = 'landscape') {
    const hst = await host(orientation, true);
    await hst.open('fresh', t().html);
    let inits = 0;
    return {
      hst,
      async show(data: Data, assets: Record<string, string> = photos(30), theme: FrameTheme | null = demo, durationMs = 15_000) {
        await hst.init('fresh', spotData(t().manifest, { rotationSeconds: 30, ...data }), assets, NOW, theme ?? undefined, false, durationMs);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.page.mainFrame().childFrames()[0]!;
      },
    };
  }
  const settings: Data[] = Array.from({ length: 32 }, (_, bits) => Object.fromEntries(toggles.map((k, i) => [k, !(bits & (1 << i))])));
  const named = (set: Data) =>
    toggles
      .filter((k) => !set[k])
      .map((k) => `${k.slice(4).toLowerCase()} off`)
      .join(', ') || 'all on';

  for (const orientation of ['landscape', 'portrait'] as const)
    for (const look of looks)
      it(`${look}, ${orientation}: in every toggle setting, at the longest copy, with a large, a small and no lead photo, nothing overflows, overlaps or runs off`, async () => {
        const r = await frame(orientation);
        const found: string[] = [];
        for (const lead of ['large', 'small', 'none'] as const)
          for (const set of settings) {
            const f = await r.show(
              { look, items: longest(lead === 'none'), ...set },
              photos(30, lead === 'none' ? [0] : [], lead === 'small' ? '700x560' : '1920x1080'),
            );
            for (const fault of await layoutFaults(f, '.thumb', '.marker')) found.push(`${lead} lead photo, ${named(set)}: ${fault}`);
          }
        expect(found).toEqual([]);
      }, 300_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`ordinary stories fit at the look's own size, no headline stepped down, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const bare of [false, true]) {
          const f = await r.show({ look, items: [0, 1, 2, 3, 4].map((i) => story(i, bare ? { image: undefined } : {})) });
          for (const fault of await layoutFaults(f, '.thumb', '.marker')) found.push(`${look}: ${fault}`);
          if (await f.evaluate(() => document.querySelector<HTMLElement>('.story')!.style.getPropertyValue('--fit')))
            found.push(`${look}: the headline is stepped down`);
        }
      expect(found).toEqual([]);
    }, 120_000);

  /** Settings whose painted text differs: all on, each toggle off alone, all off. */
  const contrastSets: Data[] = [{}, ...toggles.map((k) => ({ [k]: false })), Object.fromEntries(toggles.map((k) => [k, false]))];
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted, with no kit, the demo kit and a light kit, on a photo lead and a bare one, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const [kit, theme] of noDemoAndLight(LIGHT_KIT))
        for (const look of looks)
          for (const bare of [false, true])
            for (const set of contrastSets) {
              const items = [0, 1, 2, 3, 4].map((i) => story(i));
              const f = await r.show({ look, items, ...set }, photos(5, bare ? [0] : []), theme ?? null);
              // The lead is painted from play.
              await r.hst.post('fresh', 'play');
              await f.waitForFunction(() => getComputedStyle(document.getElementById('leads')!).visibility === 'visible');
              const all = Object.fromEntries(toggles.map((k) => [k, true]));
              for (const l of await paintedContrast(r.hst.page, f, '.stage'))
                found.push(`${look}, ${kit}, ${bare ? 'bare lead' : 'photo lead'}, ${named({ ...all, ...set })}: ${l}`);
            }
      expect(found).toEqual([]);
    }, 600_000);

  /** At `ms` into the play, all animations paused there: the story on top, the stories shown, and the row the marker is on. */
  const at_ = (f: Frame, ms: number) =>
    f.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
      const shown = [...document.querySelectorAll<HTMLElement>('.story')].filter((s) => getComputedStyle(s).opacity === '1');
      const marker = document.querySelector<HTMLElement>('.marker');
      const y = marker ? new DOMMatrix(getComputedStyle(marker).transform).m42 : undefined;
      const rows = [...document.querySelectorAll<HTMLElement>('.row')];
      return {
        lead: shown.at(-1)?.querySelector('.headline')?.textContent,
        shown: shown.length,
        marked: y === undefined ? undefined : rows.findIndex((row) => Math.abs(row.offsetTop - y) < 1),
      };
    }, ms);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`turns the lead through the listed stories over the play, the marker arriving as each comes on, ${orientation}`, async () => {
      const r = await frame(orientation);
      const items = Array.from({ length: 8 }, (_, i) => story(i));
      const rows = orientation === 'landscape' ? 5 : 4;
      for (const look of looks) {
        // 40 s at 8 s a story: five turns in landscape; the four listed stories in portrait, 10 s each.
        const f = await r.show({ look, items, rotationSeconds: 8 }, photos(8), demo, 40_000);
        const slot = 40_000 / rows;
        expect(await f.evaluate(() => document.querySelectorAll('.story').length), look).toBe(rows);
        for (let i = 0; i < rows; i++) {
          expect(await at_(f, i * slot + slot / 2), `${look}, story ${i + 1}`).toEqual({ lead: items[i]!.title, shown: 1, marked: i });
        }
        // The last story stays to the end; the first is on from the start.
        expect(await at_(f, 40_000), look).toEqual({ lead: items[rows - 1]!.title, shown: 1, marked: rows - 1 });
        expect((await at_(f, 0)).lead, look).toBe(items[0]!.title);
      }
    }, 120_000);

  it('turns as often as rotationSeconds asks, at most once per listed story, and not at all with one story', async () => {
    const r = await frame();
    const turns = async (data: Data, durationMs: number) =>
      (await r.show(data, photos(8), demo, durationMs)).evaluate(() => document.querySelectorAll('.story').length);
    const items = Array.from({ length: 8 }, (_, i) => story(i));
    expect(await turns({ items, rotationSeconds: 8 }, 16_000)).toBe(2);
    expect(await turns({ items, rotationSeconds: 4 }, 16_000)).toBe(4);
    expect(await turns({ items, rotationSeconds: 4 }, 300_000)).toBe(5);
    expect(await turns({ items: [story(0)], rotationSeconds: 4 }, 16_000)).toBe(1);
  });

  it('shows every photo, some, or none, a story without one as a bigger headline with its initial in the list, and never decodes a photo switched off', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        images: document.documentElement.dataset.images,
        bare: [...document.querySelectorAll('.story')].map((s) => s.classList.contains('no-photo')),
        thumbs: [...document.querySelectorAll('.row')].map((row) =>
          row.querySelector('.thumb img[src]') ? 'photo' : (row.querySelector('.initial')?.textContent ?? 'none'),
        ),
        srcs: document.querySelectorAll('img[src]').length,
        sizes: [...document.querySelectorAll('.headline')].map((h) => Number.parseFloat(getComputedStyle(h).fontSize)),
      }));
    const items = [story(0), story(1, { image: undefined, source: 'weather desk' }), story(2), story(3, { source: '' })];
    const all = await read(await r.show({ items, rotationSeconds: 8 }, photos(4, [1]), demo, 32_000));
    expect(all).toMatchObject({ images: 'on', bare: [false, true, false, false], thumbs: ['photo', 'W', 'photo', 'photo'] });
    expect(all.sizes[1]).toBeGreaterThan(all.sizes[0]!);
    // A photo whose blob never arrived plays as a story without one; with no source, the feed's credit gives the initial.
    // The publisher's initial (the spot's source) over the story's, which a feed may give a section: "The Guardian" is G.
    const missing = await read(await r.show({ items, source: 'The Guardian', rotationSeconds: 8 }, photos(4, [1, 3]), demo, 32_000));
    expect(missing).toMatchObject({ bare: [false, true, false, true], thumbs: ['photo', 'G', 'photo', 'G'] });
    expect(await read(await r.show({ items, rotationSeconds: 8 }, {}, demo, 32_000))).toMatchObject({
      images: 'off',
      bare: [true, true, true, true],
      thumbs: ['none', 'none', 'none', 'none'],
    });
    expect(await read(await r.show({ items, showImages: false, rotationSeconds: 8 }, photos(4), demo, 32_000))).toMatchObject({ images: 'off', srcs: 0 });
  });

  it("keeps each story with its own row's photo, summary and source when a row without a headline comes first", async () => {
    const r = await frame();
    const items = [
      story(0, { title: '  ', summary: 'Blank row', source: 'Blank desk' }),
      story(1, { image: undefined, summary: 'First real story', source: 'Metro Desk' }),
      story(2, { summary: 'Second real story', source: 'Sports' }),
    ];
    // The blank row has a photo; the first real story has none.
    const f = await r.show({ items }, photos(3, [1]));
    expect(
      await f.evaluate(() => {
        const lead = document.querySelector('.story')!;
        return {
          headline: lead.querySelector('.headline')!.textContent,
          summary: lead.querySelector('.summary')!.textContent,
          src: lead.querySelector('.src')!.textContent,
          bare: lead.classList.contains('no-photo'),
          rows: [...document.querySelectorAll('.row')].map((row) => [
            row.querySelector('.rtitle')!.textContent,
            row.querySelector('.thumb img') ? 'photo' : row.querySelector('.initial')!.textContent,
          ]),
        };
      }),
    ).toEqual({
      headline: items[1]!.title,
      summary: 'First real story',
      src: 'Metro Desk',
      bare: true,
      rows: [
        [items[1]!.title, 'M'],
        [items[2]!.title, 'photo'],
      ],
    });
  });

  it('drops the frame of a lead photo the browser cannot decode, the first in prepare and a later one in play', async () => {
    const hst = await host('landscape', true);
    await hst.page.clock.install({ time: NOW });
    await hst.page.clock.pauseAt(NOW);
    await hst.open('fresh', t().html);
    const assets = { ...photos(3), [rowAsset('items', 0, 'image')]: 'broken', [rowAsset('items', 1, 'image')]: 'broken' };
    await hst.init('fresh', spotData(t().manifest, { items: [0, 1, 2].map((i) => story(i)), rotationSeconds: 8 }), assets, NOW, demo, false, 24_000);
    const ready = async () => (await hst.page.evaluate(() => (window as unknown as { msgs: Record<string, string[]> }).msgs.fresh!)).includes('ready');
    for (let i = 0; i < 500 && !(await ready()); i++) await hst.page.clock.runFor(16);
    const f = hst.page.mainFrame().childFrames()[0]!;
    const frames = () => f.evaluate(() => [...document.querySelectorAll('.story')].map((s) => (s.querySelector('.media') ? 'frame' : 'bare')));
    expect(await frames()).toEqual(['bare', 'frame', 'frame']);
    await hst.post('fresh', 'play');
    // The second story's photo loads at 5 s and fails; the third's at 13 s, and draws.
    for (let i = 0; i < 100; i++) await hst.page.clock.runFor(100);
    await f.waitForFunction(() => !document.querySelectorAll('.story')[1]!.querySelector('.media'));
    expect(await frames()).toEqual(['bare', 'bare', 'frame']);
  });

  it(`takes the feed's summaries at their longest, NEWS_SUMMARY_MAX characters`, () => {
    const items = t().manifest.fields.items;
    expect(items?.type === 'list' && items.item.summary).toMatchObject({ maxLength: NEWS_SUMMARY_MAX });
  });

  // Descenders (g, j, p, q, y) stand below a tight display line: no text box may clip them (owner's report on #476:
  // "Long." and "Surge." in Poster's lead). Copy that fits, so turning every text box's clipping off changes no pixel.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`clips no descender in any text box, in every look, ${orientation}`, async () => {
      const r = await frame(orientation);
      const deep = [
        story(0, { title: 'Jumpy prices dip; July gets quiet', summary: 'Gloomy pygmy yaks jog by; quaint jugglers pay up.', source: 'Pygmy Daily' }),
        ...[1, 2, 3, 4].map((i) => story(i, { title: `Jogging quaggy pygmy yaks, page ${i}`, source: 'gypsy jay' })),
      ];
      const found: string[] = [];
      for (const look of looks)
        for (const bare of [false, true]) {
          const f = await r.show({ look, items: deep }, photos(5, bare ? [0] : []));
          await r.hst.post('fresh', 'play');
          await f.waitForFunction(() => getComputedStyle(document.getElementById('leads')!).visibility === 'visible');
          const clip = await f.evaluate(() => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = 4000;
            }
            const b = document.querySelector('.stage')!.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
          });
          const clipped = await r.hst.page.screenshot({ clip });
          await f.evaluate(() => {
            const el = document.createElement('style');
            el.id = 'unclipped';
            el.textContent = '.headline, .rtitle, .summary, .meta, .src, .credit, .lk-mask { overflow: visible !important; }';
            document.head.append(el);
          });
          if (!(await r.hst.page.screenshot({ clip })).equals(clipped)) found.push(`${look}, ${bare ? 'bare lead' : 'photo lead'}`);
          await f.evaluate(() => document.getElementById('unclipped')!.remove());
        }
      expect(found).toEqual([]);
    }, 120_000);

  // A feed's small photo (some send 700 px) drawn across the lead looks soft: it is framed at most 1.25 times its size,
  // and the headline takes the space (owner decision on #476).
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`frames a small lead photo at most 1.25 times its size, and fills the lead with a large one, ${orientation}`, async () => {
      const r = await frame(orientation);
      const read = (f: Frame) =>
        f.evaluate(() => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = 3000;
          }
          const story = document.querySelector('.story')!;
          const media = story.querySelector('.media')!.getBoundingClientRect();
          const card = story.querySelector('.card')!.getBoundingClientRect();
          const overlap =
            Math.min(media.right, card.right) - Math.max(media.left, card.left) > 1 && Math.min(media.bottom, card.bottom) - Math.max(media.top, card.top) > 1;
          return { small: story.classList.contains('small'), width: Math.round(media.width), overlap };
        });
      for (const look of looks) {
        expect(await read(await r.show({ look, items: [0, 1, 2].map((i) => story(i)) }, photos(3, [], '700x560'))), look).toMatchObject({
          small: true,
          overlap: false,
        });
        expect((await read(await r.show({ look, items: [0, 1, 2].map((i) => story(i)) }, photos(3, [], '700x560')))).width, look).toBeLessThanOrEqual(875);
        expect(await read(await r.show({ look, items: [0, 1, 2].map((i) => story(i)) }, photos(3))), look).toMatchObject({ small: false });
      }
    });

  it("frames a later story's small photo when it loads, in play", async () => {
    const hst = await host('landscape', true);
    await hst.page.clock.install({ time: NOW });
    await hst.page.clock.pauseAt(NOW);
    await hst.open('fresh', t().html);
    await hst.init(
      'fresh',
      spotData(t().manifest, { items: [0, 1].map((i) => story(i)), rotationSeconds: 8 }),
      photos(2, [], '700x560'),
      NOW,
      demo,
      false,
      16_000,
    );
    const ready = async () => (await hst.page.evaluate(() => (window as unknown as { msgs: Record<string, string[]> }).msgs.fresh!)).includes('ready');
    for (let i = 0; i < 500 && !(await ready()); i++) await hst.page.clock.runFor(16);
    const f = hst.page.mainFrame().childFrames()[0]!;
    await hst.post('fresh', 'play');
    // The second story's photo loads 3 s before its turn at 8 s.
    for (let i = 0; i < 60; i++) await hst.page.clock.runFor(100);
    await f.waitForFunction(() => document.querySelectorAll('.story')[1]!.classList.contains('small'));
  });

  it('marks each toggle on the root and removes what is off, and what has nothing to show is off', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['images', 'summary', 'list', 'meta', 'crawl'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.media', '.summary', '.list', '.meta', '.ticker'].filter((s) => document.querySelector(s)),
      }));
    const items = [0, 1, 2].map((i) => story(i));
    expect(await read(await r.show({ items }))).toEqual({
      marks: ['images=on', 'summary=on', 'list=on', 'meta=on', 'crawl=on'],
      present: ['.media', '.summary', '.list', '.meta', '.ticker'],
    });
    expect(await read(await r.show({ items, ...Object.fromEntries(toggles.map((k) => [k, false])) }))).toEqual({
      marks: ['images=off', 'summary=off', 'list=off', 'meta=off', 'crawl=off'],
      present: [],
    });
    // One story is no list; a story without a summary or a source and age has neither.
    expect(await read(await r.show({ items: [story(0, { summary: '', source: '', published: '' })] }))).toEqual({
      marks: ['images=on', 'summary=on', 'list=off', 'meta=on', 'crawl=on'],
      present: ['.media', '.ticker'],
    });
  });

  it('with no headlines, says so, with no list and no crawl', async () => {
    const r = await frame();
    const f = await r.show({ items: [] }, {});
    expect(
      await f.evaluate(() => ({
        lead: document.querySelector('.headline')!.textContent,
        present: ['.list', '.ticker', '.media', '.meta'].filter((s) => document.querySelector(s)),
      })),
    ).toEqual({ lead: 'No headlines yet', present: [] });
    expect(await layoutFaults(f)).toEqual([]);
  });

  it("shows the time from init, not the device clock, and each story's age in the feed's language", async () => {
    const r = await frame();
    const items = [story(0, { published: at(-1) }), story(1, { published: at(-26) })];
    const read = async (data: Data) =>
      (await r.show({ items, rotationSeconds: 8, ...data }, photos(2), demo, 16_000)).evaluate(() => ({
        clock: document.getElementById('clock')!.textContent,
        ages: [...document.querySelectorAll('.age')].map((a) => a.textContent),
      }));
    expect(await read({})).toEqual({ clock: '3:00 PM', ages: ['1 hour ago', 'yesterday'] });
    expect(await read({ language: 'fr-FR' })).toEqual({ clock: '3:00 PM', ages: ['il y a 1 heure', 'hier'] });
  });

  it('crawls every headline, at the look kit speed', async () => {
    const r = await frame();
    const f = await r.show({ look: 'poster', items: [0, 1, 2].map((i) => story(i, { title: `Story ${i + 1}` })) });
    expect(await f.evaluate(() => document.querySelector('.lk-crawl')!.firstElementChild!.textContent)).toBe('Story 1  —  Story 2  —  Story 3');
  });

  it('keeps the photos unpainted until play', async () => {
    const r = await frame();
    const f = await r.show({ items: [story(0), story(1)] });
    expect(await f.evaluate(() => getComputedStyle(document.getElementById('leads')!).visibility)).toBe('hidden');
    await r.hst.post('fresh', 'play');
    await f.waitForFunction(() => getComputedStyle(document.getElementById('leads')!).visibility === 'visible');
  });

  it("decodes only the first story's photo before ready, and loads each later one in play, three seconds before its turn", async () => {
    const hst = await host('landscape', true);
    // The frame's clock is Playwright's, stepped by hand: no test time passes on its own.
    await hst.page.clock.install({ time: NOW });
    await hst.page.clock.pauseAt(NOW);
    await hst.open('fresh', t().html);
    await hst.init('fresh', spotData(t().manifest, { items: [0, 1, 2, 3, 4].map((i) => story(i)), rotationSeconds: 8 }), photos(5), NOW, demo, false, 40_000);
    const ready = async () => (await hst.page.evaluate(() => (window as unknown as { msgs: Record<string, string[]> }).msgs.fresh!)).includes('ready');
    for (let i = 0; i < 500 && !(await ready()); i++) await hst.page.clock.runFor(16);
    const f = hst.page.mainFrame().childFrames()[0]!;
    const loaded = () => f.evaluate(() => [...document.querySelectorAll('.story .photo')].map((img) => img.hasAttribute('src')));
    expect(await loaded()).toEqual([true, false, false, false, false]);
    await hst.post('fresh', 'play');
    // 8 s a story: the second comes on at 8 s, so its photo loads at 5 s; the third's at 13 s.
    await hst.page.clock.runFor(4_900);
    expect(await loaded()).toEqual([true, false, false, false, false]);
    await hst.page.clock.runFor(200);
    expect(await loaded()).toEqual([true, true, false, false, false]);
    await hst.page.clock.runFor(8_000);
    expect(await loaded()).toEqual([true, true, true, false, false]);
  });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`moves only transform and opacity, within the cap; each story's parts end as the story does, and the rest as the play does, ${orientation}`, async () => {
      const r = await frame(orientation);
      const durationMs = 40_000;
      for (const look of looks) {
        const f = await r.show({ look, items: Array.from({ length: 8 }, (_, i) => story(i)), rotationSeconds: 8 }, photos(8), demo, durationMs);
        const seen = await motion(f, durationMs);
        expect({ props: seen.props, withinCap: seen.withinCap }, look).toEqual({ props: ['opacity', 'transform'], withinCap: true });
        const ends = await f.evaluate((durationMs) => {
          const end = (el: Element) => Math.max(...el.getAnimations().map((a) => Math.round(Number(a.effect!.getComputedTiming().endTime))));
          const stories = [...document.querySelectorAll<HTMLElement>('.story')];
          // Poster's photo has no motion of its own (its ink cover moves): only what animates.
          const parts = (scope: ParentNode) =>
            [...scope.querySelectorAll('.lk-text, .lk-fade, .lk-photo, .lk-cover, .lk-badge')].filter((el) => el.getAnimations().length);
          return {
            // Each story's parts, and each but the last itself, which hides as it ends.
            stories: stories.map((s, i) => [...new Set([...(i < stories.length - 1 ? [end(s)] : []), ...parts(s).map(end)])]),
            rest: [
              ...new Set(
                parts(document)
                  .filter((el) => !el.closest('.story'))
                  .map(end),
              ),
            ],
            slot: durationMs / stories.length,
          };
        }, durationMs);
        expect(ends.rest, look).toEqual([durationMs]);
        ends.stories.forEach((e, i) =>
          expect(e, `${look}, story ${i + 1}`).toEqual([i === ends.stories.length - 1 ? durationMs : Math.round((i + 1) * ends.slot)]),
        );
      }
    }, 120_000);

  it('with reduced motion, shows the first story still, nothing animating', async () => {
    const r = await frame();
    await r.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const look of looks) {
      const f = await r.show({ look, items: Array.from({ length: 5 }, (_, i) => story(i)), rotationSeconds: 8 }, photos(5), demo, 40_000);
      await r.hst.post('fresh', 'play');
      expect(await f.evaluate(() => ({ animations: document.getAnimations().length, stories: document.querySelectorAll('.story').length })), look).toEqual({
        animations: 0,
        stories: 1,
      });
    }
  });
});
