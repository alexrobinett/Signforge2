import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import { LIGHT_KIT, motionContract, noDemoAndLight, paintedContrast, screenFrame, useTemplate, type Data } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { look: 'pop', showFacts: false },
  b: { look: 'night', qrUrl: 'https://example.com/plan', facts: [{ label: 'When', value: 'Monday' }] },
  assetsA: { photo: '#963' },
  assetsB: { photo: '#369' },
});

describe('announcement (#197)', () => {
  const looks = ['pop', 'poster', 'night', 'corporate'] as const;
  const kits = noDemoAndLight(LIGHT_KIT);
  const demo = kits[1]![1];
  const photo = { photo: '#808080' };
  const qrUrl = 'https://example.com/floor-plan';
  /** Every element on: a QR address and three facts, which the template's defaults leave empty (no board but Corporate's has facts). */
  const everything: Data = {
    qrUrl,
    facts: [
      { label: 'Date', value: 'Monday 7 December' },
      { label: 'Tours', value: '9 to 11 am' },
      { label: 'Where', value: 'Pier 9, lobby' },
    ],
  };
  /** The kit's logo: only a kit with one shows it. */
  const logo = '#ff00ff';
  /** Wide words, `n` characters: copy at a field's `maxLength`. */
  const words = (n: number) => 'Wwwwwww Wwwww '.repeat(30).slice(0, n);
  const long: Data = {
    eyebrow: 'W'.repeat(24),
    headline: words(80),
    body: words(280),
    meta: words(48),
    qrLabel: words(40),
    qrUrl: `https://example.com/${'w'.repeat(80)}`,
    facts: [1, 2, 3].map(() => ({ label: 'W'.repeat(16), value: words(32) })),
  };
  const toggles = ['Photo', 'Qr', 'Eyebrow', 'Body', 'Meta', 'Facts', 'Logo'];
  const allOff: Data = Object.fromEntries(toggles.map((n) => [`show${n}`, false]));
  /** Each toggle off alone, all off, and long copy (one unbroken word too) with the photo and without. */
  const variants: [string, Data][] = [
    ['all on', {}],
    ['long copy', long],
    ['long copy, photo off', { ...long, showPhoto: false }],
    ['an 80-letter word', { headline: 'W'.repeat(80) }],
    ...toggles.map((n): [string, Data] => [`${n.toLowerCase()} off`, { [`show${n}`]: false }]),
    ['all off', allOff],
    ['all off, long headline', { ...allOff, headline: long.headline }],
  ];

  /**
   * What is wrong with the layout at rest: a block with no size or off the screen, two blocks overlapping, text cut
   * sideways without an ellipsis, or clamped text showing more lines than its clamp.
   */
  const layoutProblems = (f: Frame) =>
    f.evaluate(() => {
      for (const a of document.getAnimations()) a.currentTime = 3000;
      const out: string[] = [];
      const blocks = ['.eyebrow', '.logo', '.headline-box', '.body', '.facts', '.qr', '.meta', '.photo'].flatMap((sel) => {
        const el = document.querySelector(sel);
        return el ? [[sel, el.getBoundingClientRect()] as const] : [];
      });
      for (const [sel, r] of blocks) {
        if (r.width < 1 || r.height < 1) out.push(`${sel} has no size`);
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(`${sel} leaves the screen`);
      }
      for (const [i, [a, ra]] of blocks.entries())
        for (const [b, rb] of blocks.slice(i + 1)) {
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 1 && h > 1) out.push(`${a} overlaps ${b}`);
        }
      for (const el of document.querySelectorAll<HTMLElement>('.stage :is(.pill, .headline, .body, dt, dd, .qr-label, .meta-in)')) {
        const s = getComputedStyle(el);
        const name = el.className || el.tagName;
        // By the glyphs' boxes: a space hanging past a right-aligned line's end widens scrollWidth but shows nothing.
        const text = document.createRange();
        text.selectNodeContents(el);
        const [g, box] = [text.getBoundingClientRect(), el.getBoundingClientRect()];
        if ((g.left < box.left - 1 || g.right > box.right + 1) && s.textOverflow !== 'ellipsis') out.push(`${name} is cut sideways`);
        const clamp = Number(s.getPropertyValue('-webkit-line-clamp'));
        const room = clamp * Number.parseFloat(s.lineHeight) + Number.parseFloat(s.paddingTop) + Number.parseFloat(s.paddingBottom);
        if (clamp && el.clientHeight > room + 1) out.push(`${name} shows more than its ${clamp} lines`);
      }
      return out;
    });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`nothing leaves the screen, overlaps or overflows its clamp, in every look and toggle, with long copy, ${orientation}`, async () => {
      const k = await screenFrame(t(), orientation, photo);
      const found: string[] = [];
      for (const look of looks)
        for (const [variant, data] of variants) {
          const f = await k.play({ look, ...everything, ...data }, demo, undefined, logo);
          for (const p of await layoutProblems(f)) found.push(`${look}, ${variant}: ${p}`);
        }
      expect(found).toEqual([]);
    }, 180_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every text reads as painted in every look, with no kit, the demo kit and a light kit, ${orientation}`, async () => {
      const k = await screenFrame(t(), orientation, photo);
      const found: string[] = [];
      for (const [kit, theme] of kits)
        for (const look of looks)
          for (const [variant, data] of [variants[0]!, ['photo and body off', { showPhoto: false, showBody: false }]] as const) {
            const f = await k.play({ look, ...everything, ...data }, theme, undefined, logo);
            for (const l of await paintedContrast(k.hst.page, f, '.stage')) found.push(`${look}, ${kit}, ${variant}: ${l}`);
          }
      expect(found).toEqual([]);
    }, 180_000);

  it('marks each toggle on the root and removes what is off; the type steps up without the photo and the footer closes up without the QR code', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    const measure = (f: Frame) =>
      f.evaluate(() => {
        for (const a of document.getAnimations()) a.currentTime = 3000;
        const root = document.documentElement;
        const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
        return {
          marks: ['photo', 'qr', 'eyebrow', 'body', 'meta', 'facts', 'logo'].map((m) => `${m}=${root.getAttribute(`data-${m}`)}`),
          present: ['.photo', '.qr', '.eyebrow', '.body', '.meta', '.facts', '.logo'].filter((s) => document.querySelector(s)),
          headline: Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize),
          headlineWidth: document.querySelector('.headline-box')!.getBoundingClientRect().width,
          footerTop: Math.min(top('.qr'), top('.meta')),
        };
      });
    for (const look of looks) {
      const on = await measure(await k.play({ look, ...everything }, demo, undefined, logo));
      expect(on.marks, look).toEqual(['photo=on', 'qr=on', 'eyebrow=on', 'body=on', 'meta=on', 'facts=on', 'logo=on']);
      expect(on.present, look).toEqual(['.photo', '.qr', '.eyebrow', '.body', '.meta', '.facts', '.logo']);
      const off = await measure(await k.play({ look, ...everything, ...allOff }, demo, undefined, logo));
      expect(off.marks, look).toEqual(['photo=off', 'qr=off', 'eyebrow=off', 'body=off', 'meta=off', 'facts=off', 'logo=off']);
      expect(off.present, look).toEqual([]);
      expect((await measure(await k.play({ look, ...everything, showPhoto: false }))).headline, look).toBeGreaterThan(on.headline);
      const noQr = await measure(await k.play({ look, ...everything, showQr: false }, demo, undefined, logo));
      // Night's code stands beside the headline, which takes its width; the others' sits in the footer, which closes up to the meta line.
      if (look === 'night') expect(noQr.headlineWidth, look).toBeGreaterThan(on.headlineWidth);
      else expect(noQr.footerTop, look).toBeGreaterThan(on.footerTop);
    }
  });

  // #342: the stage reported "not ready" for this spot; the template was never the cause (the stage was out of view).
  it('is ready with its photo off and none chosen, in every look, and shows no photo', async () => {
    const k = await screenFrame(t(), 'landscape', {});
    for (const look of looks) {
      const f = await k.play({ look, showPhoto: false });
      expect(await f.evaluate(() => [document.documentElement.getAttribute('data-photo'), document.querySelector('.photo')]), look).toEqual(['off', null]);
    }
  });

  it('leaves out what has nothing to show: no QR address, no logo in the kit, no facts, an empty line', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    for (const look of looks) {
      const f = await k.play({ look, qrUrl: '', facts: [], eyebrow: '', body: '', meta: '' });
      const left = await f.evaluate(() => ({
        marks: ['qr', 'eyebrow', 'body', 'meta', 'facts', 'logo'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.qr', '.eyebrow', '.body', '.meta', '.facts', '.logo'].filter((s) => document.querySelector(s)),
      }));
      expect(left, look).toEqual({ marks: ['qr=off', 'eyebrow=off', 'body=off', 'meta=off', 'facts=off', 'logo=off'], present: [] });
    }
  });

  // The defaults at the look's own sizes: no step of the long-copy fitting, which costs a Pi a layout pass each.
  it("plays the template's defaults, with a photo and a QR code, at the look's own type sizes in every look and orientation", async () => {
    const steps: string[] = [];
    for (const orientation of ['landscape', 'portrait'] as const) {
      const k = await screenFrame(t(), orientation, photo);
      for (const look of looks) {
        const f = await k.play({ look, qrUrl });
        steps.push(
          `${look}, ${orientation}: ${await f.evaluate(() => getComputedStyle(document.querySelector('.copy')!).getPropertyValue('--fit-headline').trim())}`,
        );
      }
    }
    expect(steps).toEqual(['landscape', 'portrait'].flatMap((o) => looks.map((l) => `${l}, ${o}: 1`)));
  });

  // The code is black on white whatever the kit, as its fills show in every kit, so it is read back once per look and
  // orientation, under no kit: reading it under every kit took 123 s on CI (run 45109076539).
  it('the QR code is at least 30vmin, dark on white with its quiet zone in every look and kit, and reads back at that size as a 100-character address', async () => {
    expect(long.qrUrl).toHaveLength(100);
    for (const orientation of ['landscape', 'portrait'] as const) {
      const k = await screenFrame(t(), orientation, photo);
      for (const [kit, theme] of kits)
        for (const look of looks) {
          const f = await k.play({ look, qrUrl: long.qrUrl }, theme);
          const { fills, clip, vmin } = await f.evaluate(() => {
            for (const a of document.getAnimations()) a.currentTime = 3000;
            const svg = document.querySelector('#qr svg')!;
            const r = svg.getBoundingClientRect();
            return {
              fills: [getComputedStyle(svg.querySelector('rect')!).fill, getComputedStyle(svg.querySelector('path')!).fill],
              clip: { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) },
              vmin: r.width / (Math.min(innerWidth, innerHeight) / 100),
            };
          });
          expect(vmin, `${look}, ${kit}, ${orientation}`).toBeGreaterThanOrEqual(29.9);
          expect(fills, `${look}, ${kit}`).toEqual(['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
          if (kit !== 'no kit') continue;
          const png = (await k.hst.page.screenshot({ clip })).toString('base64');
          const rgba = await k.hst.page.evaluate(async (png) => {
            const img = new Image();
            img.src = `data:image/png;base64,${png}`;
            await img.decode();
            const g = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
            g.drawImage(img, 0, 0);
            return [...g.getImageData(0, 0, img.width, img.height).data];
          }, png);
          expect(jsQR(Uint8ClampedArray.from(rgba), clip.width, clip.height)?.data, `${look}, ${kit}, ${orientation}`).toBe(long.qrUrl);
        }
    }
  }, 120_000);

  it('every element has an intro and, timed from --sf-duration, an outro; only transform and opacity move, on fewer than 50 elements', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    const durationMs = 11_000;
    for (const look of looks) {
      const f = await k.play({ look, ...everything }, demo, durationMs, logo);
      // D's motion, read by seeking.
      expect(await motionContract(f, durationMs), look).toEqual([]);
      const m = await f.evaluate((durationMs) => {
        const props = new Set<string>();
        for (const a of document.getAnimations())
          for (const k of (a.effect as KeyframeEffect).getKeyframes())
            for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
        // Shown, and given a motion by the look.
        const moving = [...document.querySelectorAll<HTMLElement>('.lk-text, .lk-fade, .lk-badge, .lk-photo, .lk-draw')].filter(
          (el) => el.getClientRects().length && getComputedStyle(el).getPropertyValue('--lk-motion').trim() !== 'none',
        );
        const unmatched = moving.flatMap((el) => {
          const ends = el
            .getAnimations()
            .map((a) => Math.round(a.effect!.getComputedTiming().endTime as number))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
          return ends.length === 2 && ends[0]! <= 2000 && ends[1] === durationMs ? [] : [`${el.className}: ${ends.join(', ')}`];
        });
        return {
          props: [...props].sort(),
          unmatched,
          moving: moving.length,
          animated: new Set(document.getAnimations().map((a) => (a.effect as KeyframeEffect).target)).size,
        };
      }, durationMs);
      expect(m.props, look).toEqual(['opacity', 'transform']);
      expect(m.unmatched, look).toEqual([]);
      expect(m.moving, look).toBeGreaterThanOrEqual(10);
      expect(m.animated, look).toBeLessThanOrEqual(50);
    }
  });

  it('with reduced motion, shows the final frame with nothing animating', async () => {
    const k = await screenFrame(t(), 'landscape', photo);
    await k.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const look of looks) {
      const f = await k.play({ look, ...everything }, demo, undefined, logo);
      await k.hst.post('fresh', 'play');
      const still = await f.evaluate(() => ({
        animations: document.getAnimations().length,
        hidden: [...document.querySelectorAll<HTMLElement>('.stage *')].filter((el) => getComputedStyle(el).opacity !== '1').map((el) => el.className),
      }));
      expect(still, look).toEqual({ animations: 0, hidden: [] });
    }
  });
});
