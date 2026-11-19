/**
 * The shipped templates follow the screen's brand kit (M3-25): every colour in their CSS comes
 * from a `var(--sf-*)` token or is built on one, with a literal only as the fallback inside
 * `var()`, so the brand colour lint has nothing to say; `accent` fields default to the kit's
 * accent; and the time comes from the SDK's `now()`, which follows the player's clock offset.
 *
 * And no bundle changes without a new version: a registered version is immutable, so `sf template
 * seed` refuses a bundle whose bytes changed under it. `golden/template-bundles.json` holds each
 * template's key and the sha256 of its bundle.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { templateKey } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { buildTemplate } from '../src/template';

const dir = join(import.meta.dirname, '../../../templates');
const templates = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe.each(templates)('template %s', (name) => {
  it('passes the brand colour lint', async () => {
    const built = await buildTemplate(join(dir, name));
    expect(built.problems).toEqual([]);
    expect(built.report.warnings).toEqual([]);
  });

  it('defaults colour fields to brand tokens', () => {
    const manifest = JSON.parse(readFileSync(join(dir, name, 'template.json'), 'utf8')) as { fields: Record<string, { type: string; default?: unknown }> };
    for (const [key, field] of Object.entries(manifest.fields)) {
      if (field.type === 'color') expect(field.default, key).toMatch(/^\$brand\.[a-zA-Z]+$/);
    }
  });

  it('reads the time from the SDK, not the device clock', () => {
    const main = readFileSync(join(dir, name, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/new Date\(\s*\)|Date\.now\(\)/);
  });
});

it('changes no template bundle without a new version', async () => {
  const built: Record<string, string> = {};
  for (const name of templates) {
    const { manifest, html } = await buildTemplate(join(dir, name));
    built[templateKey(manifest)] = createHash('sha256').update(html).digest('hex');
  }
  const recorded = JSON.parse(readFileSync(join(import.meta.dirname, 'golden/template-bundles.json'), 'utf8')) as Record<string, string>;
  expect(
    built,
    'golden/template-bundles.json: a bundle is not the one recorded for its version, and a registered version never changes ' +
      "bytes. Bump the template's version (template.json and package.json) and record the new key and hash in place of the old. " +
      "If the template's own files did not change, something else reached its bundle (docs/template-spec.md, Rules).",
  ).toEqual(recorded);
});
