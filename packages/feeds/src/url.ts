/**
 * The checks a feed URL must pass before anything is fetched, from its text alone: https on the
 * default port, naming a host rather than an IP address, and not a local name. The poller checks
 * every redirect with it and then the addresses the host resolves to; the data source tools check
 * a URL with it before storing it.
 */
export type FeedUrlProblem = 'bad-url' | 'not-https' | 'port' | 'ip-literal' | 'private-address';

export function feedUrlProblem(url: string): FeedUrlProblem | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'bad-url';
  }
  if (u.protocol !== 'https:') return 'not-https';
  // The URL parser drops the default port, and writes 2130706433 and 0x7f.1 as 127.0.0.1.
  if (u.port !== '') return 'port';
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return 'ip-literal';
  if (!host.includes('.') || /\.(localhost|local|internal|home\.arpa|lan)$/.test(host)) return 'private-address';
  return undefined;
}

export const FEED_URL_PROBLEMS: Record<FeedUrlProblem, string> = {
  'bad-url': 'not a URL',
  'not-https': 'feeds must be https',
  port: 'feeds must use the default https port',
  'ip-literal': 'feeds must name a host, not an IP address',
  'private-address': 'the host is a local name',
};
