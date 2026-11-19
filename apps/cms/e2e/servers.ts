import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fixed unless set, so two checkouts can run the e2e at once on different ports (`E2E_API_PORT=8807 E2E_CMS_PORT=4007`). */
const port = (name: string, fallback: number) => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${name} must be a port number, 1024 to 65535`);
  return n;
};
export const API_PORT = port('E2E_API_PORT', 8797);
export const CMS_PORT = port('E2E_CMS_PORT', 3997);
export const CMS_URL = `http://localhost:${CMS_PORT}`;
/** The dev API's deploy secret for this run, which turns on `/admin` (how `sf push` publishes until M3-18). */
export const ADMIN_TOKEN = 'e2e-admin-token';

/** Scratch space for one run: the API's log, local D1 state and the dev registry. */
export const RUN_DIR = fileURLToPath(new URL('../.e2e/', import.meta.url));
export const API_LOG = `${RUN_DIR}api.log`;

/** The newest sign-in code the dev API printed for `email`, as a developer would read it. */
export async function codeFor(email: string, timeoutMs = 10_000): Promise<string> {
  const pattern = new RegExp(`\\[email\\] to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Your SignForge code: (\\d{6})`, 'g');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = [...readFileSync(API_LOG, 'utf8').matchAll(pattern)];
    const last = matches.at(-1)?.[1];
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code for ${email} in ${API_LOG}`);
}

/** What the geocoding stub knows (global-setup.ts), in Open-Meteo's own shape: two Atlantas, so the pick matters. */
export const PLACES = [
  {
    id: 4180439,
    name: 'Atlanta',
    latitude: 33.749,
    longitude: -84.38798,
    timezone: 'America/New_York',
    country: 'United States',
    country_code: 'US',
    admin1: 'Georgia',
  },
  {
    id: 4830198,
    name: 'Atlanta',
    latitude: 34.17,
    longitude: -86.06,
    timezone: 'America/Chicago',
    country: 'United States',
    country_code: 'US',
    admin1: 'Alabama',
  },
  {
    id: 3413829,
    name: 'Reykjavík',
    latitude: 64.13548,
    longitude: -21.89541,
    timezone: 'Atlantic/Reykjavik',
    country: 'Iceland',
    country_code: 'IS',
    admin1: 'Capital Region',
  },
];
