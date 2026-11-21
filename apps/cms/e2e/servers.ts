import { readFileSync, watch } from 'node:fs';
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
/** The dev API's deploy secret for this run, which turns on `/admin` (how `sf push` publishes, and seeding templates). */
export const ADMIN_TOKEN = 'e2e-admin-token';

/** Scratch space for one run: the API's log, local D1 state and the dev registry. */
export const RUN_DIR = fileURLToPath(new URL('../.e2e/', import.meta.url));
export const API_LOG = `${RUN_DIR}api.log`;
/** What the run's file server serves, by file name, for every feed the API fetches (`FEED_STUB_URL`, global-setup.ts). */
export const FEEDS_DIR = `${RUN_DIR}feeds/`;

/** How many codes have been read for each email, so a second sign-in waits for its own code. */
const codesRead = new Map<string, number>();

/**
 * The newest sign-in code the dev API printed for `email`, as a developer would read it, once one
 * more has been printed than were read before: a second sign-in never gets the first one's code
 * from a log the API has not written the new one to yet. It watches the log and reads it again on
 * each change, never on a clock; the test's own timeout bounds the wait.
 */
export function codeFor(email: string, log = API_LOG): Promise<string> {
  const pattern = new RegExp(`\\[email\\] to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Your SignForge code: (\\d{6})`, 'g');
  const read = codesRead.get(email) ?? 0;
  return new Promise((resolve) => {
    let done = false;
    const watcher = watch(log, () => check());
    function check() {
      if (done) return;
      const matches = [...readFileSync(log, 'utf8').matchAll(pattern)];
      const code = matches.length > read ? matches.at(-1)?.[1] : undefined;
      if (code === undefined) return;
      done = true;
      watcher.close();
      codesRead.set(email, matches.length);
      resolve(code);
    }
    check();
    // On macOS the watch is armed (kqueue) at the event loop's next poll, and a write before then
    // sends no event: read once more after a poll has surely run. An immediate set from inside an
    // immediate runs after the next poll, whichever phase this is called in. On Linux (inotify) the
    // watch is armed at once. Ordering, not a wait.
    setImmediate(() => setImmediate(check));
  });
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
