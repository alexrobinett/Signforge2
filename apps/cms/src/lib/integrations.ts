/**
 * The Integrations page (issue #80, canvas board Integrations): the org's data sources as
 * `list_data_sources` shows them, a failing one in words, and the catalogue of connectors with
 * what is built and what is planned. Only the built ones do anything; the roadmap is #81.
 */

/** One data source as `list_data_sources` lists it. Its feed URL is sealed and never shown. */
export interface ListedSource {
  id: string;
  name: string;
  format: SourceFormat;
  refreshS: number;
  horizonDays: number | null;
  nextPollAt: number;
  /** Polls in a row that failed. */
  failures: number;
  /** The poller's category for the last failure (`PollError` in apps/api). */
  lastError: string | null;
  version: number;
  /** The data screens have now: when it was fetched, and when a poll last found it still current. Null before a good poll. */
  lastFetchedAt: number | null;
  lastCheckedAt: number | null;
  spots: { id: string; name: string }[];
}

type SourceFormat = 'json' | 'ical' | 'rss';

export type ConnectorState = 'built' | 'planned' | 'later';

export interface Connector {
  /** The tile's letters. */
  mono: string;
  name: string;
  does: string;
  state: ConnectorState;
  /** A built connector that makes data sources: the format of the sources it makes. */
  format?: SourceFormat;
}

interface ConnectorGroup {
  name: string;
  why: string;
  items: Connector[];
}

const planned = (mono: string, name: string, does: string): Connector => ({ mono, name, does, state: 'planned' });
const later = (mono: string, name: string, does: string): Connector => ({ mono, name, does, state: 'later' });

/** The board's catalogue, in its order. */
export const CATALOGUE: ConnectorGroup[] = [
  {
    name: 'Live data for templates',
    why: 'Fill news, weather and agenda fields from a source, refreshed on a timer.',
    items: [
      { mono: 'RSS', name: 'RSS / Atom', does: 'Headlines for the News template.', state: 'built', format: 'rss' },
      { mono: 'WX', name: 'Weather', does: 'Current conditions and forecast for a place, into the Weather template.', state: 'built', format: 'json' },
      { mono: 'iCal', name: 'iCal URL', does: 'Any calendar that publishes an .ics link, into the Agenda template.', state: 'built', format: 'ical' },
      planned('GC', 'Google Calendar', 'Pick calendars and rooms after signing in with Google; no public links.'),
      planned('365', 'Microsoft 365 / Outlook', 'Calendars and room resources from Exchange Online.'),
      planned('GS', 'Google Sheets', 'A sheet as a menu or price list; one row per item.'),
      planned('{ }', 'CSV or JSON URL', 'Any file on the web, mapped onto template fields.'),
      planned('AT', 'Airtable', 'A base and view as rows for menus, rotas or listings.'),
      planned('POST', 'Webhook push', 'Your system POSTs JSON into a data source when something changes.'),
    ],
  },
  {
    name: 'Point of sale and menus',
    why: 'Prices, stock and sold-out items straight from the till.',
    items: [
      planned('SQ', 'Square', 'Item prices and sold-out flags for menu boards.'),
      planned('TO', 'Toast', 'Menus, prices and 86’d items for restaurants.'),
      planned('SH', 'Shopify', 'Product prices and stock for promos.'),
      planned('CL', 'Clover', 'Inventory prices and stock levels.'),
    ],
  },
  {
    name: 'Content import',
    why: 'Bring in photos and finished designs as image spots.',
    items: [
      planned('GD', 'Google Drive', 'Pick images from a folder; new files show up as assets.'),
      planned('DB', 'Dropbox', 'The same, from a Dropbox folder.'),
      planned('CV', 'Canva', 'Send a design to SignForge as an image spot, landscape and portrait.'),
    ],
  },
  {
    name: 'Alerts and takeovers',
    why: 'Interrupt the loop in an emergency, and tell people what screens are doing.',
    items: [
      planned('CAP', 'Emergency alerts (CAP, NWS)', 'A matching alert takes over screens in the affected area until it expires.'),
      planned('SL', 'Slack', 'Offline screens, finished publishes and takeovers in a channel.'),
      planned('MT', 'Microsoft Teams', 'The same alerts in a Teams channel.'),
      planned('@', 'Email alerts', 'Alerts to members by email. Sign-in codes already use email.'),
      planned('OUT', 'Outgoing webhooks', 'We POST to your URL when a screen goes offline or a publish finishes.'),
    ],
  },
  {
    name: 'Sign-in and directory',
    why: 'Let people sign in with the accounts they already have.',
    items: [
      later('GW', 'Google Workspace', 'Sign in with Google; restrict to your domain.'),
      later('ME', 'Microsoft Entra ID', 'Sign in with Microsoft work accounts.'),
      later('SAML', 'SAML single sign-on', 'Any SAML identity provider.'),
      later('SCIM', 'SCIM provisioning', 'Members and roles follow your directory.'),
    ],
  },
  {
    name: 'Agents',
    why: 'For AI agents and scripts that edit spots and read screen state.',
    items: [{ mono: 'MCP', name: 'MCP server', does: 'Each agent or script signs in to one organization and gets only the scopes you grant.', state: 'built' }],
  },
];

