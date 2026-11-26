import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import type { Frame, Page } from 'playwright';
import type { BrandColors, FrameTheme, Orientation } from '@signforge/contract';
import { validateSpotData } from '@signforge/contract';
import { DEMO_KIT, host, motionContract, noDemoAndLight, NOW, paintedContrast, spotData, useTemplate, type Data } from '@signforge/template-test';

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
  /**
   * Every text field at its `maxLength` in the widest copy there is (review of #448, round 2): words of nine W's, or
   * Japanese, which breaks between any two characters. The limits are set so this fits at the smallest step.
   */
  const widest = {
    W: (n: number) => 'WWWWWWWWW '.repeat(60).slice(0, n).trimEnd(),
    CJK: (n: number) => '避難経路と集合場所の最新情報はこのコードをスキャンしてください'.repeat(20).slice(0, n),
  };
  const worstCopy = (script: keyof typeof widest) => {
    const fields = t().manifest.fields;
    const max = (f: string) => (fields[f] as { maxLength: number }).maxLength;
    return Object.fromEntries(['headline', 'instructions', 'issuedBy', 'endsAt', 'qrLabel'].map((f) => [f, widest[script](max(f))]));
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
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = 2000;
            }
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

  // A 2 m scan on a 55-inch 1080p panel (#230): the Announcement's code reads there at 30vmin with 41 modules, about 6.6 px
  // each, so the longest link Alert allows must be drawn at least that large, beside the longest copy, and read back. A QR
  // code holds bytes: the limit is in bytes of UTF-8, so a link in Japanese at it is as dense as one in ASCII (review of #448).
  const QR_BYTES = 213;
  const longestLinks = [`https://example.com/${'w'.repeat(193)}`, `https://example.com/w${'避難案内'.repeat(16)}`];

  it('allows a QR link of 213 bytes, ASCII or not, and refuses one a byte longer', () => {
    const fields = t().manifest.fields;
    expect(fields.qrUrl).toMatchObject({ maxBytes: QR_BYTES });
    for (const link of longestLinks) {
      expect(new TextEncoder().encode(link).length).toBe(QR_BYTES);
      expect(validateSpotData(fields, spotData(t().manifest, { qrUrl: link }), {})).toEqual([]);
      expect(validateSpotData(fields, spotData(t().manifest, { qrUrl: `${link}w` }), {})).toEqual([
        'field "qrUrl" is longer than 213 bytes, the most its QR code holds. Some characters use more than one byte',
      ]);
    }
  });

  for (const orientation of ['landscape', 'portrait'] as const)
    it(`the QR code reads back as the longest links allowed, at 30vmin and 6.6 px a module or more, in every severity, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      for (const severity of severities)
        for (const longest of longestLinks)
          for (const copy of [longCopy(), worstCopy('W')]) {
            const f = await k.play({ severity, ...copy, qrUrl: longest });
            const { fills, clip, vmin, module } = await f.evaluate(() => {
              for (const a of document.getAnimations()) {
                a.pause();
                a.currentTime = 3000;
              }
              const svg = document.querySelector<SVGSVGElement>('#qr svg')!;
              const r = svg.getBoundingClientRect();
              return {
                fills: [getComputedStyle(svg.querySelector('rect')!).fill, getComputedStyle(svg.querySelector('path')!).fill],
                clip: { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) },
                vmin: r.width / (Math.min(innerWidth, innerHeight) / 100),
                module: (r.width / svg.viewBox.baseVal.width) * (1080 / Math.min(innerWidth, innerHeight)),
              };
            });
            expect(vmin, severity).toBeGreaterThanOrEqual(29.9);
            expect(module, severity).toBeGreaterThanOrEqual(6.6);
            expect(fills, severity).toEqual(['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
            const png = (await k.hst.page.screenshot({ clip })).toString('base64');
            const rgba = await k.hst.page.evaluate(async (png) => {
              const img = new Image();
              img.src = `data:image/png;base64,${png}`;
              await img.decode();
              const g = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
              g.drawImage(img, 0, 0);
              return [...g.getImageData(0, 0, img.width, img.height).data];
            }, png);
            expect(jsQR(Uint8ClampedArray.from(rgba), clip.width, clip.height)?.data, severity).toBe(longest);
          }
    }, 120_000);

  /** A QR code's screenshot, read back by jsQR: what a phone would scan. */
  async function decoded(k: { hst: { page: Page } }, f: Frame): Promise<string | undefined> {
    const clip = await f.evaluate(() => {
      const r = document.querySelector('#qr svg')!.getBoundingClientRect();
      return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    });
    if (clip.y < 0 || clip.x < 0) return undefined;
    const png = (await k.hst.page.screenshot({ clip })).toString('base64');
    const rgba = await k.hst.page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const g = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      g.drawImage(img, 0, 0);
      return [...g.getImageData(0, 0, img.width, img.height).data];
    }, png);
    return jsQR(Uint8ClampedArray.from(rgba), clip.width, clip.height)?.data;
  }

  // Character limits cannot keep text in place, as the widest glyph can always be wider (review of #448, round 3): the
  // copy, the meta line and the code with its caption are regions nothing can grow or push, and text that does not fit
  // its region scales down until it does. Each field filled to its limit with the widest glyphs there are.
  const glyphs: [string, (n: number) => string][] = [
    ['W', (n) => 'W'.repeat(n)],
    ['W words', widest.W],
    ['CJK', widest.CJK],
    ['﷽', (n) => '﷽'.repeat(n)],
    ['ﷺ', (n) => 'ﷺ'.repeat(n)],
    ['⸻', (n) => '⸻'.repeat(n)],
    ['⸺', (n) => '⸺'.repeat(n)],
    ['Thai', (n) => 'ญี่ปุ่นปั้นน้ำใจผู้ใหญ่ที่นี่'.repeat(20).slice(0, n)],
  ];
  const filled = (glyph: (n: number) => string) => {
    const fields = t().manifest.fields;
    return Object.fromEntries(
      ['headline', 'instructions', 'issuedBy', 'endsAt', 'qrLabel'].map((f) => [f, glyph((fields[f] as { maxLength: number }).maxLength)]),
    );
  };
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`keeps every line of the widest text in its region and the code whole and readable, in every severity, ${orientation}`, async () => {
      const cases: [string, Data][] = [
        // The round-3 report's own: a caption of 32 ﷽ grew the figure, so the tile started 48 px above the screen.
        ['﷽ caption', { qrLabel: '﷽'.repeat(32) }],
        ...glyphs.map(([name, glyph]): [string, Data] => [name, filled(glyph)]),
      ];
      const k = await alertFrame(orientation);
      const found: string[] = [];
      for (const severity of severities)
        for (const [name, text] of cases) {
          const f = await k.play({ severity, ...text, qrUrl: longestLinks[0] });
          const problems = await f.evaluate(() => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = 3000;
            }
            const out: string[] = [];
            const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
            const inside = (r: DOMRect, b: { left: number; top: number; right: number; bottom: number }) =>
              r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
            const meets = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
            const tile = document.querySelector('.tile')!.getBoundingClientRect();
            if (!inside(tile, view)) out.push('the code is not whole on screen');
            // Each region, and the side its text grows towards: the copy from the top, the meta line from the bottom.
            const regions = [
              ['copy', document.querySelector('.copy')!, 'bottom'],
              ['meta', document.querySelector('.meta')!, 'top'],
              ['caption', document.querySelector('.qr figcaption')!, 'bottom'],
            ] as const;
            const boxes = new Map<string, DOMRect>([...regions.map(([n, el]) => [n, el.getBoundingClientRect()] as const), ['tile', tile]]);
            for (const [a, ra] of boxes) for (const [b, rb] of boxes) if (a < b && meets(ra, rb)) out.push(`the ${a} and ${b} regions overlap`);
            const range = document.createRange();
            for (const [name, el, side] of regions) {
              const box = boxes.get(name)!;
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                range.selectNodeContents(node);
                for (const line of range.getClientRects()) {
                  if (!line.width) continue;
                  if (!inside(line, view)) out.push(`a ${name} line is off screen`);
                  if (line.left < box.left - 0.5 || line.right > box.right + 0.5) out.push(`a ${name} line runs out at the side`);
                  if (side === 'bottom' ? line.bottom > box.bottom + 0.5 : line.top < box.top - 0.5) out.push(`a ${name} line runs out of its region`);
                  for (const [other, ro] of boxes) if (other !== name && meets(line, ro)) out.push(`a ${name} line enters the ${other}`);
                }
              }
            }
            return [...new Set(out)];
          });
          for (const p of problems) found.push(`${severity}, ${name}: ${p}`);
          if ((await decoded(k, f)) !== longestLinks[0]) found.push(`${severity}, ${name}: the code does not read back`);
        }
      expect(found).toEqual([]);
    }, 300_000);

  // Marks stacked above or below a character paint past its line, though the line fits (review of #448, final check):
  // each text box clips its ink a little past its edges, and Alert refuses more than four marks on a character.
  describe('stacked marks', () => {
    const plainInstructions = 'Use the stairs. Do not use the elevators.';
    const captions = [`WW${'͆'.repeat(16)}${'W'.repeat(14)}`, `W${'̾'.repeat(20)}${'W'.repeat(11)}`];
    const zalgoInstructions = `U${'̍'.repeat(160)}se the stairs. Do not use the elevators.`;
    /** A screenshot of `selector`'s box in the frame, as PNG bytes. */
    const shot = async (k: { hst: { page: Page } }, f: Frame, selector: string) => {
      const clip = await f.evaluate((sel) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = 3000;
        }
        if (document.getAnimations().some((a) => a.playState === 'running')) throw new Error('an animation is still running');
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, selector);
      return k.hst.page.screenshot({ clip });
    };

    it('refuses a fifth mark on one character in every text field', () => {
      const fields = t().manifest.fields;
      for (const name of ['headline', 'instructions', 'issuedBy', 'endsAt', 'qrLabel']) {
        expect(fields[name], name).toMatchObject({ maxMarks: 4 });
        const at = (marks: number) => validateSpotData(fields, spotData(t().manifest, { [name]: `U${'̍'.repeat(marks)}` }), {});
        expect(at(4), name).toEqual([]);
        expect(at(5), name).toEqual([`field "${name}" stacks more than 4 accents or marks on one character`]);
      }
    });

    // The code and the headline apart, so each fails on its own with the clipping off.
    for (const orientation of ['landscape', 'portrait'] as const)
      it(`keeps the marks out of the code, which reads back as under a plain caption, ${orientation}`, async () => {
        const k = await alertFrame(orientation);
        for (const severity of severities) {
          const plain = await shot(k, await k.play({ severity, qrUrl: longestLinks[0] }), '.tile');
          for (const qrLabel of captions) {
            const f = await k.play({ severity, qrLabel, qrUrl: longestLinks[0] });
            expect((await shot(k, f, '.tile')).equals(plain), `${severity}: the code under ${qrLabel.slice(0, 3)}…`).toBe(true);
            expect(await decoded(k, f), severity).toBe(longestLinks[0]);
          }
        }
      }, 120_000);

    for (const orientation of ['landscape', 'portrait'] as const)
      it(`keeps the marks out of the headline, which paints as above plain instructions, ${orientation}`, async () => {
        const k = await alertFrame(orientation);
        for (const severity of severities) {
          const headline = await shot(k, await k.play({ severity, instructions: plainInstructions }), '.headline');
          const f = await k.play({ severity, instructions: zalgoInstructions });
          expect((await shot(k, f, '.headline')).equals(headline), `${severity}: the headline`).toBe(true);
        }
      }, 120_000);

    // Clipping must take no ink a written language needs, in the headline above all, whose line is tight (review of
    // #448, round 5): Vietnamese stacks two marks on a capital, Thai a vowel and a tone mark, Arabic its vowel marks above
    // and below, pointed Hebrew its points and cantillation (`שְּׁ֑לֹמֹ֖ה֙` lost two rows of a mark at 1.02, round 6).
    const scripts: [string, Data][] = [
      [
        'Vietnamese',
        {
          headline: 'ẾỂ ỄỆ ỘỚ ỜỞ ỠỢ ỨỪ ỬỮ ỰẤ',
          instructions: 'Đi cầu thang gần nhất. Không dùng thang máy.',
          issuedBy: 'Ban An toàn Tòa nhà ỆỘ',
          qrLabel: 'Quét mã để cập nhật ẾỆ',
        },
      ],
      ['Thai', { headline: 'หนีไฟไปทางนี้', instructions: 'น้ำใจผู้ใหญ่ที่นี่ ปั้นญี่ปุ่น ใช้บันไดหนีไฟ ห้ามใช้ลิฟต์', issuedBy: 'ฝ่ายความปลอดภัยอาคาร', qrLabel: 'สแกนเพื่อดูข้อมูลล่าสุด' }],
      ['Arabic', { headline: 'إِخْلَاءُ الْمَبْنَى اَلْآنَ', instructions: 'اِسْتَخْدِمِ الدَّرَجَ الْأَقْرَبَ، وَلَا تَسْتَخْدِمِ الْمِصْعَدَ.', issuedBy: 'إِدَارَةُ السَّلَامَةِ', qrLabel: 'اِمْسَحِ الرَّمْزَ' }],
      ['Hebrew', { headline: 'שְּׁ֑לֹמֹ֖ה֙ חַיִּ֣ים וְשָׁל֑וֹם', instructions: 'הִשְׁתַּמְּשׁוּ בַּמַּדְרֵגוֹת הַקְּרוֹבוֹת', issuedBy: 'מַחְלֶקֶת בְּטִיחוּת', qrLabel: 'סִרְקוּ לְעִדְכּוּנִים' }],
    ];
    for (const orientation of ['landscape', 'portrait'] as const)
      it(`clips none of the ink of real marks, in the headline and every other box, ${orientation}`, async () => {
        const k = await alertFrame(orientation);
        const cut: string[] = [];
        for (const [name, text] of scripts) {
          const f = await k.play(text);
          const clipped = await shot(k, f, '.body');
          const style = await f.evaluate(() => {
            const el = document.createElement('style');
            el.textContent = '.headline, .instructions, .meta p, .qr figcaption { overflow: visible !important; clip-path: none !important; }';
            document.head.append(el);
            return true;
          });
          if (style && !(await shot(k, f, '.body')).equals(clipped)) cut.push(name);
        }
        expect(cut).toEqual([]);
      });
  });

  // The search finds each scale within 1/64 (review of #448, round 5: `﷽⁠` seven times stopped at 0.7557 where 0.7905 fit).
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`finds each scale within 1/64 of the largest that fits, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      const found: string[] = [];
      for (const [name, text] of [
        ['﷽⁠ caption', { qrLabel: '﷽⁠'.repeat(7) }],
        ['﷽', filled((n) => '﷽'.repeat(n))],
        ['⸻', filled((n) => '⸻'.repeat(n))],
        ['W', filled((n) => 'W'.repeat(n))],
      ] as const) {
        const f = await k.play({ ...text, qrUrl: longestLinks[0] });
        const misses = await f.evaluate(() => {
          const root = document.documentElement;
          // As main.ts measures: across by each line, down by the blocks, within half a pixel.
          const fits = (region: Element, side: 'top' | 'bottom') => {
            const box = region.getBoundingClientRect();
            const range = document.createRange();
            const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              range.selectNodeContents(n);
              for (const r of range.getClientRects()) if (r.left < box.left - 0.5 || r.right > box.right + 0.5) return false;
            }
            for (const b of region.children) {
              const r = b.getBoundingClientRect();
              if (side === 'bottom' ? r.bottom > box.bottom + 0.5 : r.top < box.top - 0.5) return false;
            }
            return true;
          };
          const checks: [string, () => boolean][] = [
            ['--fit', () => fits(document.querySelector('.copy')!, 'bottom') && fits(document.querySelector('.meta')!, 'top')],
            ['--cap-fit', () => fits(document.querySelector('.qr figcaption')!, 'bottom')],
          ];
          root.dataset.measuring = '';
          const out: string[] = [];
          for (const [name, check] of checks) {
            const at = Number(root.style.getPropertyValue(name));
            if (!check()) out.push(`${name} ${at} does not fit`);
            if (at < 1) {
              root.style.setProperty(name, String(Math.min(1, at + 1 / 64)));
              if (check()) out.push(`${name} ${at} is short of ${at + 1 / 64}, which fits`);
              root.style.setProperty(name, String(at));
            }
          }
          delete root.dataset.measuring;
          return out;
        });
        for (const m of misses) found.push(`${name}: ${m}`);
      }
      expect(found).toEqual([]);
    });

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

  // The widest copy: ordinary words at every limit fit at full size.
  it('steps the type down until long copy fits', async () => {
    const k = await alertFrame('portrait');
    const size = async (data: Data) => (await k.play(data)).evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('.headline')!).fontSize));
    expect(await size(worstCopy('W'))).toBeLessThan(await size({}));
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
      band: ['alert-drop intro', 'alert-leave outro'],
      outros: Array(7).fill('alert-leave outro'),
      ambient,
    });
    const calm = {
      props: ['opacity', 'transform'],
      band: ['alert-fade intro', 'alert-leave outro'],
      outros: Array(7).fill('alert-leave outro'),
      ambient: [],
    };
    // 2000 ms a cycle is 0.5 Hz: one flash every 2 s, under WCAG 2.3.1's 3 a second.
    expect(seen).toEqual({ emergency: hard(['beat every 2000 ms', 'glow every 2000 ms']), warning: hard([]), advisory: calm, notice: calm });
  });

  // D's motion (docs/template-spec.md, Motion), read by seeking; the emergency pulse is the one loop allowed.
  for (const orientation of ['landscape', 'portrait'] as const)
    it(`moves as D does in every severity, ${orientation}`, async () => {
      const k = await alertFrame(orientation);
      const durationMs = 20_000;
      const found: string[] = [];
      for (const severity of severities)
        for (const line of await motionContract(await k.play({ severity }, undefined, durationMs), durationMs, { loops: '.glow, .beat' }))
          found.push(`${severity}: ${line}`);
      expect(found).toEqual([]);
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

  // The SDK restores the document and inits again on new data, while the old prepare may still be
  // waiting for the faces. Here the first prepare is held there until the new data has played its
  // own prepare: resuming must not step the new copy's type (#308). The new copy is long, so its own
  // step is not the first, which the old prepare, measuring its detached copy, would set.
  it('a prepare that new data replaced, resuming after the faces load, leaves the new document as a fresh load', async () => {
    const hst = await host('portrait', true);
    const a = spotData(t().manifest, { severity: 'notice' });
    const b = spotData(t().manifest, { severity: 'emergency', qrUrl, ...worstCopy('W') });
    await hst.open('fresh', t().html);
    await hst.init('fresh', b, {}, NOW);
    await hst.waitFor('fresh', 'ready', 1);
    const fresh = await hst.dom('fresh');
    expect(fresh).toMatch(/--fit: 0\.\d+;/);
    for (const [name, index] of [
      ['reset', 1],
      ['again', 2],
    ] as const) {
      await hst.open(name, t().html);
      const f = hst.page.mainFrame().childFrames()[index]!;
      // The first read of `document.fonts.ready` is the first prepare's: it waits there until the
      // test lets it go, and says when it has got there.
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
      await hst.init(name, a, {}, NOW);
      await f.evaluate(() => (window as unknown as { held: Promise<void> }).held);
      if (name === 'reset') {
        await hst.post(name, 'reset');
        await hst.waitFor(name, 'loaded', 2);
      }
      await hst.init(name, b, {}, NOW);
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
