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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { templateKey } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { buildTemplate } from '@signforge/template-build';

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

  it('carries the OFL, and the copyright of each font its style.css inlines, into its bundle, as the licence asks of every copy', async () => {
    const { html } = await buildTemplate(join(dir, name));
    if (!html.includes('data:font/woff2;')) return;
    expect(html).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(html).toContain('5) The Font Software, modified or unmodified, in part or in whole,');
    if (readFileSync(join(dir, name, 'style.css'), 'utf8').includes('@fontsource-variable/inter/'))
      expect(html).toContain('Inter: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)');
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
  // It builds every template while CI runs up to 13 template test tasks on two cores, and it went past the
  // default 5 s there (#277, run 45117900937).
}, 30_000);

it('checks what a stylesheet that style.css imports brings into the bundle: network URLs and colour literals', async () => {
  // Under this directory, so main.ts resolves the SDK as a template's own does.
  const at = mkdtempSync(join(import.meta.dirname, '.imports-'));
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'clock', 'template.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(at, 'template.json'), JSON.stringify({ ...manifest, id: 'imports' }));
    writeFileSync(
      join(at, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script type="module" src="main.ts"></script></body></html>',
    );
    writeFileSync(join(at, 'main.ts'), "import { defineTemplate } from '@signforge/template-sdk';\ndefineTemplate({});\n");
    writeFileSync(join(at, 'style.css'), "@import './extra.css';\n.a { color: var(--sf-text, #fff); }\n");
    for (const network of [
      '.b { background: url(//tracker.example/p.gif); }',
      '.b { background-image: image-set("//tracker.example/p.gif" 1x); }',
      '.b { background-image: -webkit-image-set("https://tracker.example/p.gif" 1x); }',
    ]) {
      writeFileSync(join(at, 'extra.css'), `${network}\n.d { color: #ff0000; }\n`);
      const { problems, report } = await buildTemplate(at);
      expect(problems, network).toEqual(['a template may not load anything from the network']);
      expect(report.warnings, network).toEqual([expect.stringMatching(/extra\.css:2: literal colour #ff0000 in color/)]);
    }
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});

it('refuses scripts a template frame would not run, as the browser reads them', async () => {
  // Under this directory, so main.ts resolves the SDK as a template's own does.
  const at = mkdtempSync(join(import.meta.dirname, '.scripts-'));
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'clock', 'template.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(at, 'template.json'), JSON.stringify({ ...manifest, id: 'scripts' }));
    writeFileSync(join(at, 'style.css'), 'body { margin: 0; }');
    writeFileSync(join(at, 'main.ts'), "import { defineTemplate } from '@signforge/template-sdk';\ndefineTemplate({});\n");
    writeFileSync(
      join(at, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>' +
        '<script type="&#109;odule">"use strict";m()</script><svg><script href="x.js"/></svg><script type="text/ecmascript">"use strict";e()</script>' +
        '<script type="module" src="main.ts"></script></body></html>',
    );
    const { problems } = await buildTemplate(at);
    expect(problems.filter((p) => /script/.test(p))).toEqual([
      expect.stringMatching(/type "module" does not run/),
      expect.stringMatching(/external script does not run/),
      expect.stringMatching(/type "text\/ecmascript" does not run/),
    ]);
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});

describe('a template that draws a QR code', () => {
  it("carries the QR encoder's MIT notice in its bundle, which the licence requires of every copy", async () => {
    const built = await buildTemplate(join(import.meta.dirname, 'fixtures/qr'));
    expect(built.problems).toEqual([]);
    expect(built.html).toContain('Copyright (c) Project Nayuki');
    expect(built.html).toContain('Copyright (c) 2023 Anthony Fu');
    expect(built.html).toContain('The above copyright notice and this permission notice shall be included in all');
  });
});
