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
  motionContract,
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

describe('news 2.1 (design D, #476)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  const toggles = ['showImages', 'showSummary', 'showList', 'showMeta'];
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

  /**
   * Faults at rest, 3 s in, the first story's intro done: text past the screen, its box or its story, painted over, or
   * meeting other text or the photo, which counts as text here: no text sits on a photo.
   */
  const faults = (f: Frame) => layoutFaults(f, '.photo', '.bar', '.story', 3000);
  /** A story's photo of a given size: `1800x1800`, the shape a feed sends. */
  const shaped = (sizes: string[]) =>
    Object.fromEntries(
      sizes.flatMap((size, i) => [
        [rowAsset('items', i, 'image'), `${size}: #4b86b4`],
        [rowAsset('items', i, 'image', 'thumb'), '480x270: #a0522d'],
      ]),
    );
  /** The frame on Playwright's clock, stepped by hand to ready and then played: no test time passes on its own. */
  async function clocked(data: Data, assets: Record<string, string>, durationMs: number) {
    const hst = await host('landscape', true);
    await hst.page.clock.install({ time: NOW });
    await hst.page.clock.pauseAt(NOW);
    await hst.open('fresh', t().html);
    await hst.init('fresh', spotData(t().manifest, data), assets, NOW, demo, false, durationMs);
    const ready = async () => (await hst.page.evaluate(() => (window as unknown as { msgs: Record<string, string[]> }).msgs.fresh!)).includes('ready');
    for (let i = 0; i < 500 && !(await ready()); i++) await hst.page.clock.runFor(16);
    return { hst, f: hst.frame('fresh') };
  }

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
        return hst.frame('fresh');
      },
    };
  }
  const settings: Data[] = Array.from({ length: 16 }, (_, bits) => Object.fromEntries(toggles.map((k, i) => [k, !(bits & (1 << i))])));
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
            for (const fault of await faults(f)) found.push(`${lead} lead photo, ${named(set)}: ${fault}`);
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
          for (const fault of await faults(f)) found.push(`${look}: ${fault}`);
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

  /** At `ms` into the play, all animations paused there: the story on top, the stories shown, and the column the bar is under. */
  const at_ = (f: Frame, ms: number) =>
    f.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
      const shown = [...document.querySelectorAll<HTMLElement>('.story')].filter((s) => getComputedStyle(s).opacity === '1');
      const bar = document.querySelector<HTMLElement>('.bar');
      const x = bar ? new DOMMatrix(getComputedStyle(bar).transform).m41 : undefined;
      const rows = [...document.querySelectorAll<HTMLElement>('.row')];
      return {
        lead: shown.at(-1)?.querySelector('.headline')?.textContent,
        shown: shown.length,
        marked: x === undefined ? undefined : rows.findIndex((row) => Math.abs(row.offsetLeft - x) < 1),
      };
    }, ms);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`turns the lead through the listed stories over the play, the bar under each as it comes on, ${orientation}`, async () => {
      const r = await frame(orientation);
      const items = Array.from({ length: 8 }, (_, i) => story(i));
      const rows = orientation === 'landscape' ? 5 : 4;
      for (const look of looks) {
        // 40 s at 8 s a story: five turns in landscape; the four listed stories in portrait, 10 s each.
        const f = await r.show({ look, items, rotationSeconds: 8 }, photos(8), demo, 40_000);
        const slot = 40_000 / rows;
        expect(await f.evaluate(() => document.querySelectorAll('.story').length), look).toBe(rows);
        for (let i = 0; i < rows; i++)
          expect(await at_(f, i * slot + slot / 2), `${look}, story ${i + 1}`).toEqual({ lead: items[i]!.title, shown: 1, marked: i });
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

  // Every shape a feed sends (NYT's 1800 square, The Guardian's 700x560, The Verge's 3:2), and shapes past them: the
  // photo is whole, at most 1.25 times its size and as large as its area holds within that, at the area's top and centred
  // across it, and beside or above the text, never under it.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`draws every photo shape whole, at most 1.25 times its size, beside the text, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const size of ['1920x1080', '1800x1800', '1920x1280', '700x560', '1080x1920', '2400x800', '320x240']) {
          const f = await r.show({ look, items: [story(0), story(1)] }, shaped([size, size]));
          const got = await f.evaluate(() => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = 3000;
            }
            const story = document.querySelector('.story')!;
            const img = story.querySelector<HTMLImageElement>('.photo')!;
            const p = img.getBoundingClientRect();
            const area = story.querySelector('.area')!.getBoundingClientRect();
            const text = story.querySelector('.text')!.getBoundingClientRect();
            const scale = p.width / img.naturalWidth;
            return {
              fit: getComputedStyle(img).objectFit,
              aspect: Math.abs(p.width / p.height / (img.naturalWidth / img.naturalHeight) - 1),
              scale,
              largest: Math.min(1.25, area.width / img.naturalWidth, area.height / img.naturalHeight),
              inside: p.left >= area.left - 1 && p.right <= area.right + 1 && p.top >= area.top - 1 && p.bottom <= area.bottom + 1,
              top: Math.abs(p.top - area.top),
              centred: Math.abs((p.left + p.right) / 2 - (area.left + area.right) / 2),
              underText: Math.min(p.right, text.right) - Math.max(p.left, text.left) > 0 && Math.min(p.bottom, text.bottom) - Math.max(p.top, text.top) > 0,
            };
          });
          const where = `${look}, ${size}`;
          if (got.fit !== 'contain' || got.aspect > 0.01) found.push(`${where}: cropped (${got.fit}, aspect off by ${got.aspect.toFixed(3)})`);
          if (got.scale > 1.251) found.push(`${where}: drawn at ${got.scale.toFixed(2)}x`);
          if (Math.abs(got.scale - got.largest) > 0.01) found.push(`${where}: drawn at ${got.scale.toFixed(2)}x where ${got.largest.toFixed(2)}x fits`);
          if (!got.inside || got.top > 1 || got.centred > 1) found.push(`${where}: not at the top and centre of its area`);
          if (got.underText) found.push(`${where}: under the text`);
          for (const fault of await faults(f)) found.push(`${where}: ${fault}`);
        }
      expect(found).toEqual([]);
    }, 300_000);

  // The headline hangs from one place in every story, whatever its photo's shape (design D's fixed anchor).
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`hangs every story's headline from the same place, whatever its photo, ${orientation}`, async () => {
      const r = await frame(orientation);
      for (const look of looks) {
        const f = await r.show(
          { look, items: [0, 1, 2, 3].map((i) => story(i)), rotationSeconds: 8 },
          shaped(['1920x1080', '1800x1800', '700x560', '1080x1920']),
          demo,
          32_000,
        );
        const at = await f.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.story .headline')].map((h) => {
            const story = h.closest<HTMLElement>('.story')!.getBoundingClientRect();
            const box = h.closest<HTMLElement>('.text')!.getBoundingClientRect();
            return `${Math.round(box.left - story.left)},${Math.round(h.offsetTop + box.top - story.top)}`;
          }),
        );
        expect(new Set(at).size, `${look}: ${at.join(' ')}`).toBe(1);
      }
    }, 120_000);

  it('shows every photo, some, or none, a story without one as a bigger headline across the width, and never decodes a photo switched off', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        images: document.documentElement.dataset.images,
        bare: [...document.querySelectorAll('.story')].map((s) => s.classList.contains('no-photo')),
        srcs: document.querySelectorAll('img[src]').length,
        sizes: [...document.querySelectorAll('.headline')].map((h) => Number.parseFloat(getComputedStyle(h).fontSize)),
        widths: [...document.querySelectorAll<HTMLElement>('.text')].map((t) => t.offsetWidth),
      }));
    const items = [story(0), story(1, { image: undefined, source: 'weather desk' }), story(2), story(3, { source: '' })];
    const all = await read(await r.show({ items, rotationSeconds: 8 }, photos(4, [1]), demo, 32_000));
    expect(all).toMatchObject({ images: 'on', bare: [false, true, false, false] });
    expect(all.sizes[1]).toBeGreaterThan(all.sizes[0]!);
    expect(all.widths[1]).toBeGreaterThan(all.widths[0]! * 1.5);
    // A photo whose blob never arrived plays as a story without one.
    expect(await read(await r.show({ items, rotationSeconds: 8 }, photos(4, [1, 3]), demo, 32_000))).toMatchObject({ bare: [false, true, false, true] });
    expect(await read(await r.show({ items, rotationSeconds: 8 }, {}, demo, 32_000))).toMatchObject({ images: 'off', bare: [true, true, true, true] });
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
          rows: [...document.querySelectorAll('.row')].map((row) => [row.querySelector('.number')!.textContent, row.querySelector('.rtitle')!.textContent]),
        };
      }),
    ).toEqual({
      headline: items[1]!.title,
      summary: 'First real story',
      src: 'Metro Desk',
      bare: true,
      rows: [
        ['1', items[1]!.title],
        ['2', items[2]!.title],
      ],
    });
  });

  it("drops a photo the browser cannot decode, the first in prepare and a later one in play, and fits that story's headline to the width from its title", async () => {
    const long = sentence.repeat(2).slice(0, 200).trim();
    const items = [0, 1, 2].map((i) => story(i, { title: long }));
    const { hst, f } = await clocked(
      { look: 'night', items, rotationSeconds: 8 },
      { ...photos(3), [rowAsset('items', 0, 'image')]: 'broken', [rowAsset('items', 1, 'image')]: 'broken' },
      24_000,
    );
    const stories = () =>
      f.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.story')].map(
          (s) => `${s.querySelector('.area') ? 'photo' : 'bare'} ${s.style.getPropertyValue('--fit')}: ${s.querySelector('.headline')!.textContent}`,
        ),
      );
    expect((await stories()).map((s) => s.split(' ')[0])).toEqual(['bare', 'photo', 'photo']);
    await hst.post('fresh', 'play');
    // The second story's photo loads at 5 s and fails; the third's at 13 s, and draws: run past both (review of #476).
    for (let i = 0; i < 140; i++) await hst.page.clock.runFor(100);
    await f.waitForFunction(() => !document.querySelectorAll('.story')[1]!.querySelector('.area'));
    await f.waitForFunction(() => document.querySelectorAll<HTMLElement>('.story')[2]!.style.getPropertyValue('--nw-photo-w') !== '');
    const [first, second, third] = await stories();
    // Refitted from its title, as the first was: not from the cut made beside the photo.
    expect(second).toBe(first);
    expect(third!.startsWith('photo')).toBe(true);
  });

  it('clears its timers in stop: a later photo the play would load is not loaded after the play stops (#477)', async () => {
    const { hst, f } = await clocked({ items: [0, 1, 2].map((i) => story(i)), rotationSeconds: 8 }, photos(3), 24_000);
    await hst.post('fresh', 'play');
    await hst.page.clock.runFor(1_000);
    await hst.post('fresh', 'stop');
    // The second story's photo would load at 5 s.
    for (let i = 0; i < 60; i++) await hst.page.clock.runFor(100);
    expect(await f.evaluate(() => [...document.querySelectorAll('.story .photo')].map((img) => img.hasAttribute('src')))).toEqual([true, false, false]);
  });

  // Review of #502: Night's large steps broke long words mid-word ("Thanksgivin / g"); a headline steps down instead.
  const longWords = 'Thanksgiving smartphones Cybersecurity manufacturing Representatives';
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`never breaks a word of a headline across lines, beside a photo or without one, in every look, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const bare of [false, true]) {
          const f = await r.show(
            { look, items: [0, 1].map((i) => story(i, { title: longWords, ...(bare ? { image: undefined } : {}) })) },
            photos(2, bare ? [0, 1] : []),
          );
          const split = await f.evaluate(() => {
            const h = document.querySelector<HTMLElement>('.story .headline')!;
            const range = document.createRange();
            return [...h.textContent!.matchAll(/\S+/g)].flatMap((word) => {
              range.setStart(h.firstChild!, word.index);
              range.setEnd(h.firstChild!, word.index + word[0].length);
              const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
              return tops.size > 1 ? [word[0]] : [];
            });
          });
          for (const word of split) found.push(`${look}${bare ? ', no photo' : ''}: ${word}`);
        }
      expect(found).toEqual([]);
    }, 120_000);

  // Review of #629: a line break after a hyphen or a dash, between CJK characters or in a URL is the browser's own
  // wrap, not a word broken; a headline that fits at the look's size keeps it.
  const fitting = [
    'Self-driving cars reach a state-of-the-art milestone',
    'Council votes—finally—on the riverside park',
    '東京都が川沿いの新しい公園の計画を発表しました',
    'Plans online now at nyt.com/x',
  ];
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`keeps a fitting headline with hyphens, dashes, CJK or a URL at the look's own size, beside a photo or without one, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const bare of [false, true])
          for (const title of fitting) {
            const f = await r.show(
              { look, items: [0, 1].map((i) => story(i, { title, ...(bare ? { image: undefined } : {}) })) },
              photos(2, bare ? [0, 1] : []),
            );
            const fit = await f.evaluate(() => document.querySelector<HTMLElement>('.story')!.style.getPropertyValue('--fit'));
            if (fit) found.push(`${look}${bare ? ', no photo' : ''}: ${title} at ${fit}`);
          }
      expect(found).toEqual([]);
    }, 240_000);

  // Review of #629: without a photo a headline starts larger, and has a step more, so a long one is cut no sooner than
  // 2.1 cut it. 2.1 showed this copy whole in every look but Night, which wraps wide: there it kept 23 words in
  // landscape and 19 in portrait, and keeps at least as many.
  const KEPT_IN_2_1 = { landscape: 23, portrait: 19 };
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`cuts a 165-character headline without a photo no sooner than 2.1, in every look, ${orientation}`, async () => {
      const r = await frame(orientation);
      const title = sentence.repeat(2).slice(0, 165).trim();
      const found: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, items: [0, 1].map((i) => story(i, { title, image: undefined })) }, photos(2, [0, 1]));
        const shown = (await f.evaluate(() => document.querySelector('.story .headline')!.textContent))!;
        const words = shown.replace(/…$/, '').trim().split(/\s+/).length;
        if (look === 'night' ? words < KEPT_IN_2_1[orientation] : shown !== title) found.push(`${look}: ${shown}`);
      }
      expect(found).toEqual([]);
    }, 120_000);

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
        ...[1, 2, 3, 4].map((i) => story(i, { title: `Pygmy yaks ${i}`, source: 'gypsy jay' })),
      ];
      const found: string[] = [];
      for (const look of looks)
        for (const bare of [false, true]) {
          // The first row's title is the lead's: a short one, so the strip's ellipsis cuts nothing.
          const f = await r.show({ look, items: [{ ...deep[0]!, title: 'Jumpy July yoga' }, ...deep.slice(1)] }, photos(5, bare ? [0] : []));
          await r.hst.post('fresh', 'play');
          await f.waitForFunction(() => getComputedStyle(document.getElementById('leads')!).visibility === 'visible');
          const clip = await f.evaluate(() => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = 4000;
            }
            // The photo square, in both shots: with a clip gone, Linux draws a few pixels of round corners some levels
            // apart (review of #492, round 3), and no text is clipped by them.
            const square = document.createElement('style');
            square.textContent = '.photo { border-radius: 0 !important; }';
            document.head.append(square);
            const b = document.querySelector('.stage')!.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
          });
          const clipped = await r.hst.page.screenshot({ clip });
          await f.evaluate(() => {
            const el = document.createElement('style');
            el.id = 'unclipped';
            el.textContent = '.headline, .rtitle, .summary, .meta, .src, .title { overflow: visible !important; }';
            document.head.append(el);
          });
          if (!(await r.hst.page.screenshot({ clip })).equals(clipped)) found.push(`${look}, ${bare ? 'bare lead' : 'photo lead'}`);
          await f.evaluate(() => document.getElementById('unclipped')!.remove());
        }
      expect(found).toEqual([]);
    }, 120_000);

  // A headline with nowhere to cut on a word (200 characters and no space) still keeps to its lines (review of #492).
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`keeps a headline with no spaces to its lines, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const lead of ['large', 'small', 'none'] as const) {
          const items = [story(0, { title: 'W'.repeat(200), ...(lead === 'none' ? { image: undefined } : {}) }), story(1)];
          const f = await r.show({ look, items }, photos(2, lead === 'none' ? [0] : [], lead === 'small' ? '700x560' : '1920x1080'));
          const lines = await f.evaluate(() => {
            const h = document.querySelector<HTMLElement>('.story .headline')!;
            const s = getComputedStyle(h);
            return {
              lines: Math.round(h.offsetHeight / Number.parseFloat(s.lineHeight)),
              max: Number(s.getPropertyValue('--nw-lines')),
              cut: h.textContent!.endsWith('…'),
            };
          });
          if (lines.lines > lines.max || !lines.cut)
            found.push(`${look}, ${lead} lead photo: ${lines.lines} lines of ${lines.max}${lines.cut ? '' : ', not cut'}`);
          for (const fault of await faults(f)) found.push(`${look}, ${lead} lead photo: ${fault}`);
        }
      expect(found).toEqual([]);
    }, 120_000);

  // Review of #492: the cut read each word's line from the balanced layout, and counted a word out once its glyph box
  // passed the lines, so a cut headline kept one line less than it holds.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`cuts a long headline with every line it holds filled, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      const long = sentence.repeat(2).slice(0, 200).trim();
      let cuts = 0;
      for (const look of looks)
        for (const lead of ['large', 'none'] as const) {
          const f = await r.show(
            { look, items: [story(0, { title: long, ...(lead === 'none' ? { image: undefined } : {}) }), story(1)] },
            photos(2, lead === 'none' ? [0] : []),
          );
          const got = await f.evaluate((full) => {
            const h = document.querySelector<HTMLElement>('.story .headline')!;
            const s = getComputedStyle(h);
            const line = Number.parseFloat(s.lineHeight);
            const max = Number(s.getPropertyValue('--nw-lines'));
            const cut = h.textContent!;
            const lines = Math.round(h.offsetHeight / line);
            // One word more, with its "…", takes a line more than the headline has: the cut kept all its lines hold.
            const kept = cut.slice(0, -1).trim().split(/\s+/).length;
            h.textContent = `${full
              .split(/\s+/)
              .slice(0, kept + 1)
              .join(' ')}…`;
            return { lines, max, cut: cut.endsWith('…'), full: h.offsetHeight > max * line + 1 };
          }, long);
          // 200 characters fit some looks' widest lines whole: only a cut is judged.
          if (!got.cut) continue;
          cuts++;
          if (got.lines !== got.max || !got.full)
            found.push(`${look}, ${lead} lead photo: ${got.lines} lines of ${got.max}${got.full ? '' : ', a word more fits'}`);
        }
      expect(found).toEqual([]);
      expect(cuts).toBeGreaterThan(4);
    }, 120_000);

  // Review of #492: a headline within its lines could still push the summary off its story: the text stays in its story
  // at every length, beside every photo shape.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`keeps a story's text inside it at every headline length, beside every photo shape, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks)
        for (const showList of [true, false])
          for (const size of ['1920x1080', '1800x1800', '700x560', 'none'])
            for (const length of [56, 80, 110, 135, 200]) {
              const title = sentence.repeat(2).slice(0, length).trim();
              const items = [story(0, { title, summary: sentence.repeat(3).slice(0, 240) }), story(1), story(2)];
              const f = await r.show({ look, showList, items }, size === 'none' ? {} : shaped([size, size, size]));
              for (const fault of await faults(f)) found.push(`${look}, list ${showList ? 'on' : 'off'}, ${size}, ${length} characters: ${fault}`);
            }
      expect(found).toEqual([]);
    }, 600_000);

  it('marks each toggle on the root and removes what is off, and what has nothing to show is off', async () => {
    const r = await frame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['images', 'summary', 'list', 'meta'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.area', '.summary', '.strip', '.meta'].filter((s) => document.querySelector(s)),
      }));
    const items = [0, 1, 2].map((i) => story(i));
    expect(await read(await r.show({ items }))).toEqual({
      marks: ['images=on', 'summary=on', 'list=on', 'meta=on'],
      present: ['.area', '.summary', '.strip', '.meta'],
    });
    expect(await read(await r.show({ items, ...Object.fromEntries(toggles.map((k) => [k, false])) }))).toEqual({
      marks: ['images=off', 'summary=off', 'list=off', 'meta=off'],
      present: [],
    });
    // One story is no strip; a story without a summary or a source and age has neither.
    expect(await read(await r.show({ items: [story(0, { summary: '', source: '', published: '' })] }))).toEqual({
      marks: ['images=on', 'summary=on', 'list=off', 'meta=on'],
      present: ['.area'],
    });
  });

  it('with no headlines, says so, with no strip', async () => {
    const r = await frame();
    const f = await r.show({ items: [] }, {});
    expect(
      await f.evaluate(() => ({
        lead: document.querySelector('.headline')!.textContent,
        present: ['.strip', '.area', '.meta', '.progress'].filter((s) => document.querySelector(s)),
      })),
    ).toEqual({ lead: 'No headlines yet', present: [] });
    expect(await faults(f)).toEqual([]);
  });

  // Review of #502: a live feed names itself ("NYT > Top Stories", "World news | The Guardian"); the spot's credit is
  // the name its owner chose, so it wins wherever it is set.
  it("names each story by the spot's credit where one is set, and by the feed's source where not", async () => {
    const r = await frame();
    const items = [story(0, { source: 'NYT > Top Stories' }), story(1, { source: 'NYT > Top Stories' })];
    const sources = async (data: Data) =>
      (await r.show({ items, rotationSeconds: 8, ...data }, photos(2), demo, 16_000)).evaluate(() =>
        [...document.querySelectorAll('.src')].map((s) => s.textContent),
      );
    expect(await sources({ source: 'The New York Times' })).toEqual(['The New York Times', 'The New York Times']);
    expect(await sources({ source: '' })).toEqual(['NYT > Top Stories', 'NYT > Top Stories']);
  });

  // Review of #502: Night's headline was a size below the others (6vmin), 5.2vmin at 80 characters. At the research's
  // 7vmin a headline is read from about 6 m; every look holds it to about 80 characters beside a photo.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`draws an 80-character headline beside a photo at 7vmin or more in every look, ${orientation}`, async () => {
      const r = await frame(orientation);
      const sizes: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, items: [story(0, { title: sentence.slice(0, 80).trim() }), story(1)] }, shaped(['1920x1280', '1920x1280']));
        const vmin = await f.evaluate(
          () => Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize) / (Math.min(innerWidth, innerHeight) / 100),
        );
        if (vmin < 6.99) sizes.push(`${look}: ${vmin.toFixed(2)}vmin`);
      }
      expect(sizes).toEqual([]);
    }, 120_000);

  // Review of #502: under a brand kit Poster's age took the accent and its bar the primary, two colours where the
  // design has one. Both take the accent (the age its readable ink), under no kit, the demo kit and a light kit.
  it("marks Poster's age and bar in the one accent under every kit", async () => {
    const r = await frame();
    for (const [kit, theme] of noDemoAndLight(LIGHT_KIT)) {
      const f = await r.show({ look: 'poster', items: [0, 1, 2].map((i) => story(i)), rotationSeconds: 8 }, photos(3), theme ?? null, 24_000);
      const got = await f.evaluate(() => {
        const probe = (v: string) => {
          const el = document.createElement('i');
          el.style.color = `var(${v})`;
          document.body.append(el);
          const c = getComputedStyle(el).color;
          el.remove();
          return c;
        };
        return {
          bar: getComputedStyle(document.querySelector('.bar')!).backgroundColor,
          progress: getComputedStyle(document.querySelector('.progress')!).backgroundColor,
          age: getComputedStyle(document.querySelector('.age')!).color,
          accent: probe('--lk-accent'),
          ink: probe('--lk-accent-ink'),
        };
      });
      expect({ bar: got.bar, progress: got.progress, age: got.age }, kit).toEqual({ bar: got.accent, progress: got.accent, age: got.ink });
    }
  });

  // Review of #502: in portrait a story without a photo has the whole lead, and fills it with a larger headline and
  // summary rather than leaving two thirds of the screen empty.
  it('fills the lead in portrait when a story has no photo, with a larger headline and summary', async () => {
    const r = await frame('portrait');
    for (const look of looks) {
      const f = await r.show(
        { look, items: [story(0), story(1, { image: undefined, summary: sentence.repeat(2).slice(0, 200) })], rotationSeconds: 8 },
        photos(2, [1]),
        demo,
        16_000,
      );
      const got = await f.evaluate(() => {
        const [photo, bare] = [...document.querySelectorAll<HTMLElement>('.story')];
        const px = (s: HTMLElement, sel: string) => Number.parseFloat(getComputedStyle(s.querySelector(sel)!).fontSize);
        const text = bare!.querySelector<HTMLElement>('.text')!;
        return {
          headline: px(bare!, '.headline') / px(photo!, '.headline'),
          summary: px(bare!, '.summary') / px(photo!, '.summary'),
          filled: (text.offsetTop + text.offsetHeight) / bare!.clientHeight,
        };
      });
      expect(got.headline, look).toBeGreaterThanOrEqual(1.59);
      expect(got.summary, look).toBeGreaterThanOrEqual(1.29);
      // Filling the lead, and within it.
      expect(got.filled, look).toBeGreaterThan(0.4);
      expect(got.filled, look).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  // #477: without a photo, the landscape headline at 1.25 times left the lead sparse; it is a step larger again.
  it('steps a landscape story without a photo up to 1.45 times the headline, within its lead', async () => {
    const r = await frame('landscape');
    for (const look of looks) {
      const f = await r.show({ look, items: [story(0), story(1, { image: undefined })], rotationSeconds: 8 }, photos(2, [1]), demo, 16_000);
      const got = await f.evaluate(() => {
        const [photo, bare] = [...document.querySelectorAll<HTMLElement>('.story')];
        const px = (s: HTMLElement, sel: string) => Number.parseFloat(getComputedStyle(s.querySelector(sel)!).fontSize);
        const text = bare!.querySelector<HTMLElement>('.text')!;
        return { headline: px(bare!, '.headline') / px(photo!, '.headline'), filled: (text.offsetTop + text.offsetHeight) / bare!.clientHeight };
      });
      expect(got.headline, look).toBeGreaterThanOrEqual(1.44);
      expect(got.filled, look).toBeLessThanOrEqual(1);
    }
  }, 120_000);

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

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`numbers the strip's stories by their place, one line each in landscape and numbers alone in portrait, the bar a column wide, ${orientation}`, async () => {
      const r = await frame(orientation);
      for (const look of looks) {
        const f = await r.show(
          { look, items: Array.from({ length: 8 }, (_, i) => story(i, { title: sentence.slice(0, 60 + i) })), rotationSeconds: 8 },
          photos(8),
          demo,
          40_000,
        );
        const strip = await f.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>('.row')];
          return {
            numbers: rows.map((r) => r.querySelector('.number')!.textContent),
            titles: rows.map((r) => {
              const t = r.querySelector<HTMLElement>('.rtitle')!;
              return getComputedStyle(t).display === 'none' ? 0 : Math.round(t.offsetHeight / Number.parseFloat(getComputedStyle(t).lineHeight));
            }),
            bar: document.querySelector<HTMLElement>('.bar')!.offsetWidth === rows[0]!.offsetWidth,
          };
        });
        const n = orientation === 'landscape' ? 5 : 4;
        expect(strip, look).toEqual({
          numbers: Array.from({ length: n }, (_, i) => String(i + 1)),
          titles: Array.from({ length: n }, () => (orientation === 'landscape' ? 1 : 0)),
          bar: true,
        });
      }
    }, 120_000);

  it('keeps the photos unpainted until play', async () => {
    const r = await frame();
    const f = await r.show({ items: [story(0), story(1)] });
    expect(await f.evaluate(() => getComputedStyle(document.getElementById('leads')!).visibility)).toBe('hidden');
    await r.hst.post('fresh', 'play');
    await f.waitForFunction(() => getComputedStyle(document.getElementById('leads')!).visibility === 'visible');
  });

  it("decodes only the first story's photo before ready, and loads each later one in play, three seconds before its turn", async () => {
    const { hst, f } = await clocked({ items: [0, 1, 2, 3, 4].map((i) => story(i)), rotationSeconds: 8 }, photos(5), 40_000);
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

  // Design D's motion (research.md for #476, Motion spec): at a story's change T, the old story's summary leaves first,
  // its source, age and headline with it, on the accelerating curve, and its photo dips to the ground; from T the new
  // photo settles in, then the source and age, the headline and the summary rise in on the decelerating curve; the bar
  // moves from T - 150 ms for 600 ms on the standard curve. The same in every look.
  const DEC = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
  const ACC = 'cubic-bezier(0.3, 0, 0.8, 0.15)';
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`changes stories on design D's timeline in every look, moving only transform and opacity, ${orientation}`, async () => {
      const r = await frame(orientation);
      const durationMs = 32_000;
      for (const look of looks) {
        const f = await r.show({ look, items: Array.from({ length: 4 }, (_, i) => story(i)), rotationSeconds: 8 }, photos(4), demo, durationMs);
        const seen = await motion(f, durationMs);
        expect({ props: seen.props, withinCap: seen.withinCap }, look).toEqual({ props: ['opacity', 'transform'], withinCap: true });
        // D's motion, read by seeking: a story's parts leave as it does, and the bar and progress show where the play is.
        expect(await motionContract(f, durationMs, { exits: '.story', progress: '.bar, .progress' }), look).toEqual([]);
        const timeline = await f.evaluate((durationMs) => {
          // Each animation as [start, length, curve], its curve the keyframes' (a CSS animation's timing function).
          const read = (el: Element) =>
            el
              .getAnimations()
              .map((a) => {
                const t = a.effect!.getTiming();
                return [Math.round(Number(t.delay)), Math.round(Number(t.duration)), (a.effect as KeyframeEffect).getKeyframes()[0]!.easing] as const;
              })
              .filter(([start]) => start < durationMs);
          const once = (sel: string) => read(document.querySelector(sel)!);
          return {
            stories: [...document.querySelectorAll('.story')].map((s) => ({
              photo: read(s.querySelector('.photo')!),
              meta: read(s.querySelector('.meta')!),
              headline: read(s.querySelector('.headline')!),
              summary: read(s.querySelector('.summary')!),
            })),
            top: once('.top'),
            strip: once('.strip'),
            stage: once('.stage'),
            progress: document
              .querySelector('.progress')!
              .getAnimations()
              .map((a) => [a.effect!.getTiming().duration, a.effect!.getTiming().iterations]),
          };
        }, durationMs);
        const slot = durationMs / 4;
        timeline.stories.forEach((s, i) => {
          const at = i ? i * slot : 150;
          const until = (i + 1) * slot;
          const last = i === 3;
          const out = (start: number, length: number) => (last ? [] : [[until - start, length, ACC]]);
          expect(s, `${look}, story ${i + 1}`).toEqual({
            photo: [[at, 600, DEC], ...out(300, 300)],
            meta: [[at + 100, 400, DEC], ...out(350, 300)],
            headline: [[at + 150, 650, DEC], ...out(350, 300)],
            summary: [[at + 300, 500, DEC], ...out(400, 300)],
          });
        });
        expect(timeline.top, look).toEqual([[0, 400, DEC]]);
        expect(timeline.strip, look).toEqual([[100, 500, DEC]]);
        // The spot's end: everything fades out together over its last 300 ms.
        expect(timeline.stage, look).toEqual([[durationMs - 300, 300, ACC]]);
        expect(timeline.progress, look).toEqual([[slot, 4]]);
      }
    }, 120_000);

  // Nothing overshoots (no bounce in any look): through a change, text only rises to its place and fades in, the photo
  // only settles from 1.03, and the bar only moves forward to the next column; the old text has gone before the new comes.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`overshoots nothing in a story's change, and the old text is gone before the new arrives, ${orientation}`, async () => {
      const r = await frame(orientation);
      const found: string[] = [];
      for (const look of looks) {
        const f = await r.show({ look, items: Array.from({ length: 2 }, (_, i) => story(i)), rotationSeconds: 8 }, photos(2), demo, 16_000);
        const trace = await f.evaluate(() => {
          const T = 8000;
          const [old, next] = [...document.querySelectorAll<HTMLElement>('.story')];
          const parts = ['.meta', '.headline', '.summary'];
          const bar = document.querySelector<HTMLElement>('.bar')!;
          const rows = [...document.querySelectorAll<HTMLElement>('.row')];
          const samples = [];
          for (let t = T - 400; t <= T + 1000; t += 10) {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = t;
            }
            const m = (el: Element) => new DOMMatrix(getComputedStyle(el).transform);
            samples.push({
              t,
              oldText: Math.max(...parts.map((p) => Number(getComputedStyle(old!.querySelector(p)!).opacity))),
              nextOn: Number(getComputedStyle(next!).opacity),
              y: parts.map((p) => m(next!.querySelector(p)!).m42),
              alpha: parts.map((p) => Number(getComputedStyle(next!.querySelector(p)!).opacity)),
              scale: m(next!.querySelector('.photo')!).a,
              bar: m(bar).m41,
            });
          }
          return { samples, from: rows[0]!.offsetLeft, to: rows[1]!.offsetLeft };
        });
        const { samples, from, to } = trace;
        for (const [i, s] of samples.entries()) {
          const prev = samples[i - 1];
          if (s.t >= 8000 - 50 && s.t < 8000 && s.oldText > 0.01) found.push(`${look}: old text still showing at T${s.t - 8000}`);
          if (s.y.some((y) => y < -0.01)) found.push(`${look}: text rises past its place at T+${s.t - 8000}`);
          if (s.scale < 0.999) found.push(`${look}: the photo shrinks past its size at T+${s.t - 8000}`);
          if (s.bar < Math.min(from, to) - 0.5 || s.bar > Math.max(from, to) + 0.5) found.push(`${look}: the bar runs past its columns at T${s.t - 8000}`);
          if (!prev || s.t <= 8000) continue;
          if (s.y.some((y, k) => y > prev.y[k]! + 0.01)) found.push(`${look}: text moves back down at T+${s.t - 8000}`);
          if (s.alpha.some((a, k) => a < prev.alpha[k]! - 0.001)) found.push(`${look}: text fades back at T+${s.t - 8000}`);
          if (s.scale > prev.scale + 0.0001) found.push(`${look}: the photo grows again at T+${s.t - 8000}`);
          if (Math.sign(to - from) * (s.bar - prev.bar) < -0.5) found.push(`${look}: the bar moves back at T+${s.t - 8000}`);
        }
        const end = samples.at(-1)!;
        if (end.bar !== to || end.y.some((y) => Math.abs(y) > 0.01) || end.alpha.some((a) => a < 0.999)) found.push(`${look}: not at rest at T+1000`);
      }
      expect([...new Set(found)]).toEqual([]);
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
