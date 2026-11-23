/**
 * Fetching a feed URL a user typed (docs/backend-plan.md, Data sources, Fetch safety). Every hop
 * is checked before it is requested: https on the default port, a hostname rather than an IP
 * address, and a name that does not resolve to a private or reserved address. Redirects are
 * followed by hand, at most 3, each checked again. The whole fetch has 5 seconds, under one
 * signal: every DNS lookup, every hop and the body read. A feed's body may be 1 MB, a story's
 * photo's (`guardedImageFetch`) 8 MB. A failure is a `FetchError` with a category; the upstream
 * body is never echoed.
 *
 * A Worker cannot pin the address it resolved, so the DNS check is a first filter and not the
 * defence against rebinding: that is Workers' outbound requests, which cannot reach private
 * networks. Cloudflare answers such a request itself (403 `error code: 1003` for an address, 530
 * `error code: 1016` for a name that resolves to one), and that is reported as a blocked address.
 */
import { FEED_URL_PROBLEMS, feedUrlProblem, LIMITS, type FeedUrlProblem } from '@signforge/feeds';

export const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

export type FetchErrorCode =
  | FeedUrlProblem
  | 'dns'
  | 'blocked-address'
  | 'too-many-redirects'
  | 'redirect-elsewhere'
  | 'timeout'
  | 'http-status'
  | 'too-large'
  | 'network';

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

export type FetchResult<Body = string> = { status: 'not-modified' } | { status: 'ok'; body: Body; etag: string | null; lastModified: string | null };

/** The validators the last answer gave, for a conditional request. */
type Validators = { etag?: string | null; lastModified?: string | null };

/** The most a story's photo may be. A larger one is refused by its `Content-Length` before any of it is read, or as it is read past this. */
const IMAGE_MAX_BYTES = 8_000_000;

/** Fetch `url` with the guards, asking conditionally with the validators the last answer gave. */
export function guardedFetch(url: string, last: Validators, guards: FetchGuards): Promise<FetchResult> {
  return guardedGet(url, last, guards, 'application/json, application/rss+xml, application/atom+xml, text/calendar, */*;q=0.5', async (res) =>
    new TextDecoder().decode(await capped(res, LIMITS.maxBytes)),
  );
}

/** Fetch a story's photo with the guards, as bytes: what they are is read from them, never from the headers. */
export function guardedImageFetch(url: string, last: Validators, guards: FetchGuards): Promise<FetchResult<Uint8Array>> {
  return guardedGet(url, last, guards, 'image/avif, image/webp, image/png, image/jpeg, */*;q=0.5', async (res) => {
    if (Number(res.headers.get('content-length')) > IMAGE_MAX_BYTES) {
      await res.body?.cancel();
      throw new FetchError(`the image is over ${IMAGE_MAX_BYTES} bytes`, { code: 'too-large' });
    }
    return capped(res, IMAGE_MAX_BYTES);
  });
}

/**
 * GET JSON from an org's model endpoint with its key (#262): the guards on every hop, and a redirect
 * followed only within the endpoint's own origin, since the request carries the key. The body is
 * parsed, not trusted: the caller reads what it needs from it.
 */
export async function guardedKeyedJson(url: string, apiKey: string, guards: FetchGuards): Promise<unknown> {
  const result = await guardedGet(
    url,
    {},
    guards,
    'application/json',
    async (res) => JSON.parse(new TextDecoder().decode(await capped(res, LIMITS.maxBytes))),
    {
      headers: { authorization: `Bearer ${apiKey}`, 'user-agent': 'SignForge agent' },
      sameOrigin: true,
    },
  );
  if (result.status !== 'ok') throw new FetchError('it answered 304 to a request with no validators', { code: 'http-status', status: 304 });
  return result.body;
}

/**
 * A GET of `url` through the guards, every hop checked, its 2xx body read by `read` within the deadline.
 * `headers` are added to each hop's; with `sameOrigin`, a redirect to another origin is refused.
 */
async function guardedGet<Body>(
  url: string,
  last: Validators,
  guards: FetchGuards,
  accept: string,
  read: (res: Response) => Promise<Body>,
  options: { headers?: Record<string, string>; sameOrigin?: boolean } = {},
): Promise<FetchResult<Body>> {
  const signal = AbortSignal.timeout(guards.timeoutMs ?? FETCH_TIMEOUT_MS);
  const headers = new Headers({ accept, 'user-agent': 'SignForge feed poller', ...options.headers });
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
        const to = new URL(location, next);
        if (options.sameOrigin && to.origin !== new URL(next).origin)
          throw new FetchError(`it redirected to another origin (${to.origin})`, { code: 'redirect-elsewhere', status: res.status });
        next = await checkedUrl(to.href, guards, signal);
        continue;
      }
      if (res.status === 304) return { status: 'not-modified' };
      if (!res.ok) {
        if (/^error code: 10(03|16)\b/.test(await answered(res)))
          throw new FetchError('Cloudflare refused to reach the address', { code: 'blocked-address', status: res.status });
        throw new FetchError(`it answered ${res.status}`, { code: 'http-status', status: res.status });
      }
      return { status: 'ok', body: await read(res), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (signal.aborted) throw new FetchError(`no answer in ${(guards.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000} seconds`, { code: 'timeout', cause: e });
    throw new FetchError('it could not be reached', { code: 'network', cause: e });
  }
}

