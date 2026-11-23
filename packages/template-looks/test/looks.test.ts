import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import type { Orientation } from '@signforge/contract';
import { host, LIGHT_KIT, noDemoAndLight, paintedContrast, screenFrame, spotData, useTemplate } from '@signforge/template-test';

const photo = { photo: '#808080' };
const t = useTemplate(new URL('../looks-test', import.meta.url), {
  a: { look: 'pop', showPhoto: false },
  b: { look: 'night', showCrawl: false },
  assetsA: photo,
  assetsB: photo,
  full: true,
});

describe('the look kit (#190)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  /** Each look's font families, as looks.css names them. */
  const faces: Record<(typeof looks)[number], string[]> = {
    pop: ['lk-pop', 'lk-body'],
    poster: ['lk-poster', 'lk-body'],
    night: ['lk-night', 'lk-night-mono', 'lk-body'],
    corporate: ['lk-corporate'],
  };
  const kits = noDemoAndLight(LIGHT_KIT);

  const kitFrame = (orientation: Orientation = 'landscape') => screenFrame(t(), orientation, photo);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const k = await kitFrame(orientation);
      const found: string[] = [];
      for (const [kit, theme] of kits)
        for (const look of looks)
          for (const shown of [true, false]) {
            const f = await k.play({ look, showPhoto: shown, showBody: shown }, theme);
            for (const l of await paintedContrast(k.hst.page, f, '.stage')) found.push(`${look}, ${kit}${shown ? '' : ', photo and body off'}: ${l}`);
          }
      expect(found).toEqual([]);
    }, 120_000);

  it('a look decodes only its own faces, and they are loaded by ready', async () => {
    for (const look of looks) {
      // A frame of its own: a screen loads every spot in a new frame, and a face stays loaded in its document.
      const f = await (await kitFrame()).play({ look });
      const status = await f.evaluate(() => [...document.fonts].map((ff) => [ff.family.replaceAll('"', ''), ff.status] as const));
      const loaded = [...new Set(status.filter(([, s]) => s !== 'unloaded').map(([family]) => family))].sort();
      expect(loaded, look).toEqual([...faces[look]].sort());
      expect(
        status.filter(([family, s]) => faces[look].includes(family) && s === 'loading'),
        look,
      ).toEqual([]);
    }
  });

  it('the accent keeps its colour where it reads and gives way to black or white where it does not', async () => {
    const k = await kitFrame();
    const seen: Record<string, string[]> = {};
    for (const [kit, theme] of kits) {
      const f = await k.play({ look: 'poster' }, theme);
      seen[kit] = await f.evaluate(() => ['.figure', '.figure-label', '.eyebrow'].map((s) => getComputedStyle(document.querySelector(s)!).color));
    }
    expect(seen).toEqual({
      // Poster's red as large text, its darker red as small text, ink on the red fill.
      'no kit': ['rgb(232, 64, 28)', 'rgb(194, 51, 15)', 'rgb(17, 17, 17)'],
      // The demo kit's orange reads on its dark background (6.71:1).
      'the demo kit': ['rgb(249, 115, 22)', 'rgb(249, 115, 22)', 'rgb(255, 255, 255)'],
      // Amber on white is 2.15:1: black, large and small.
      'a light kit': ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)'],
    });
  });

  it('marks each toggle on the root, removes what is off, and the layout reflows with the type stepped up', async () => {
    const k = await kitFrame();
    const measure = (f: Frame) =>
      f.evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 2000;
        const root = document.documentElement;
        const copy = document.querySelector('.copy')!;
        // Glyphs overhang a tight leading by a few pixels; text cut by a clamp overflows by a whole line (news's ellipsize).
        const clamped = [...document.querySelectorAll<HTMLElement>('.headline, .body, .figure-label')].filter(
          (el) => el.scrollHeight > el.clientHeight + Number.parseFloat(getComputedStyle(el).fontSize) / 2,
        );
        return {
          marks: ['eyebrow', 'body', 'meta', 'photo', 'crawl'].map((m) => `${m}=${root.getAttribute(`data-${m}`)}`),
          present: ['.eyebrow', '.body', '.meta', '.photo', '.ticker'].filter((s) => document.querySelector(s)),
          headline: Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize),
          copyWidth: copy.getBoundingClientRect().width,
          overflow: [...(copy.scrollHeight > copy.clientHeight + 1 ? ['.copy'] : []), ...clamped.map((el) => el.className)],
        };
      });
    for (const look of looks) {
      const on = await measure(await k.play({ look }));
      const off = await measure(await k.play({ look, showEyebrow: false, showBody: false, showMeta: false, showPhoto: false, showCrawl: false }));
      expect(on.marks, look).toEqual(['eyebrow=on', 'body=on', 'meta=on', 'photo=on', 'crawl=on']);
      expect(on.present, look).toEqual(['.eyebrow', '.body', '.meta', '.photo', '.ticker']);
      expect(off.marks, look).toEqual(['eyebrow=off', 'body=off', 'meta=off', 'photo=off', 'crawl=off']);
      expect(off.present, look).toEqual([]);
      expect(off.copyWidth, look).toBeGreaterThan(on.copyWidth * 1.5);
      const step = Number(await (await k.play({ look })).evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lk-step')));
      expect(off.headline / on.headline, look).toBeCloseTo(step, 2);
      expect([...on.overflow, ...off.overflow], look).toEqual([]);
    }
  });

  it('every element has an intro and, timed from --sf-duration, an outro, moving only transform and opacity', async () => {
    const k = await kitFrame();
    // Not 8 s, the stylesheet's fallback for --sf-duration: the outros must follow the play's own length.
    const durationMs = 11_000;
    for (const look of looks) {
      const f = await k.play({ look }, undefined, durationMs);
      const { props, ends } = await f.evaluate((durationMs) => {
        const props = new Set<string>();
        for (const a of document.getAnimations())
          for (const k of (a.effect as KeyframeEffect).getKeyframes())
            for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
        // The photo's own intro and outro, or in Poster the ink block's, which uncovers it and covers it again.
        const moving = ['.badge', '.live', '.rule', '.headline', '.body', '.facts', '.meta', '.tag', '.ticker', '.photo', '.cover'];
        const ends = moving.map((sel) => {
          const timed = document
            .querySelector(sel)!
            .getAnimations()
            .map((a) => a.effect!.getComputedTiming().endTime as number)
            .filter(Number.isFinite);
          return `${sel} ${timed
            .map(Math.round)
            .sort((a, b) => a - b)
            .map((ms) => (ms === durationMs ? 'outro at the end' : ms <= 2000 ? 'intro' : `${ms} ms`))
            .join(', ')}`;
        });
        return { props: [...props].sort(), ends };
      }, durationMs);
      expect(props, look).toEqual(['opacity', 'transform']);
      const both = (sel: string) => `${sel} intro, outro at the end`;
      const photo = look === 'poster' ? ['.photo ', both('.cover')] : [both('.photo'), '.cover '];
      expect(ends, look).toEqual([...['.badge', '.live', '.rule', '.headline', '.body', '.facts', '.meta', '.tag', '.ticker'].map(both), ...photo]);
    }
  });

  // A photo drifting across a portrait screen's width took the test template over 1% of frames
  // dropped on the Pi (spike/pi-perf/RESULTS.md, The look kit): still in portrait until one measures under.
  it('drifts the photo in landscape, and holds it still in portrait', async () => {
    const drifting: Record<string, number[]> = {};
    for (const orientation of ['landscape', 'portrait'] as const) {
      const k = await kitFrame(orientation);
      for (const look of looks) {
        const f = await k.play({ look });
        (drifting[orientation] ??= []).push(await f.evaluate(() => document.querySelector('.lk-drift')!.getAnimations().length));
      }
    }
    expect(drifting).toEqual({ landscape: [1, 1, 1, 1], portrait: [0, 0, 0, 0] });
  });

  it('with reduced motion, shows the final frame with nothing animating and the crawl cut to one line', async () => {
    const k = await kitFrame();
    await k.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    const long = 'Tours from 9 to 11 in the lobby · The roof terrace opens at noon · Bring your badge · Coffee and pastries all morning on the ground floor';
    for (const look of looks) {
      const f = await k.play({ look, crawl: long });
      await k.hst.post('fresh', 'play');
      const still = await f.evaluate(() => ({
        animations: document.getAnimations().length,
        moved: [...document.querySelectorAll<HTMLElement>('.stage *')]
          .filter((el) => !el.classList.contains('lk-cover'))
          .filter((el) => getComputedStyle(el).opacity !== '1' || getComputedStyle(el).transform !== 'none')
          .map((el) => el.className),
        crawl: [...document.querySelectorAll('#crawl > *')].map((el) => getComputedStyle(el).display),
        cut: (() => {
          const strip = document.getElementById('crawl')!;
          return getComputedStyle(strip).textOverflow === 'ellipsis' && strip.scrollWidth > strip.clientWidth;
        })(),
      }));
      expect(still, look).toEqual({ animations: 0, moved: [], crawl: ['inline', 'none'], cut: true });
    }
  });

  it("the crawl holds its text twice and slides by exactly one copy at the look's speed", async () => {
    const k = await kitFrame();
    for (const look of looks) {
      const f = await k.play({ look });
      const c = await f.evaluate(() => {
        const strip = document.getElementById('crawl')!;
        const [a, b] = [...strip.children] as HTMLElement[];
        const s = getComputedStyle(strip);
        return {
          copies: [a!.textContent === b!.textContent, b!.getAttribute('aria-hidden')],
          shift: Number.parseFloat(s.getPropertyValue('--lk-crawl-shift')),
          copyWidth: b!.getBoundingClientRect().left - a!.getBoundingClientRect().left,
          seconds: Number.parseFloat(s.getPropertyValue('--lk-crawl-s')),
          speed: Number.parseFloat(s.getPropertyValue('--lk-crawl-speed')),
        };
      });
      expect(c.copies, look).toEqual([true, 'true']);
      expect(c.shift, look).toBeCloseTo(-c.copyWidth, 0);
      // The frame is 1920x1080: 1vmin is 10.8 px.
      expect(c.copyWidth / c.seconds, look).toBeCloseTo(c.speed * 10.8, 1);
    }
  });
  // The SDK restores the document and inits again on new data, while the old prepare may still be
  // waiting in applyLook for the faces. Here the first prepare is held there until the new data has
  // played its own prepare: resuming must not touch the document that replaced it (#233).
  it('a prepare that new data replaced, resuming in applyLook, leaves the new document as a fresh load', async () => {
    const hst = await host('landscape', true);
    const a = spotData(t().manifest, { look: 'pop', crawl: 'The old crawl' });
    const b = spotData(t().manifest, { look: 'night', crawl: 'The new crawl' });
    await hst.open('fresh', t().html);
    await hst.init('fresh', b, photo);
    await hst.waitFor('fresh', 'ready', 1);
    const fresh = await hst.dom('fresh');
    for (const [name, index] of [
      ['reset', 1],
      ['again', 2],
    ] as const) {
      await hst.open(name, t().html);
      const f = hst.page.mainFrame().childFrames()[index]!;
      // The first read of `document.fonts.ready` is applyLook's, in the first prepare: it waits
      // there until the test lets it go, and says when it has got there.
      await f.evaluate(() => {
        const w = window as unknown as { held: Promise<void>; release: () => void };
        const ready = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, 'ready')!.get!;
        const gate = new Promise<void>((r) => (w.release = r));
        let arrived: () => void = () => {};
        w.held = new Promise((r) => (arrived = r));
        let reads = 0;
        Object.defineProperty(document.fonts, 'ready', {
          get(this: FontFaceSet) {
            if (reads++) return ready.call(this);
            arrived();
            return gate.then(() => ready.call(this));
          },
        });
      });
      await hst.init(name, a, photo);
      await f.evaluate(() => (window as unknown as { held: Promise<void> }).held);
      if (name === 'reset') {
        await hst.post(name, 'reset');
        await hst.waitFor(name, 'loaded', 2);
      }
      await hst.init(name, b, photo);
      await hst.waitFor(name, 'ready', 1);
      // Let the first prepare go, then wait a task: what it does next runs in microtasks before it.
      await f.evaluate(async () => {
        (window as unknown as { release: () => void }).release();
        await new Promise((r) => setTimeout(r));
      });
      expect(await hst.dom(name), name).toBe(fresh);
    }
  });
});
