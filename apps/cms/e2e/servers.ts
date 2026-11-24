import { readFileSync, watch } from 'node:fs';
import { createServer } from 'node:net';
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

/** The one key the run's Anthropic stub accepts (global-setup.ts), and the models it lists for it. */
export const ANTHROPIC_STUB_KEY = 'sk-ant-e2e-stub-key-0000000000000000-Ab12';
export const ANTHROPIC_STUB_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
/** What the Anthropic stub's model fills from any flyer (#263): Photo Promo's fields, and the spot's name. */
export const STUB_FILL = { name: 'Harbour bake sale', eyebrow: 'Saturday', headline: 'Harbour bake sale', body: 'Scones, tea and a raffle', price: '$2.50' };
/** What the Anthropic stub's model reads from any menu (#264): today's items, the latte dearer, the mocha gone, a flat white new. */
export const STUB_MENU = {
  name: 'Menu',
  items: [
    { name: 'Latte', price: '$4.75' },
    { name: 'Scone', price: '$3.00' },
    { name: 'Flat white', price: '$4.00' },
  ],
};
/** The drawer's answer from the Anthropic stub (#267): a diagnosis of two Bayside screens, and a note to copy. */
export const STUB_CARD = {
  text: 'Both Bayside screens went quiet in the same minute, 09:14: that points to the store, not the two players.',
  groups: [{ title: 'Bayside, quiet since 09:14', screens: ['Bayside door', 'Bayside till'], why: 'They miss revision 12, the new breakfast menu.' }],
  steps: [{ label: 'Copy a note for the store', note: 'Both screens at Bayside went offline at 09:14. Could you check the router by the till?' }],
};
/** What the drawer's stub drafts on a spot (#268): a punchier headline and a QR link, and its answer. */
export const STUB_DRAFT = { headline: 'Hot breakfast, fast', qrUrl: 'https://order.example/menu' };
export const STUB_DRAFTED = { text: 'I drafted a punchier headline and a QR link to the menu. Check the link before you save.' };
/** The drawer's answer once a takeover it asked for was pressed (#269). */
export const STUB_TAKEN = { text: 'Every screen plays the storm closure for the next hour. End it from the Schedule when Bayside reopens.' };
/** What it answers once a cancelled invitation's card is pressed (#321). */
export const STUB_CANCELLED = { text: 'The invitation is cancelled: its link no longer works. Only an owner can invite them again.' };
/** The one key the run's OpenAI-compatible stub accepts at any host's /v1/models (the feed server, global-setup.ts), and its models (#262). */
export const ENDPOINT_STUB_KEY = 'sk-e2e-endpoint-stub-key-000000000000-Cd34';
export const ENDPOINT_STUB_MODELS = ['gemini-stub-flash', 'gemini-stub-pro'];

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
  return new Promise((resolve, reject) => {
    let done = false;
    const watcher = watch(log, () => check());
    // A test that fails or times out leaves its wait behind: the watch never keeps the worker running,
    // and its email (each test's own) gets no other code to read. An error from the watch closes it.
    watcher.unref();
    watcher.on('error', (err) => finish(() => reject(err)));
    function finish(then = () => {}) {
      done = true;
      watcher.close();
      then();
    }
    function check() {
      if (done) return;
      const matches = [...readFileSync(log, 'utf8').matchAll(pattern)];
      const code = matches.length > read ? matches.at(-1)?.[1] : undefined;
      if (code === undefined) return;
      finish(() => {
        codesRead.set(email, matches.length);
        resolve(code);
      });
    }
    check();
    // macOS arms the watch (kqueue) at the loop's next poll; a write before that sends no event.
    // A nested immediate runs after that poll from any phase, so read once more then.
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

/**
 * Whether anything holds `port` on a loopback or wildcard address: another checkout's run, or any
 * other server, which this run's tests would otherwise talk to. Found by binding it, not by asking it
 * over HTTP: the CMS is `localhost`, which may resolve to ::1 alone, and a holder need not answer
 * HTTP (#214). macOS lets a loopback bind beside a wildcard holder, so the wildcards are tried too.
 */
export async function portTaken(port: number) {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
    const free = await new Promise<boolean>((resolve, reject) => {
      const probe = createServer();
      // A host with no IPv6 (EADDRNOTAVAIL, EAFNOSUPPORT) has nothing that could hold the port there.
      probe.once('error', (err: NodeJS.ErrnoException) =>
        err.code === 'EADDRINUSE' ? resolve(false) : err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' ? resolve(true) : reject(err),
      );
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (!free) return true;
  }
  return false;
}
