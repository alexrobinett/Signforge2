/**
 * The kit's stylesheet passes the brand colour lint (a template's `sources` hold only its own
 * files, so the build's lint never reads an imported stylesheet), and a template carrying all four
 * looks builds within the bundle budget. How it plays is tested in the player's browser tests
 * (`packages/player/browser/templates.test.ts`, the look kit).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandColourWarnings, TEMPLATE_BUDGET } from '@signforge/contract';
import { buildTemplate } from '@signforge/cli/template';
import { expect, it } from 'vitest';
import { LOOKS } from '../src/index';

const dir = join(import.meta.dirname, '..');
const css = readFileSync(join(dir, 'looks.css'), 'utf8');

it('passes the brand colour lint: every literal colour is the fallback inside a var()', () => {
  expect(brandColourWarnings({ 'looks.css': css })).toEqual([]);
});

it('styles every look, and the test template offers each', () => {
  for (const look of LOOKS) expect(css, look).toContain(`[data-look='${look}'] {`);
  const manifest = JSON.parse(readFileSync(join(dir, 'looks-test/template.json'), 'utf8')) as { fields: { look: { options: string[] } } };
  expect(manifest.fields.look.options).toEqual([...LOOKS]);
});

it('builds a template carrying all four looks within the bundle budget', async () => {
  const built = await buildTemplate(join(dir, 'looks-test'));
  expect(built.problems).toEqual([]);
  expect(built.report.warnings).toEqual([]);
  const faces: Record<string, number> = {};
  for (const m of built.html.matchAll(/@font-face\{font-family:"?([\w-]+)"?;src:url\((data:[^)]+)\)/g)) faces[m[1]!] = (faces[m[1]!] ?? 0) + m[2]!.length;
  const fontBytes = Object.values(faces).reduce((a, b) => a + b, 0);
  // The bytes each look adds to a bundle, for the PR and docs/template-spec.md: its faces as inlined.
  console.log({ ...faces, 'everything else': built.report.bundleBytes - fontBytes, total: built.report.bundleBytes });
  expect(Object.keys(faces).sort()).toEqual(['lk-body', 'lk-corporate', 'lk-night', 'lk-night-mono', 'lk-pop', 'lk-poster']);
  expect(built.report.bundleBytes).toBeLessThan(TEMPLATE_BUDGET.maxBundleBytes);
});
