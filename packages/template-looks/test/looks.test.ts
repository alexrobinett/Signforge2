import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import type { Orientation } from '@signforge/contract';
import { host, LIGHT_KIT, motionContract, noDemoAndLight, paintedContrast, screenFrame, spotData, useTemplate } from '@signforge/template-test';

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
        const moving = ['.badge', '.live', '.rule', '.headline', '.body', '.facts', '.meta', '.tag', '.ticker', '.photo'];
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
      expect(ends, look).toEqual(['.badge', '.live', '.rule', '.headline', '.body', '.facts', '.meta', '.tag', '.ticker', '.photo'].map(both));
    }
  });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`moves as D does in every look, ${orientation}: in on the decelerating curve, out on its own accelerating one, at most 1.5vmin, no overshoot`, async () => {
      const k = await kitFrame(orientation);
      const durationMs = 11_000;
      const found: string[] = [];
      for (const look of looks)
        for (const line of await motionContract(await k.play({ look }, undefined, durationMs), durationMs)) found.push(`${look}: ${line}`);
      expect(found).toEqual([]);
    });

  it('motionContract: a centred element, a monotone multi-step entrance, a move on the standard curve and linear progress pass; the rest is named', async () => {
    const k = await kitFrame();
    const durationMs = 11_000;
    const f = await k.play({ look: 'corporate' }, undefined, durationMs);
    await f.evaluate(() => {
      const [dec, std] = ['cubic-bezier(0.05, 0.7, 0.1, 1)', 'cubic-bezier(0.2, 0, 0, 1)'];
      const style = document.createElement('style');
      style.textContent = `
        .t { position: absolute; left: 10vmin; top: 10vmin; width: 5vmin; height: 5vmin; }
        @keyframes t-centred { from { opacity: 0; transform: translate(-50%, -50%) translateY(1.5vmin); } }
        .t-centred { left: 50%; top: 50%; transform: translate(-50%, -50%); animation: t-centred .5s ${dec} both; }
        @keyframes t-steps { from { opacity: 0; transform: translateY(1.5vmin); } 40% { opacity: .7; transform: translateY(.5vmin); } }
        .t-steps { animation: t-steps .5s ${dec} both; }
        @keyframes t-clip { from { clip-path: inset(0 100% 0 0); } }
        .t-clip { animation: t-clip .5s ${dec} both; }
        @keyframes t-mask { from { mask-position: 100% 0; } }
        .t-mask { animation: t-mask .5s ${dec} both; }
        @keyframes t-over { from { opacity: 0; transform: scale(0.94); } }
        .t-over { animation: t-over .5s linear(0, 2.2, 1) both; }
        @keyframes t-early { to { opacity: 0; } }
        .t-early { animation: t-early .3s cubic-bezier(0.3, 0, 0.8, 0.15) 10.699s forwards; }
        .t-slide { transition: transform 2s linear; }
        @keyframes t-wobble { from { transform: rotate(-2deg); } to { transform: rotate(2deg); } }
        .t-wobble { animation: t-wobble 1s ${dec} 3s 3 alternate both; }
        @keyframes t-far { from { transform: translateX(40vmin); } }
        .t-far { animation: t-far .5s ${std} both; }
        @keyframes t-faint { from { opacity: 0.02; transform: translateX(20vmin); } }
        .t-faint { animation: t-faint .5s ${dec} both; }
        @keyframes t-linear-first { from { opacity: 0; transform: translateY(1.5vmin); animation-timing-function: linear; } 50% { opacity: .5; transform: translateY(.75vmin); } }
        .t-linear-first { animation: t-linear-first .5s ${dec} both; }
        .t-pseudo::before { content: ''; animation: t-nowhere .5s ${dec} both; }
        @keyframes t-linear-from { from { opacity: 0; transform: translateY(1.5vmin); animation-timing-function: linear; } }
        .t-linear-from { animation: t-linear-from .5s ${dec} both; }
        @keyframes t-flash { 50% { opacity: 0; } }
        .t-flash { animation: t-flash .1s steps(1, end) infinite; }
        @keyframes t-late-slide { from { transform: translateX(40vmin); } }
        .t-late-slide { animation: t-late-slide .5s ${std} 3s both; }
        @keyframes t-swell { to { transform: scale(1.1); } }
        .t-swell { animation: t-swell 11s linear both; }
        .t-story { position: absolute; inset: 0; pointer-events: none; }
        @keyframes t-gone { to { opacity: 0; } }
        .t-story .t-late-exit { animation: t-gone .3s cubic-bezier(0.3, 0, 0.8, 0.15) 5.7s forwards; }`;
      document.head.append(style);
      const add = (name: string) => document.body.appendChild(Object.assign(document.createElement('div'), { className: `t ${name}` }));
      for (const name of ['t-centred', 't-steps', 't-clip', 't-mask', 't-over', 't-early', 't-wobble', 't-far', 't-faint', 't-linear-first', 't-pseudo'])
        add(name);
      // Progress: a bar across most of the screen and a ring's half turn, linear over the play.
      add('t-bar').animate([{ transform: 'none' }, { transform: 'translateX(80vmin)' }], { duration: 11_000, fill: 'both' });
      add('t-ring').animate([{ transform: 'none' }, { transform: 'rotate(360deg)' }], { duration: 8000, fill: 'both' });
      // Progress that moves along two axes, grows to three times its size and runs back and forth.
      add('t-wild').animate([{ transform: 'none' }, { transform: 'translate(60vmin, 10vmin) scale(3)' }], {
        duration: 1000,
        iterations: 4,
        direction: 'alternate',
        fill: 'both',
      });
      for (const name of ['t-linear-from', 't-flash', 't-late-slide', 't-swell']) add(name);
      // A story that hides at 5 s, and a part of it that leaves a second later.
      const story = add('t-story');
      story.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1, delay: 4999, fill: 'forwards' });
      story.appendChild(Object.assign(document.createElement('div'), { className: 't t-late-exit' }));
      // A list marker's move, row to row through a middle keyframe; then one that passes its row and comes back.
      const move = { duration: 600, delay: 5000, easing: std, fill: 'both' } as const;
      add('t-marker').animate([{ transform: 'none' }, { transform: 'translateY(4vmin)' }, { transform: 'translateY(8vmin)' }], move);
      add('t-bounce').animate([{ transform: 'none' }, { transform: 'translateY(6vmin)', offset: 0.7 }, { transform: 'translateY(5vmin)' }], move);
      add('t-spin').animate(
        [
          { opacity: 0, transform: 'rotate(-8deg)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 500, easing: dec, fill: 'both' },
      );
      const slide = add('t-slide');
      getComputedStyle(slide).transform;
      slide.style.transform = 'translateX(2vmin)';
      // Held, so the transition is still there however long the next call takes to come.
      for (const a of slide.getAnimations()) a.pause();
      // A kit element with no exit: the shorthand must not turn `none` into an animation named after its fill mode.
      add('t-stays lk-text').style.setProperty('--lk-leave', 'none');
    });
    const found = await motionContract(f, durationMs, {
      progress: '.t-bar, .t-ring, .t-marker, .t-wild',
      loops: '.lk-crawl, .lk-ping, .t-flash',
      exits: '.t-story',
    });
    const of = (c: string) => found.filter((l) => l.startsWith(`div.t.${c} `)).map((l) => l.slice(`div.t.${c} `.length));
    expect(
      Object.fromEntries(
        [
          't-centred',
          't-steps',
          't-marker',
          't-bar',
          't-ring',
          't-clip',
          't-mask',
          't-over',
          't-bounce',
          't-spin',
          't-slide',
          't-early',
          't-wobble',
          't-far',
          't-faint',
          't-linear-first',
          't-linear-from',
          't-wild',
          't-flash',
          't-late-slide',
          't-swell',
          't-late-exit',
        ].map((c) => [c, of(c)]),
      ),
    ).toEqual({
      't-centred': [],
      't-steps': [],
      't-marker': [],
      't-bar': [],
      't-ring': [],
      't-clip': expect.arrayContaining(['t-clip moves clipPath']),
      't-mask': expect.arrayContaining([expect.stringMatching(/^t-mask moves (webkitM|m)askPosition/)]),
      't-over': expect.arrayContaining(['t-over overshoots in sx', 't-over scales to 1.07']),
      't-bounce': expect.arrayContaining(['script animation overshoots in y', 'script animation travels 5.9vmin']),
      't-spin': ['script animation rotates'],
      't-slide': ['transition of transform arrives in 2000 ms', 'transition of transform arrives on linear', 'transition of transform travels 2.0vmin'],
      't-early': ['t-early leaves at 10999 ms, not as the spot ends at 11000'],
      't-wobble': expect.arrayContaining(['t-wobble runs 3 times', 't-wobble rotates']),
      't-far': expect.arrayContaining(['t-far travels 40.0vmin']),
      't-faint': ['t-faint travels 20.0vmin'],
      't-linear-first': [expect.stringMatching(/^t-linear-first arrives on linear then cubic-bezier/)],
      't-linear-from': ['t-linear-from arrives on linear'],
      't-wild': [
        'script animation runs back and forth',
        'script animation shows progress along x and y and sx and sy',
        'script animation shows progress past full size',
      ],
      't-flash': [expect.stringMatching(/^t-flash flashes (9|10) times in a second$/), 't-flash flashes from 0.00 to 1.00 opacity'],
      't-late-slide': ['t-late-slide travels 40.0vmin'],
      't-swell': expect.arrayContaining(['t-swell scales to 1.10']),
      't-late-exit': ['t-gone leaves at 6000 ms, after div.t.t-story hides at 5000'],
    });
    expect(found).toContain('t t-pseudo::before t-nowhere: no such keyframes');
    expect(found.filter((l) => l.startsWith('t t-stays'))).toEqual([]);
  });

  it('motionContract counts flashes, bounds loops that shrink, adds up moves and progress, and reads what ran early (#552)', async () => {
    const k = await kitFrame();
    const durationMs = 11_000;
    const f = await k.play({ look: 'corporate' }, undefined, durationMs);
    await f.evaluate(() => {
      const [dec, acc, std] = ['cubic-bezier(0.05, 0.7, 0.1, 1)', 'cubic-bezier(0.3, 0, 0.8, 0.15)', 'cubic-bezier(0.2, 0, 0, 1)'];
      // Twenty-four dips to 0.3 in a 2.4 s loop: ten a second, between the old 25 samples.
      const dips = Array.from({ length: 48 }, (_, i) => `${((i + 1) * 100) / 49}% { opacity: ${i % 2 ? 1 : 0.3}; }`).join(' ');
      const style = document.createElement('style');
      style.textContent = `
        .q { position: absolute; left: 10vmin; top: 10vmin; width: 5vmin; height: 5vmin; }
        @keyframes q-five { 0%, 20%, 40%, 60%, 80%, 100% { opacity: 1; } 10%, 30%, 50%, 70%, 90% { opacity: 0.3; } }
        .q-five { animation: q-five 0.5s linear infinite; }
        @keyframes q-hidden { ${dips} }
        .q-hidden { animation: q-hidden 2.4s linear infinite; }
        @keyframes q-shrink { 50% { transform: scale(0); } }
        .q-shrink { animation: q-shrink 0.1s linear infinite; }
        @keyframes q-in { from { opacity: 0; } }
        @keyframes q-out { to { opacity: 0; animation-timing-function: ${acc}; } }
        .q-curve { animation: q-in 0.5s ${dec} both, q-out 0.3s linear 10.7s forwards; }
        @keyframes q-late { from { opacity: 0; transform: translateY(30vmin); } }
        .q-late { animation: q-late 0.5s ${dec} 20s both; }
        .q-holder { position: absolute; inset: 0; pointer-events: none; }
        @keyframes q-gone { to { opacity: 0; } }
        .q-holder .q-part { animation: q-gone 0.3s ${acc} 5.7s forwards; }
        @keyframes q-blip { from { opacity: 0; } }
        .q-blip { animation: q-blip 0.5s ${dec}; }`;
      document.head.append(style);
      const add = (name: string, parent: Element = document.body) =>
        parent.appendChild(Object.assign(document.createElement('div'), { className: `q ${name}` }));
      for (const name of ['q-five', 'q-hidden', 'q-shrink', 'q-curve', 'q-late']) add(name);
      // Progress flashing: opacity 0 to 1 in 100 ms, a hundred times over.
      add('q-progress').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, iterations: 100, fill: 'both' });
      // Three 1.5vmin moves mid-play, stacked on one element.
      const stack = add('q-stack');
      for (const at of [3000, 4000, 5000])
        stack.animate([{ transform: 'none' }, { transform: 'translateY(1.5vmin)' }], {
          duration: 400,
          delay: at,
          easing: std,
          fill: 'forwards',
          composite: 'add',
        });
      // Progress out, then back, written as two animations.
      const back = add('q-back');
      back.animate([{ transform: 'none' }, { transform: 'translateX(10vmin)' }], { duration: 1000, delay: 3000, fill: 'both' });
      back.animate([{ transform: 'translateX(10vmin)' }, { transform: 'none' }], { duration: 1000, delay: 5000, fill: 'forwards' });
      // A holder with no animation that hides it, and a part that leaves mid-play.
      add('q-part', add('q-holder'));
      // An animation that has run and kept no fill, so it is gone from the document's list.
      for (const a of add('q-blip').getAnimations()) a.finish();
    });
    const found = await motionContract(f, durationMs, {
      loops: '.lk-crawl, .lk-ping, .q-five, .q-hidden, .q-shrink',
      progress: '.q-progress, .q-back',
      exits: '.q-holder',
    });
    const of = (c: string) => found.filter((l) => l.startsWith(`div.q.${c} `)).map((l) => l.slice(`div.q.${c} `.length));
    expect(
      Object.fromEntries(['q-five', 'q-hidden', 'q-shrink', 'q-progress', 'q-stack', 'q-back', 'q-curve', 'q-late', 'q-part', 'q-blip'].map((c) => [c, of(c)])),
    ).toEqual({
      'q-five': [expect.stringMatching(/^q-five flashes (9|10) times in a second$/)],
      'q-hidden': [expect.stringMatching(/^q-hidden flashes (9|10) times in a second$/)],
      'q-shrink': [expect.stringMatching(/^q-shrink flashes (9|10) times in a second$/)],
      'q-progress': [expect.stringMatching(/^script animation flashes (9|10) times in a second$/)],
      'q-stack': ['moves 4.5vmin mid-play in all'],
      'q-back': ['shows progress both ways along x'],
      'q-curve': ['q-out leaves on linear'],
      'q-late': ['q-late travels 30.0vmin'],
      'q-part': ['q-gone leaves at 6000 ms, not as the spot ends at 11000'],
      'q-blip': ['q-blip ran and kept no fill, so it was not read'],
    });
  });

  // A photo drifting across a portrait screen's width took the test template over 1% of frames
  // dropped on the Pi (spike/pi-perf/RESULTS.md, The look kit): still in portrait until one measures under.
  // Held still, it keeps no layer of its own either.
  it('drifts the photo in landscape, and holds it still in portrait', async () => {
    const drifting: Record<string, string[]> = {};
    for (const orientation of ['landscape', 'portrait'] as const) {
      const k = await kitFrame(orientation);
      for (const look of looks) {
        const f = await k.play({ look });
        (drifting[orientation] ??= []).push(
          await f.evaluate(() => {
            const drift = document.querySelector('.lk-drift')!;
            return `${drift.getAnimations().length} ${getComputedStyle(drift).willChange}`;
          }),
        );
      }
    }
    expect(drifting).toEqual({ landscape: Array(4).fill('1 transform'), portrait: Array(4).fill('0 auto') });
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
    for (const name of ['reset', 'again'] as const) {
      // The first read of `document.fonts.ready` is applyLook's, in the first prepare: it waits
      // there until the test lets it go, and says when it has got there.
      await hst.open(name, t().html, () => {
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
      await hst.waitFor(name, 'loaded', 1);
      const f = hst.frame(name);
      await f.evaluate(() => (window as unknown as { held: Promise<void> }).held);
      // With a reset between, as the editor sends new data; and with none, which the SDK takes the same way.
      await (name === 'reset' ? hst.init : hst.initAgain)(name, b, photo);
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
