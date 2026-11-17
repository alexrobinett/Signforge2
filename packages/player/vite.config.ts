import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: '../../dist/player', emptyOutDir: true, target: 'chrome120' },
  // The CMS origin whose pages may post drafts to the player in preview mode (src/preview.ts): the
  // same setting, and value, as the API's CMS_ORIGIN. Unset, it is the player's own origin, which
  // is the CMS's when the CMS serves the player build on its hostname.
  define: { __SF_CMS_ORIGIN__: JSON.stringify(process.env.CMS_ORIGIN ?? '') },
});