export const SHOW = ['all', 'connected', 'built', 'planned', 'later'] as const;
export type Show = (typeof SHOW)[number];
export const isShow = (v: unknown): v is Show => SHOW.some((s) => s === v);

/** The sources a connector made. */
export const sourcesOf = (c: Connector, sources: readonly ListedSource[]) => (c.format ? sources.filter((s) => s.format === c.format) : []);

/** Whether the connector passes the filter and the search. */
export function shows(c: Connector, show: Show, q: string, sources: readonly ListedSource[]): boolean {
  const query = q.trim().toLowerCase();
  if (query && !`${c.name} ${c.does}`.toLowerCase().includes(query)) return false;
  if (show === 'all') return true;
  if (show === 'connected') return sourcesOf(c, sources).length > 0;
  return c.state === show;
}

/**
 * The kind of a source, as the page names it. A JSON source is weather: Open-Meteo is the only
 * JSON feed the CMS offers (a CSV or JSON URL connector is planned), and agents that add another
 * see it named so too.
 */
export const KIND_WORD: Record<SourceFormat, string> = { rss: 'RSS', json: 'Weather', ical: 'iCal' };

const NOUN: Record<SourceFormat, [one: string, many: string]> = { rss: ['feed', 'feeds'], json: ['place', 'places'], ical: ['calendar', 'calendars'] };

/** "2 feeds", "1 calendar · failing": a built connector's sources, counted. */
export function connectedWords(format: SourceFormat, sources: readonly ListedSource[]): string {
  const [one, many] = NOUN[format];
  const failing = sources.some((s) => s.failures > 0);
  return `${sources.length} ${sources.length === 1 ? one : many}${failing ? ' · failing' : ''}`;
}

/** Why a poll failed, from the poller's category (`PollError` in apps/api), as what the feed does. */
function failureWords(code: string | null): string {
  switch (code) {
    case 'timeout':
      return 'takes too long to answer';
    case 'http-status':
      return 'answers with an error';
    case 'dns':
    case 'network':
      return 'cannot be reached';
    case 'private-address':
    case 'blocked-address':
    case 'ip-literal':
      return 'points at a private address';
    case 'too-many-redirects':
      return 'redirects too many times';
    case 'too-large':
      return 'is larger than a screen may hold';
    case 'doctype':
    case 'malformed':
    case 'unknown-format':
      return 'is not a feed SignForge can read';
    case 'unfit':
      return 'sends data that does not fit the spots using it';
    default:
      return `fails its check (${code ?? 'unknown'})`;
  }
}

/** How the page writes times: in the org's zone and locale, "9:40 AM" today and "Tue 9:40 AM" before. */
export interface Clock {
  timezone: string;
  locale: string;
  now: number;
}

export function clockTime(at: number, { timezone, locale, now }: Clock): string {
  const day = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: timezone });
  const time = new Date(at).toLocaleTimeString(locale, { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  return day(at) === day(now) ? time : `${new Date(at).toLocaleDateString(locale, { timeZone: timezone, weekday: 'short' })} ${time}`;
}

/** The source's state in a few words, for its row: its last good time, or that it is waiting or failing. */
export function sourceState(s: ListedSource, clock: Clock): { word: string; tone: 'ok' | 'waiting' | 'failing' } {
  if (s.failures > 0) return { word: `failed ${s.failures}×`, tone: 'failing' };
  if (s.lastCheckedAt === null || s.nextPollAt === 0) return { word: 'checking', tone: 'waiting' };
  return { word: clockTime(s.lastCheckedAt, clock), tone: 'ok' };
}

/**
 * A failing source in plain words: what its feed does, for how many checks, and what screens show
 * meanwhile ("The Break room calendar answers with an error at its last 2 checks. Its screens show
 * the 7:05 AM copy.").
 */
export function failingWords(s: ListedSource, clock: Clock): string {
  const what = `The ${s.name} ${NOUN[s.format][0]} ${failureWords(s.lastError)}`;
  const checks = s.failures === 1 ? 'at its last check' : `at its last ${s.failures} checks`;
  const meanwhile =
    s.lastCheckedAt === null ? 'Its spots show their fallback values until a check succeeds.' : `Its screens show the ${clockTime(s.lastCheckedAt, clock)} copy.`;
  return `${what} ${checks}. ${meanwhile}`;
}

/** What fixing a failing source is called: its address is what an editor can change. */
export const FIX_WORD: Record<SourceFormat, string> = { rss: 'Fix the feed URL', json: 'Fix the weather URL', ical: 'Fix the iCal URL' };
