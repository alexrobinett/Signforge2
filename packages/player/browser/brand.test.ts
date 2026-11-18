/**
 * Brand in the player and SDK (M3-39): the player sends the screen's brand kit as `theme` in
 * `init`, and the SDK turns it into the `--sf-*` custom properties, the brand fonts and the logo
 * before `prepare`. A template that uses them draws with the brand; without a kit, with its own
 * fallbacks. The fonts are the catalogue's real files (repo `fonts/`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { BRAND_CSS_VARS, PROTOCOL_VERSION, type BrandColors } from '@signforge/contract';
import type { Frame } from 'playwright';
import { describe, expect, it } from 'vitest';
import { buildContent, type FixtureBrand } from './content';
import { BRAND_FALLBACKS } from './global-setup';
import { useHarness, type Player } from './harness';

const h = useHarness();

const font = (dir: string, weights: number[]) =>
  weights.map((weight) => ({ weight, data: readFileSync(join(import.meta.dirname, '../../../fonts', dir, `${weight}-normal.woff2`)) }));

/** A solid PNG of the given size, so a test can tell two logos apart by their decoded width. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xcc)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const colors: BrandColors = {
  primary: '#1d4ed8',
  onPrimary: '#ffffff',
  accent: '#f97316',
  onAccent: '#000000',
  background: '#0b1020',
  surface: '#18213a',
  text: '#f8fafc',
  muted: '#a5b4cb',
};
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

const brand: FixtureBrand = {
  colors,
  shape: 'round',
  fonts: {
    display: { id: 'base/oswald', family: 'Oswald', files: font('oswald', [500, 700]) },
    body: { id: 'base/inter', family: 'Inter', files: font('inter', [400, 600, 800]) },
  },
  // On a dark background the SDK picks onDark (4 px wide), not onLight (1 px).
  logo: { onDark: png(4, 1), onLight: png(1, 4) },
};

/** The brand fixture's frame once it is playing. */
async function playing(p: Player): Promise<Frame> {
  await p.until((s) => s.played >= 1);
  for (const f of p.page.frames()) if (f !== p.page.mainFrame() && (await f.evaluate(() => document.body.dataset.playing).catch(() => undefined))) return f;
  throw new Error('no template frame is playing');
}

