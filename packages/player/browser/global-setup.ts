/**
 * Runs once per `vitest run`: builds the player into a temporary directory (never `dist/player`,
 * which deploys use) and bundles the fixture template with the real SDK. Tests get both through
 * `inject('playerDir')` and `inject('templateHtml')`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The built player, served by the fixture server. */
    playerDir: string;
    /** `browser/fixtures/template.ts` bundled with the SDK into one HTML file. */
    templateHtml: string;
    /**
     * The same script in markup that draws with every brand token, the brand fonts and the logo,
     * each with a fallback (`var(--sf-x, fallback)`), as a branded template would.
     */
    brandTemplateHtml: string;
    /** The CMS origin the player is built to accept preview drafts from (`CMS_ORIGIN`). */
    cmsOrigin: string;
  }
}

/** The brand fixture's fallback per token (CSS variable name without `--sf-`). */
export const BRAND_FALLBACKS = {
  primary: 'rgb(1, 1, 1)',
  'on-primary': 'rgb(2, 2, 2)',
  accent: 'rgb(3, 3, 3)',
  'on-accent': 'rgb(4, 4, 4)',
  bg: 'rgb(5, 5, 5)',
  surface: 'rgb(6, 6, 6)',
  text: 'rgb(7, 7, 7)',
  muted: 'rgb(8, 8, 8)',
} as const;

const playerRoot = resolve(import.meta.dirname, '..');
/** Not the player's origin (127.0.0.1), so preview.test.ts frames the player from another origin. */
const CMS_ORIGIN = 'http://cms.test';

export default async function setup(project: TestProject): Promise<() => void> {
  const outDir = mkdtempSync(join(tmpdir(), 'sf-player-test-'));
  // The build reads CMS_ORIGIN as a deploy's build does (vite.config.ts).
  process.env.CMS_ORIGIN = CMS_ORIGIN;
  await viteBuild({ root: playerRoot, logLevel: 'warn', build: { outDir, emptyOutDir: true } });

  const js = await esbuild({
    entryPoints: [join(playerRoot, 'browser/fixtures/template.ts')],
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  const script = js.outputFiles[0]!.text.replaceAll('</script', '<\\/script');
  const templateHtml =
    '<!doctype html><html><head><style>' +
    'html,body{margin:0;height:100%;background:#123;color:#fff;font:48px sans-serif}' +
    '@keyframes spin{to{transform:rotate(1turn)}}#box{width:40px;height:40px;background:#fff;animation:spin 1s linear infinite}' +
    `</style></head><body><div id="label" data-sf="label"></div><div id="box"></div><script>${script}</script></body></html>`;

  // Each token on its own element, so a test reads one computed value per token.
  const tokens = Object.entries(BRAND_FALLBACKS)
    .map(([v, fallback]) => `#t${v}{color:var(--sf-${v},${fallback})}`)
    .join('');
  const brandTemplateHtml =
    '<!doctype html><html><head><style>' +
    'html,body{margin:0;height:100%;background:var(--sf-bg,rgb(1, 2, 3));font:48px monospace}' +
    tokens +
    '#card{border-radius:var(--sf-radius,3px)}' +
    '#display{font-family:var(--sf-font-display,serif);font-weight:700}' +
    '#body{font-family:var(--sf-font-body,monospace)}' +
    '#box{display:none}' +
    '</style></head><body><div id="label" data-sf="label"></div><div id="box"></div>' +
    Object.keys(BRAND_FALLBACKS)
      .map((v) => `<i id="t${v}">${v}</i>`)
      .join('') +
    '<div id="card"></div><p id="display">BRAND DISPLAY</p><p id="body">Brand body text</p>' +
    // A 1x1 GIF: what the template shows when no logo comes.
    '<img id="logo" data-sf-src="$brand.logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">' +
    `<script>${script}</script></body></html>`;

  project.provide('playerDir', outDir);
  project.provide('brandTemplateHtml', brandTemplateHtml);
  project.provide('templateHtml', templateHtml);
  project.provide('cmsOrigin', CMS_ORIGIN);
  return () => rmSync(outDir, { recursive: true, force: true });
}
