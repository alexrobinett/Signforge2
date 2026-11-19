// `pnpm build`: the runner bundle, and the one package the image installs beside it, at the version
// installed here (the lockfile's), so the container runs the Chromium the tests ran (test/image.test.ts).
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { version }: { version: string } = createRequire(import.meta.url)('playwright-core/package.json');
await build({
  entryPoints: ['src/runner/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['playwright-core'],
  outfile: 'dist/runner.mjs',
});
writeFileSync('dist/package.json', `${JSON.stringify({ private: true, type: 'module', dependencies: { 'playwright-core': version } }, null, 2)}\n`);
