/**
 * Fetching a feed URL a user typed (docs/backend-plan.md, Data sources, Fetch safety). Every hop
 * is checked before it is requested: https on the default port, a hostname rather than an IP
 * address, and a name that does not resolve to a private or reserved address. Redirects are
 * followed by hand, at most 3, each checked again. The whole fetch has 5 seconds, under one
 * signal: every DNS lookup, every hop and the body read. The body may be 1 MB. A failure is a `FetchError` with a category; the upstream body is never echoed.
 *
 * A Worker cannot pin the address it resolved, so the DNS check is a first filter and not the
 * defence against rebinding: that is Workers' outbound requests, which cannot reach private
 * networks. Cloudflare answers such a request itself (403 `error code: 1003` for an address, 530
 * `error code: 1016` for a name that resolves to one), and that is reported as a blocked address.
 */
import { FEED_URL_PROBLEMS, feedUrlProblem, LIMITS, type FeedUrlProblem } from '@signforge/feeds';

export const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

export type FetchErrorCode = FeedUrlProblem | 'dns' | 'blocked-address' | 'too-many-redirects' | 'timeout' | 'http-status' | 'too-large' | 'network';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  /** The feed's HTTP status, for `http-status` and `blocked-address`. */
  readonly status?: number;
  constructor(message: string, options: ErrorOptions & { code: FetchErrorCode; status?: number }) {
    super(message, options);
    this.name = 'FetchError';
    this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** What the guards fetch and resolve with. The poller passes the Worker's own; tests stub both. */
export interface FetchGuards {
  fetch: typeof fetch;
  /** Every A and AAAA address of `host`, given up when `signal` aborts. */
  resolve: (host: string, signal: AbortSignal) => Promise<string[]>;
  timeoutMs?: number;
}

export type FetchResult = { status: 'not-modified' } | { status: 'ok'; body: string; etag: string | null; lastModified: string | null };

/** Fetch `url` with the guards, asking conditionally with the validators the last answer gave. */
export async function guardedFetch(url: string, last: { etag?: string | null; lastModified?: string | null }, guards: FetchGuards): Promise<FetchResult> {
  const signal = AbortSignal.timeout(guards.timeoutMs ?? FETCH_TIMEOUT_MS);
  const headers = new Headers({
    accept: 'application/json, application/rss+xml, application/atom+xml, text/calendar, */*;q=0.5',
    'user-agent': 'SignForge feed poller',
  });
  if (last.etag) headers.set('if-none-match', last.etag);
  if (last.lastModified) headers.set('if-modified-since', last.lastModified);
  try {
    let next = await checkedUrl(url, guards, signal);
    for (let hop = 0; ; hop++) {
      const res = await guards.fetch(next, { headers, redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (!location) throw new FetchError(`redirect ${res.status} without a location`, { code: 'http-status', status: res.status });
        if (hop === MAX_REDIRECTS) throw new FetchError(`more than ${MAX_REDIRECTS} redirects`, { code: 'too-many-redirects' });
        next = await checkedUrl(new URL(location, next).href, guards, signal);
        continue;
      }
      if (res.status === 304) return { status: 'not-modified' };
      if (!res.ok) {
        const text = await capped(res, 256).catch(() => '');
        if (/^error code: 10(03|16)\b/.test(text))
          throw new FetchError('Cloudflare refused to reach the address', { code: 'blocked-address', status: res.status });
        throw new FetchError(`the feed answered ${res.status}`, { code: 'http-status', status: res.status });
      }
      return { status: 'ok', body: await capped(res, LIMITS.maxBytes), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (signal.aborted) throw new FetchError(`no answer in ${(guards.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000} seconds`, { code: 'timeout', cause: e });
    throw new FetchError('the feed could not be reached', { code: 'network', cause: e });
  }
}

/** `url` if it may be fetched; otherwise the guard it fails. */
async function checkedUrl(url: string, guards: FetchGuards, signal: AbortSignal): Promise<string> {
  const problem = feedUrlProblem(url);
  if (problem) throw new FetchError(FEED_URL_PROBLEMS[problem], { code: problem });
  const { href, hostname } = new URL(url);
  const addresses = await guards.resolve(hostname, signal).catch((e: unknown) => {
    if (e instanceof FetchError) throw e;
    throw new FetchError(signal.aborted ? 'no DNS answer before the deadline' : 'DNS lookup failed', { code: 'dns', cause: e });
  });
  if (!addresses.length) throw new FetchError('the host does not resolve', { code: 'dns' });
  if (addresses.some(isPrivate)) throw new FetchError('the host resolves to a private or reserved address', { code: 'private-address' });
  return href;
}

/** Read at most `max` bytes of the body as UTF-8; a longer one is a `too-large` refusal. */
async function capped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new FetchError(`the feed is over ${max} bytes`, { code: 'too-large' });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const isIpv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** IPv4 ranges that are not the public internet, as [network, prefix length]. */
const V4_RESERVED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4Number = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

function isPrivate(address: string): boolean {
  if (isIpv4(address)) {
    const n = v4Number(address);
    return V4_RESERVED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
  }
  const a = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isPrivate(mapped[1] ?? '');
  // Unspecified, loopback, NAT64, documentation, unique local (fc00::/7), link-local (fe80::/10), multicast.
  return a === '::' || a === '::1' || a.startsWith('64:ff9b:') || a.startsWith('2001:db8:') || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
}

/**
 * `resolve` for the Worker: Cloudflare's DNS over HTTPS, A and AAAA at once. A name with neither
 * resolves to nothing, which the guard refuses.
 */
export function dohResolver(fetcher: typeof fetch): FetchGuards['resolve'] {
  return async (host, signal) => {
    const ask = async (type: 'A' | 'AAAA') => {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal,
      });
      if (!res.ok) throw new FetchError(`DNS lookup failed (${res.status})`, { code: 'dns' });
      const body: { Answer?: { type: number; data: string }[] } = await res.json();
      // 1 is A and 28 is AAAA; a CNAME's own record (5) is followed by the resolver and left out here.
      return (body.Answer ?? []).filter((r) => r.type === 1 || r.type === 28).map((r) => r.data);
    };
    return (await Promise.all([ask('A'), ask('AAAA')])).flat();
  };
}
