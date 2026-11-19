/**
 * The image runs the browser these tests ran: the build writes the installed playwright-core's
 * version (the lockfile's) into dist/package.json, which the Dockerfile installs. A version written
 * into the Dockerfile by hand would drift from the lockfile with nothing to notice.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const dir = new URL('..', import.meta.url).pathname;

it('installs the Playwright the tests ran, from the build rather than a copy in the Dockerfile', () => {
  execFileSync('pnpm', ['build'], { cwd: dir, stdio: 'ignore' });
  const tested: string = createRequire(import.meta.url)('playwright-core/package.json').version;
  const installed = JSON.parse(readFileSync(`${dir}dist/package.json`, 'utf8'));
  expect(installed.dependencies).toEqual({ 'playwright-core': tested });
  const dockerfile = readFileSync(`${dir}Dockerfile`, 'utf8');
  expect(dockerfile).toMatch(/^COPY dist\/package\.json /m);
  expect(dockerfile).not.toMatch(/playwright(?:-core)?@\d/);
});
