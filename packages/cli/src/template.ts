/**
 * Build a template directory into the one self-contained HTML file screens load, and lint it with
 * the contract's `checkTemplateBundle`, the same check the server repeats when the template is
 * registered (`sf template push`). Used by `sf build` and `sf template push`.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import {
  brandColourWarnings,
  checkTemplateBundle,
  PROTOCOL_VERSION,
  TEMPLATE_BUDGET,
  type TemplateCheckReport,
  type TemplateManifest,
} from '@signforge/contract';

/** The author's own files: what the forbidden-code list is checked against, and what the server receives. */
export const SOURCE_FILES = ['index.html', 'style.css', 'main.ts'] as const;

export interface BuiltTemplate {
  /** `template.json` with the protocol the bundled SDK speaks. */
  manifest: TemplateManifest;
  html: string;
  /** The author's files by name, as written. */
  sources: Record<string, string>;
  report: TemplateCheckReport;
  /** Every problem, from the build and the lint. Empty means the template may ship. */
  problems: string[];
}

/** Bundle a template directory into a single HTML file with its script, styles and fonts inlined. */
export async function buildTemplate(dir: string): Promise<BuiltTemplate> {
  const authored = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')) as TemplateManifest;
  // The bundle embeds this build's SDK, so it speaks this protocol for as long as it exists.
  const manifest: TemplateManifest = { ...authored, protocol: PROTOCOL_VERSION };
  const problems: string[] = [];

  const common = { bundle: true, minify: true, write: false, target: 'chrome120', logLevel: 'silent' } as const;
  const js = await build({ ...common, entryPoints: [join(dir, 'main.ts')], format: 'iife' });
  const css = await build({
    ...common,
    entryPoints: [join(dir, 'style.css')],
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    metafile: true,
  });
  const script = js.outputFiles[0]!.text.replaceAll('</script', '<\\/script');
  const style = css.outputFiles[0]!.text;

  const sources = Object.fromEntries(SOURCE_FILES.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  let html = sources['index.html']!;
  const before = html;
  html = html.replace(/<link rel="stylesheet" href="style\.css">/, () => `<style>${style}</style>`);
  html = html.replace(/<script type="module" src="main\.ts"><\/script>/, () => `<script>${script}</script>`);
  if (html === before || !html.includes('<style>') || !html.includes('<script>')) {
    problems.push('index.html must reference style.css and main.ts exactly as the template starter does');
  }

  const report = checkTemplateBundle({ manifest, html, sources });
  for (const c of report.checks) problems.push(...c.problems);
  // The server lints only the author's own files; a stylesheet style.css imports (the look kit's)
  // is linted here, named from the template's directory.
  const imported = Object.keys(css.metafile.inputs)
    .filter((f) => f.endsWith('.css') && resolve(f) !== resolve(dir, 'style.css'))
    .map((f) => [relative(dir, f), readFileSync(f, 'utf8')]);
  report.warnings = [...(report.warnings ?? []), ...brandColourWarnings(Object.fromEntries(imported))];
  console.log(
    `  template ${manifest.id}@${manifest.version}  ${(report.bundleBytes / 1024).toFixed(0)} kB (budget ${TEMPLATE_BUDGET.maxBundleBytes / 1000} kB)`,
  );
  return { manifest, html, sources, report, problems };
}
