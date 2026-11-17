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
    /** The CMS origin the player is built to accept preview drafts from (`CMS_ORIGIN`). */
    cmsOrigin: string;
  }
}

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

  project.provide('playerDir', outDir);
  project.provide('templateHtml', templateHtml);
  project.provide('cmsOrigin', CMS_ORIGIN);
  return () => rmSync(outDir, { recursive: true, force: true });
}
