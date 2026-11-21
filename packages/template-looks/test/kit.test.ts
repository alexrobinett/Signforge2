/**
 * A template carrying all four looks builds within the bundle budget, with no problems and no
 * colour warnings (the build lints the kit's stylesheet with the template's own). How it plays is
 * tested in the player's browser tests (`packages/player/browser/templates.test.ts`, the look kit).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_BUDGET } from '@signforge/contract';
import { buildTemplate } from '@signforge/cli/template';
import { expect, it } from 'vitest';
import { LOOKS } from '../src/index';

const dir = join(import.meta.dirname, '..');
const css = readFileSync(join(dir, 'looks.css'), 'utf8');

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

it("carries each font's copyright notice and the OFL into the bundle, as the licence asks of every copy", async () => {
  const { html } = await buildTemplate(join(dir, 'looks-test'));
  for (const project of ['Inter', 'Bricolage Grotesque', 'Instrument Serif', 'Unbounded', 'Space Mono'])
    expect(html, project).toMatch(new RegExp(`Copyright 20\\d\\d The ${project} Project Authors`));
  expect(html).toContain('(https://github.com/rsms/inter-tight)');
  expect(html).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
  expect(html).toContain('5) The Font Software, modified or unmodified, in part or in whole,');
});
