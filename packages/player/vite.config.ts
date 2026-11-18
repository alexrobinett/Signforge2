import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
/** The version each sync reports: the package version and the commit it was built from. */
function playerVersion(): string {
  if (process.env.SF_PLAYER_VERSION) return process.env.SF_PLAYER_VERSION;
  try {
    return `${pkg.version}+${execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()}`;
  } catch {
    return pkg.version;
  }
}

export default defineConfig({
  base: './',
  build: { outDir: '../../dist/player', emptyOutDir: true, target: 'chrome120' },
  define: {
    // The CMS origin whose pages may post drafts to the player in preview mode (src/preview.ts): the
    // same setting, and value, as the API's CMS_ORIGIN. Unset, it is the player's own origin, which
    // is the CMS's when the CMS serves the player build on its hostname.
    __SF_CMS_ORIGIN__: JSON.stringify(process.env.CMS_ORIGIN ?? ''),
    __SF_PLAYER_VERSION__: JSON.stringify(playerVersion()),
    // No real time is earlier than the build: a clock reading before it is not trusted (src/clock.ts).
    __SF_BUILD_TIME__: JSON.stringify(Date.now()),
  },
});