/**
 * POST `body` to a URL a user gave (an alert channel, #88), with the same guards as a feed: the URL
 * and every address its host resolves to checked, 5 seconds in all, Cloudflare's refusal reported as
 * a blocked address. A redirect is not followed, as the body would go somewhere not checked when it
 * was set; it is a failure with its status. Resolves with the receiver's 2xx status; the body it
 * answers with is read no further.
 */
export async function guardedPost(url: string, body: string, headers: Headers, guards: FetchGuards): Promise<number> {
  const signal = AbortSignal.timeout(guards.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await guards.fetch(await checkedUrl(url, guards, signal), { method: 'POST', headers, body, redirect: 'manual', signal });
    if (res.ok) {
      await res.body?.cancel();
      return res.status;
    }
    if (/^error code: 10(03|16)\b/.test(await answered(res)))
      throw new FetchError('Cloudflare refused to reach the address', { code: 'blocked-address', status: res.status });
    throw new FetchError(`the receiver answered ${res.status}`, { code: 'http-status', status: res.status });
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (signal.aborted) throw new FetchError(`no answer in ${(guards.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000} seconds`, { code: 'timeout', cause: e });
    throw new FetchError('the receiver could not be reached', { code: 'network', cause: e });
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

/** The start of a refusal's body, for Cloudflare's own error codes; '' if it is longer or cannot be read. */
const answered = async (res: Response) => new TextDecoder().decode(await capped(res, 256).catch(() => new Uint8Array()));

/** Read at most `max` bytes of the body; a longer one is a `too-large` refusal. */
async function capped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new FetchError(`the body is over ${max} bytes`, { code: 'too-large' });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

const isIpv4 = (host: string) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host);

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

const isPrivateV4 = (n: number) => V4_RESERVED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));

/**
 * Ranges inside global unicast (2000::/3) that are not the public internet, as [network, prefix
 * length]. Everything outside 2000::/3 is refused whole: unique local, link-local, site-local,
 * multicast, NAT64, discard and the unassigned rest.
 */
const V6_RESERVED: [bigint, number][] = [
  [0x2001n << 112n, 23], // IETF protocol assignments: Teredo (2001::/32), benchmarking, ORCHID
  [0x2001_0db8n << 96n, 32], // documentation
  [0x2002n << 112n, 16], // 6to4, which carries an IPv4 address of any kind
  [0x3fffn << 112n, 20], // documentation (RFC 9637)
];

/** The 128 bits an IPv6 address names, in any of its text forms; null if `text` is not one. */
function v6Number(text: string): bigint | null {
  let hex = text;
  const dotted = /^(.*:)([^:]*)$/.exec(text);
  if (dotted?.[2]?.includes('.')) {
    if (!isIpv4(dotted[2])) return null;
    const n = v4Number(dotted[2]);
    hex = `${dotted[1]}${Math.floor(n / 0x10000).toString(16)}:${(n % 0x10000).toString(16)}`;
  }
  const halves = hex.split('::');
  if (halves.length > 2) return null;
  const [left, right] = halves.map((half) => (half ? half.split(':') : []));
  const gap = 8 - (left?.length ?? 0) - (right?.length ?? 0);
  if (right ? gap < 1 : gap !== 0) return null;
  const groups = [...(left ?? []), ...Array<string>(gap).fill('0'), ...(right ?? [])];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((n, g) => (n << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

function isPrivate(address: string): boolean {
  if (isIpv4(address)) return isPrivateV4(v4Number(address));
  const n = v6Number(address);
  // The resolver's answer is untrusted: one that is no address is refused, not fetched.
  if (n === null) return true;
  // IPv4-compatible (::/96, which holds :: and ::1) and IPv4-mapped (::ffff:0:0/96) reach the IPv4 address they carry.
  if (n >> 32n === 0n || n >> 32n === 0xffffn) return isPrivateV4(Number(n & 0xffff_ffffn));
  if (n >> 125n !== 1n) return true;
  return V6_RESERVED.some(([base, bits]) => n >> BigInt(128 - bits) === base >> BigInt(128 - bits));
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

/** What a stubbed name resolves to in dev: a public address (TEST-NET would be refused as reserved). */
const STUB_ADDRESS = '93.184.215.14';

/**
 * The guards every feed fetch uses: the poller's and `read_table`'s. In dev only, `FEED_STUB_URL`
 * names an origin (the CMS e2e's file server) that answers for every host, the path and query
 * kept, with each name resolving to a public address, so the URL checks still run on what was
 * typed: a deployed API never sends a feed request elsewhere, as GEOCODING_URL.
 */
export function feedGuards(env: { ENVIRONMENT: string; FEED_STUB_URL?: string }, fetcher: typeof fetch): FetchGuards {
  const stub = env.ENVIRONMENT === 'dev' ? env.FEED_STUB_URL : undefined;
  if (!stub) return { fetch: fetcher, resolve: dohResolver(fetcher) };
  return {
    resolve: async () => [STUB_ADDRESS],
    fetch: (input, init) => {
      const { pathname, search } = new URL(input instanceof Request ? input.url : input);
      return fetcher(new URL(`${pathname}${search}`, stub), init);
    },
  };
}
