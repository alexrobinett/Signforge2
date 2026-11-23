import { defineConfig, devices } from '@playwright/test';
import { CMS_URL } from './e2e/servers';

// `pnpm test:e2e`: starts the API (`wrangler dev`) and the CMS (`vite dev`) on their own ports,
// with a fresh local database and dev registry, then signs in, creates and switches orgs.
// Better Auth's rate limits apply, per address: each spec that signs in comes from its own
// (`fromAddress`, `signInAs` in e2e/helpers.ts), so their sign-ins never add up. Org slugs are
// global: each spec names its orgs with names no other spec uses, or two creates at once collide
// (test/e2e-addresses.test.ts checks both).
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  // A spec's tests run in order, in one worker; specs run side by side. Three workers take the
  // run from 13.7 to 5.6 min on a laptop. CI's runner has 2 cores, which the API, the CMS and one
  // browser already fill: 2 or 3 workers there saved under 10% and timed tests out (#249).
  fullyParallel: false,
  workers: process.env.CI ? 1 : 3,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: CMS_URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /phone|table-sources/ },
    // The real poller (GET /__scheduled) polls every org's due sources and pushes the rest back,
    // while spot-sources and integrations write their sources' polls by hand: so this spec runs
    // alone, after every other desktop spec.
    { name: 'poller', use: { ...devices['Desktop Chrome'] }, testMatch: /table-sources/, dependencies: ['desktop'] },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone/ },
  ],
});
