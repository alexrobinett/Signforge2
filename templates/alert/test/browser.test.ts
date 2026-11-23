import { describe, expect, it } from 'vitest';
import type { Frame } from 'playwright';
import type { BrandColors, FrameTheme, Orientation } from '@signforge/contract';
import { DEMO_KIT, host, noDemoAndLight, NOW, paintedContrast, spotData, useTemplate, type Data } from '@signforge/template-test';

const t = useTemplate(new URL('..', import.meta.url), {
  a: { severity: 'warning', qrUrl: 'https://example.com/a', showIssuedBy: false },
  b: { severity: 'notice', showEndsAt: false },
});

describe('alert (#200)', () => {
  const severities = ['emergency', 'warning', 'advisory', 'notice'] as const;
  const light: BrandColors = { ...DEMO_KIT, background: '#ffffff', surface: '#f1f5f9', text: '#0f172a', muted: '#475569', accent: '#f59e0b' };
  const kits = noDemoAndLight(light);
  const qrUrl = 'https://example.com/updates';
  /** Each text field at its `maxLength`, in words of an ordinary length. */
  const long = (n: number) => 'Leave by the stairs and wait outside '.repeat(20).slice(0, n).trimEnd();
  const longCopy = () => {
    const fields = t().manifest.fields;
    const max = (f: string) => (fields[f] as { maxLength: number }).maxLength;
    return Object.fromEntries(['headline', 'instructions', 'issuedBy', 'endsAt', 'qrLabel'].map((f) => [f, long(max(f))]));
  };
  /** Every toggle state that changes the layout: all on, the QR code off, the foot line off, and all off. */
  const toggles: [string, Data][] = [
    ['all on', {}],
    ['QR off', { showQr: false }],
    ['issued-by and ends-at off', { showIssuedBy: false, showEndsAt: false }],
    ['all off', { showQr: false, showIssuedBy: false, showEndsAt: false }],
  ];

  async function alertFrame(orientation: Orientation = 'landscape') {
    const hst = await host(orientation, true);
    await hst.open('fresh', t().html);
    let inits = 0;
    return {
      hst,
      async play(data: Data, theme?: FrameTheme, durationMs?: number) {
        await hst.init('fresh', spotData(t().manifest, { qrUrl, ...data }), {}, NOW, theme, false, durationMs);
        await hst.waitFor('fresh', 'ready', ++inits);
        return hst.page.mainFrame().childFrames()[0]!;
      },
    };
  }

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every severity reads as painted, in its own colours whatever the kit, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      const found: string[] = [];
      const grounds: Record<string, string[]> = {};
      for (const [kit, theme] of kits)
        for (const severity of severities)
          for (const [state, over] of [toggles[0]!, toggles[3]!]) {
            const f = await k.play({ severity, ...over }, theme);
            for (const l of await paintedContrast(k.hst.page, f, '.stage')) found.push(`${severity}, ${kit}, ${state}: ${l}`);
            (grounds[kit] ??= []).push(await f.evaluate(() => getComputedStyle(document.querySelector('.stage')!).backgroundColor));
          }
      expect(found).toEqual([]);
      // A kit never recolours a severity.
      expect(grounds['the demo kit']).toEqual(grounds['no kit']);
      expect(grounds['a light kit']).toEqual(grounds['no kit']);
      expect([...new Set(grounds['no kit'])]).toEqual(['rgb(153, 27, 27)', 'rgb(245, 158, 11)', 'rgb(253, 224, 71)', 'rgb(30, 58, 138)']);
    }, 120_000);

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`every field at its longest fits, with nothing overlapping, in every toggle state, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      const found: string[] = [];
      for (const [copy, text] of [
        ['short copy', {}],
        ['long copy', longCopy()],
      ] as const)
        for (const [state, over] of toggles) {
          const f = await k.play({ ...text, ...over });
          const problems = await f.evaluate(() => {
            for (const a of document.getAnimations()) a.currentTime = 2000;
            const body = document.querySelector('.body')!;
            const out: string[] = [];
            if (body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth) out.push('the copy overflows');
            const box = body.getBoundingClientRect();
            // Each line box: the foot line's two parts are inline, and share a line.
            const parts = ['.headline', '.instructions', '.issued', '.ends', '.qr'].flatMap((sel) =>
              [...(document.querySelector(sel)?.getClientRects() ?? [])].map((r) => [sel, r] as const),
            );
            for (const [sel, r] of parts) if (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom) out.push(`${sel} outside`);
            for (const [i, [a, ra]] of parts.entries())
              for (const [b, rb] of parts.slice(i + 1))
                if (a !== b && ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) out.push(`${a} overlaps ${b}`);
            return out;
          });
          for (const p of problems) found.push(`${copy}, ${state}: ${p}`);
        }
      expect(found).toEqual([]);
    }, 120_000);

  it('marks each toggle on the root and removes what is off; without the QR code the type steps up', async () => {
    const k = await alertFrame();
    const read = (f: Frame) =>
      f.evaluate(() => ({
        marks: ['qr', 'issued-by', 'ends-at'].map((m) => `${m}=${document.documentElement.getAttribute(`data-${m}`)}`),
        present: ['.qr', '.issued', '.ends'].filter((s) => document.querySelector(s)),
        headline: Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize),
        qr: document.querySelector('#qr svg')?.getAttribute('aria-label'),
      }));
    const on = await read(await k.play({}));
    expect(on).toEqual({ marks: ['qr=on', 'issued-by=on', 'ends-at=on'], present: ['.qr', '.issued', '.ends'], headline: on.headline, qr: 'Scan for updates' });
    const off = await read(await k.play({ showQr: false, showIssuedBy: false, showEndsAt: false }));
    expect(off).toEqual({ marks: ['qr=off', 'issued-by=off', 'ends-at=off'], present: [], headline: off.headline, qr: undefined });
    expect(off.headline / on.headline).toBeCloseTo(1.12, 2);
    // No address, no code; no end, no "Ends at".
    expect((await read(await k.play({ qrUrl: '' }))).marks[0]).toBe('qr=off');
    expect((await read(await k.play({ endsAt: '' }))).marks[2]).toBe('ends-at=off');
  });

  it('steps the type down until long copy fits', async () => {
    const k = await alertFrame();
    const size = async (data: Data) => (await k.play(data)).evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize));
    expect(await size(longCopy())).toBeLessThan(await size({}));
  });

  it('emergency and warning drop in hard, advisory and notice fade, and only emergency pulses, at most once every 2 s', async () => {
    const k = await alertFrame();
    // Not the default 60 s: the outros must follow the play's own length.
    const durationMs = 20_000;
    const seen: Record<string, unknown> = {};
    for (const severity of severities) {
      const f = await k.play({ severity }, undefined, durationMs);
      seen[severity] = await f.evaluate((durationMs) => {
        const props = new Set<string>();
        const ambient: string[] = [];
        for (const a of document.getAnimations()) {
          const effect = a.effect as KeyframeEffect;
          for (const kf of effect.getKeyframes())
            for (const p of Object.keys(kf)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
          const t = effect.getComputedTiming();
          if (t.iterations === Number.POSITIVE_INFINITY) ambient.push(`${(effect.target as Element).getAttribute('class')} every ${t.duration} ms`);
        }
        const timed = (sel: string) =>
          document
            .querySelector(sel)!
            .getAnimations()
            .map(
              (a) => `${(a as CSSAnimation).animationName} ${Math.round(a.effect!.getComputedTiming().endTime as number) === durationMs ? 'outro' : 'intro'}`,
            );
        return {
          props: [...props].sort(),
          band: timed('.band'),
          outros: ['.band', '.icon', '.label', '.headline', '.instructions', '.meta', '.qr'].map((s) => timed(s).at(-1)),
          ambient: ambient.sort(),
        };
      }, durationMs);
    }
    const hard = (ambient: string[]) => ({
      props: ['opacity', 'transform'],
      band: ['alert-drop intro', 'alert-drop outro'],
      outros: ['alert-drop outro', 'alert-pop outro', 'alert-slide outro', 'alert-rise outro', 'alert-rise outro', 'alert-fade outro', 'alert-fade outro'],
      ambient,
    });
    const calm = {
      props: ['opacity', 'transform'],
      band: ['alert-fade intro', 'alert-fade outro'],
      outros: ['alert-fade outro', 'alert-fade outro', 'alert-fade outro', 'alert-soft outro', 'alert-soft outro', 'alert-fade outro', 'alert-fade outro'],
      ambient: [],
    };
    // 2000 ms a cycle is 0.5 Hz: one flash every 2 s, under WCAG 2.3.1's 3 a second.
    expect(seen).toEqual({ emergency: hard(['beat every 2000 ms', 'glow every 2000 ms']), warning: hard([]), advisory: calm, notice: calm });
  });

  it('with reduced motion, shows the final frame with nothing animating', async () => {
    const k = await alertFrame();
    await k.hst.page.emulateMedia({ reducedMotion: 'reduce' });
    for (const severity of severities) {
      const f = await k.play({ severity });
      await k.hst.post('fresh', 'play');
      const still = await f.evaluate(() => ({
        animations: document.getAnimations().length,
        moved: [...document.querySelectorAll<HTMLElement>('.stage *')]
          .filter((el) => !el.classList.contains('glow'))
          .filter((el) => getComputedStyle(el).opacity !== '1' || getComputedStyle(el).transform !== 'none')
          .map((el) => el.className),
      }));
      expect(still, severity).toEqual({ animations: 0, moved: [] });
    }
  });
});