/** What the frame draws with: each token's computed colour, the radius, the fonts and the logo. */
const drawn = (f: Frame) =>
  f.evaluate((names) => {
    const css = (id: string, prop: string) => getComputedStyle(document.getElementById(id)!).getPropertyValue(prop);
    const logo = document.getElementById('logo') as HTMLImageElement;
    return {
      tokens: Object.fromEntries(names.map((n) => [n, css(`t${n}`, 'color')])),
      background: getComputedStyle(document.body).backgroundColor,
      radius: css('card', 'border-radius'),
      display: css('display', 'font-family'),
      body: css('body', 'font-family'),
      // Faces the SDK added, and whether each was decoded before ready.
      faces: [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`).sort(),
      displayReady: document.fonts.check('700 48px "sf-brand-display"'),
      logo: { blob: logo.src.startsWith('blob:'), width: logo.naturalWidth },
    };
  }, Object.keys(BRAND_FALLBACKS));

describe('brand in the player', () => {
  it('draws a template with the brand kit: every token, both fonts decoded before ready, and the logo', async () => {
    const content = buildContent(h.brandTemplateHtml, [{ id: 'a', durationMs: 60_000 }], { brand });
    const p = await h.openPlayer((server) => server.publish(content));
    const d = await drawn(await playing(p));

    expect(d.tokens).toEqual({
      primary: rgb(colors.primary),
      'on-primary': rgb(colors.onPrimary),
      accent: rgb(colors.accent),
      'on-accent': rgb(colors.onAccent),
      bg: rgb(colors.background),
      surface: rgb(colors.surface),
      text: rgb(colors.text),
      muted: rgb(colors.muted),
    });
    expect(d.background).toBe(rgb(colors.background));
    expect(d.radius).toBe('9999px');
    expect(d.display).toBe('sf-brand-display, sans-serif');
    expect(d.body).toBe('sf-brand-body, sans-serif');
    expect(d.faces).toEqual([
      'sf-brand-body 400 loaded',
      'sf-brand-body 600 loaded',
      'sf-brand-body 800 loaded',
      'sf-brand-display 500 loaded',
      'sf-brand-display 700 loaded',
    ]);
    expect(d.displayReady).toBe(true);
    expect(d.logo).toEqual({ blob: true, width: 4 });
  });

  it('draws the same template with its own fallbacks when the screen has no brand kit', async () => {
    const content = buildContent(h.brandTemplateHtml, [{ id: 'a', durationMs: 60_000 }]);
    const p = await h.openPlayer((server) => server.publish(content));
    const d = await drawn(await playing(p));

    expect(d.tokens).toEqual(BRAND_FALLBACKS);
    expect(d.background).toBe('rgb(1, 2, 3)');
    expect(d.radius).toBe('3px');
    expect(d.display).toBe('serif');
    expect(d.body).toBe('monospace');
    expect(d.faces).toEqual([]);
    expect(d.logo).toEqual({ blob: false, width: 1 });
  });

  it('uses onDark when the kit has no onLight logo, and leaves the template font when the kit has none', async () => {
    const content = buildContent(h.brandTemplateHtml, [{ id: 'a', durationMs: 60_000 }], {
      brand: { colors: { ...colors, background: '#ffffff' }, shape: 'square', fonts: {}, logo: { onDark: png(4, 1) } },
    });
    const p = await h.openPlayer((server) => server.publish(content));
    const d = await drawn(await playing(p));
    expect(d.radius).toBe('0px');
    expect(d.display).toBe('serif');
    expect(d.faces).toEqual([]);
    expect(d.logo).toEqual({ blob: true, width: 4 });
  });

  it('loads no brand font into a template whose styles never use one', async () => {
    // The plain fixture template has no var(--sf-font-*): a face it would never draw is not made.
    const content = buildContent(h.templateHtml, [{ id: 'a', durationMs: 60_000 }], { brand });
    const p = await h.openPlayer((server) => server.publish(content));
    const f = await playing(p);
    expect(await f.evaluate(() => [...document.fonts].map((x) => x.family))).toEqual([]);
    expect(await f.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sf-primary'))).toBe(colors.primary);
  });

  it('picks onLight on a light background', async () => {
    const content = buildContent(h.brandTemplateHtml, [{ id: 'a', durationMs: 60_000 }], { brand: { ...brand, colors: { ...colors, background: '#f5f5f4' } } });
    const p = await h.openPlayer((server) => server.publish(content));
    expect((await drawn(await playing(p))).logo).toEqual({ blob: true, width: 1 });
  });

  it("keeps the kit's files for a spot preparing under a replaced manifest", async () => {
    // `a` waits on a feed that never answers, its step chosen under `first`, while `second`, with
    // another kit, replaces `first` and its files are cleaned up. `a` reads its theme after the wait.
    const first = buildContent(h.brandTemplateHtml, [{ id: 'a', bindings: { label: { source: 'feed', path: 'label' } }, durationMs: 800 }], { brand });
    const p = await h.openPlayer((s) => {
      s.publish(first);
      s.setData('feed', { id: 'feed', version: 1, fetchedAt: '2026-11-17T00:00:00Z', data: { label: 'a' } });
      s.intercept(/^\/content\/data\//, 'stall');
    });
    await p.until((s) => s.manifestId === first.manifest.id);
    const second = buildContent(h.brandTemplateHtml, [{ id: 'b', durationMs: 800 }], {
      brand: { colors, shape: 'square', fonts: {}, logo: { onDark: png(8, 1) } },
    });
    p.server.publish(second);
    await p.until((s) => s.manifestId === second.manifest.id);

    const s = await p.until((s) => s.log.some((l) => l.spot === 'b'));
    expect(s.log[0]).toMatchObject({ spot: 'a', manifest: first.manifest.id });
    expect(s.skipped).toBe(0);
  });
});

describe('brand in the SDK', () => {
  it('a reset removes the theme: the next init without one draws the fallbacks, and the document is as loaded', async () => {
    const page = await h.blankPage();
    const theme = {
      colors,
      shape: 'soft',
      fonts: { display: { family: 'Oswald', files: brand.fonts.display!.files.map((f) => ({ weight: f.weight, style: 'normal', data: [...f.data] })) } },
      logo: { onDark: [...png(4, 1)] },
    };
    await page.evaluate(
      ({ html, sf, theme }) => {
        const w = window as unknown as { msgs: string[]; inits: number };
        w.msgs = [];
        w.inits = 0;
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        const t = {
          ...theme,
          fonts: { display: { ...theme.fonts.display, files: theme.fonts.display.files.map((f) => ({ ...f, data: new Blob([new Uint8Array(f.data)]) })) } },
          logo: { onDark: new Blob([new Uint8Array(theme.logo.onDark)], { type: 'image/png' }) },
        };
        addEventListener('message', (e) => {
          if (e.source !== frame.contentWindow || e.data?.sf !== sf) return;
          w.msgs.push(e.data.type);
          if (e.data.type === 'loaded') {
            const base = {
              sf,
              type: 'init',
              data: { label: 'x' },
              assets: {},
              durationMs: 5000,
              orientation: 'landscape',
              viewport: { width: 960, height: 540 },
              timezone: 'UTC',
              locale: 'en-US',
              clock: { now: Date.now(), offsetMs: 0 },
            };
            // The first init carries the theme; the one after the reset does not.
            frame.contentWindow!.postMessage(w.inits++ === 0 ? { ...base, theme: t } : base, '*');
          }
        });
        frame.srcdoc = html;
        document.body.appendChild(frame);
      },
      { html: h.brandTemplateHtml, sf: PROTOCOL_VERSION, theme },
    );
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames()[1]!;
    const msgs = () => page.evaluate(() => (window as unknown as { msgs: string[] }).msgs);
    await expect.poll(msgs).toEqual(['loaded', 'ready']);
    const themed = await drawn(frame);
    expect(themed.tokens.primary).toBe(rgb(colors.primary));
    expect(themed.radius).toBe('12px');
    expect(themed.faces).toEqual(['sf-brand-display 500 loaded', 'sf-brand-display 700 loaded']);
    expect(themed.logo.width).toBe(4);
    const rootStyle = await frame.evaluate((vars) => vars.map((v) => document.documentElement.style.getPropertyValue(v)), Object.values(BRAND_CSS_VARS));
    expect(rootStyle.filter(Boolean)).toHaveLength(10); // all but the body font, which the theme left out

    await page.evaluate((sf) => document.querySelector('iframe')!.contentWindow!.postMessage({ sf, type: 'reset' }, '*'), PROTOCOL_VERSION);
    await expect.poll(msgs).toEqual(['loaded', 'ready', 'loaded', 'ready']);
    const plain = await drawn(frame);
    expect(plain.tokens).toEqual(BRAND_FALLBACKS);
    expect(plain.radius).toBe('3px');
    expect(plain.faces).toEqual([]);
    expect(plain.logo).toEqual({ blob: false, width: 1 });
  });
});
