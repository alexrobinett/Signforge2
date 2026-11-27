// player-core's Frame host as a script for the check's host page (`window.SFFrameHost`), the same host the player's
// slots drive (#331). Given to the runner as `__SF_FRAME_HOST__`: by build.ts for the image, by vitest.config.ts for tests.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function frameHostScript(): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(import.meta.resolve('@signforge/player-core/frame-host'))],
    bundle: true,
    format: 'iife',
    globalName: 'SFFrameHost',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  return out.outputFiles[0]!.text;
}
