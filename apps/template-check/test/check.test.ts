/**
 * The runner in headless Chromium, as the container runs it: every base template passes (CI fails
 * otherwise, which is how `sf template seed`'s templates are checked), and each way the hostile
 * fixture misbehaves is refused with its problem.
 */
import { buildTemplate } from '@signforge/template-build';
import type { TemplateManifest } from '@signforge/contract';
import { existsSync, readdirSync } from 'node:fs';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTemplate } from '../src/runner/check';
import { launchBrowser } from '../src/runner/browser';

const root = new URL('../../../templates/', import.meta.url).pathname;
const baseDirs = readdirSync(root).filter((d) => existsSync(`${root}${d}/template.json`));

let browser: Browser;
let hostile: { manifest: TemplateManifest; html: string };
beforeAll(async () => {
  browser = await launchBrowser();
  hostile = await buildTemplate(new URL('fixtures/hostile', import.meta.url).pathname);
});
afterAll(() => browser.close());

/** The hostile fixture, its `mode` field defaulting to `mode`. */
function inMode(mode: string): TemplateManifest {
  const fields = structuredClone(hostile.manifest.fields);
  const field = fields.mode;
  if (field?.type !== 'select') throw new Error('the fixture has no mode field');
  field.default = mode;
  return { ...hostile.manifest, fields };
}

describe('the base templates', () => {
  for (const dir of baseDirs) {
    it(`${dir} passes, ready in every orientation it supports`, async () => {
      const built = await buildTemplate(`${root}${dir}`);
      const result = await checkTemplate(browser, built.manifest, built.html);
      expect(result.problems).toEqual([]);
      expect(result.renders.map((r) => r.orientation)).toEqual(built.manifest.orientations);
      for (const r of result.renders) {
        expect(r.readyMs).toBeGreaterThan(0);
        expect(r.frames?.count).toBeGreaterThan(0);
      }
    });
  }
});

describe('a template that misbehaves', () => {
  it('passes when it behaves', async () => {
    const result = await checkTemplate(browser, inMode('ok'), hostile.html);
    expect(result.problems).toEqual([]);
    expect(result.renders.map((r) => [r.orientation, r.viewport])).toEqual([
      ['landscape', { width: 1920, height: 1080 }],
      ['portrait', { width: 1080, height: 1920 }],
    ]);
  });

  const cases: [string, string[]][] = [
    ['fetch', ['requested https://example.com/leak (blocked)']],
    ['image', ['requested https://example.com/leak (blocked)']],
    ['apostrophe', ["requested https://example.com/leak/a'b (blocked)", "requested https://example.com/leak/a'b.png (blocked)"]],
    ['media', ['requested https://example.com/leak.mp4 (blocked)']],
    ['navigate-top', ['tried to navigate the page around it (blocked)']],
    // Chromium names only the origin of a frame it refused to load.
    ['navigate-self', ['tried to open https://example.com/ in a frame (blocked)', 'navigated its own frame (blocked)']],
    ['on-play', ['tried to open https://example.com/ in a frame (blocked)', 'navigated its own frame (blocked)']],
    ['no-ready', ['did not report ready within 2000 ms']],
    ['spin', ['did not report ready within 2000 ms']],
    ['spin-on-play', ['froze after play: did not draw a second of frames within 3000 ms']],
    ['fetch-then-spin-on-play', ['requested https://example.com/leak (blocked)', 'froze after play: did not draw a second of frames within 3000 ms']],
    ['throw', ['failed to prepare: prepare blew up']],
    ['uncaught', ['threw an uncaught error: late failure']],
    ['webrtc', ['failed to prepare: RTCPeerConnection is not defined']],
  ];
  for (const [mode, problems] of cases) {
    it(`is refused: ${mode}`, async () => {
      const result = await checkTemplate(browser, inMode(mode), hostile.html);
      expect(result.problems.sort()).toEqual([...problems].sort());
    });
  }

  it('renders each orientation once, however often the manifest lists it', async () => {
    const result = await checkTemplate(browser, { ...inMode('ok'), orientations: ['portrait', 'portrait', 'landscape', 'portrait'] }, hostile.html);
    expect(result.renders.map((r) => r.orientation)).toEqual(['portrait', 'landscape']);
  });

  it('passes a change of its own fragment, which is not a navigation', async () => {
    expect((await checkTemplate(browser, inMode('hash'), hostile.html)).problems).toEqual([]);
  });

  it('keeps the report short: at most 20 problems, each at most 200 characters', async () => {
    const flood = (await checkTemplate(browser, inMode('flood'), hostile.html)).problems;
    expect(flood).toHaveLength(20);
    expect(flood.at(-1)).toBe('and 31 more problems');
    const [long] = (await checkTemplate(browser, inMode('long-error'), hostile.html)).problems;
    expect(long).toBe(`failed to prepare: ${'x'.repeat(178)}...`);
    expect(long).toHaveLength(200);
  });

  it('reports no ready time when it never got ready, and no frames when it never played', async () => {
    const result = await checkTemplate(browser, inMode('no-ready'), hostile.html);
    expect(result.renders.map((r) => [r.readyMs, r.frames])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
});
