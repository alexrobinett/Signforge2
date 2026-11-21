import { defineConfig, devices } from '@playwright/test';
import { CMS_URL } from './e2e/servers';

// `pnpm test:e2e`: starts the API (`wrangler dev`) and the CMS (`vite dev`) on their own ports,
// with a fresh local database and dev registry, then signs in, creates and switches orgs.
// Better Auth's rate limits apply, per address: each spec that signs in comes from its own
// (`fromAddress`, `signInAs` in e2e/helpers.ts), so their sign-ins never add up.
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: CMS_URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /phone/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone/ },
  ],
});
