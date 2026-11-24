/**
 * The model calls' fetch, for TanStack AI's `wrapFetch` (#346): every request goes through the same
 * guards as apps/api's `guardedKeyedJson`, but answers with the streaming Response the adapters read.
 *
 * - The URL must pass `feedUrlProblem` (https, default port, a name, not an IP literal), and its host
 *   must resolve only to public addresses (the guards' `resolve`).
 * - Only the provider's own origin is reached: a request elsewhere is refused before it is sent, and
 *   a redirect is never followed, since the request carries the key.
 * - The headers are rebuilt from an allow-list, the key set here: whatever the adapter merged from
 *   `process.env` (`ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_CUSTOM_HEADERS`, `OPENAI_ORG_ID`) is dropped.
 * - One deadline per model call (`AbortSignal.timeout`), with the caller's signal.
 *
 * apps/api keeps its address checks private to src/data/fetch.ts and has no guarded fetch that hands
 * back a streaming Response, so `isPrivate` below is a copy of its checks. #349 should export one
 * (`guardedStream`) from there instead of copying.
 */
import { FEED_URL_PROBLEMS, feedUrlProblem } from '@signforge/feeds';
import type { FetchWrapper } from '@tanstack/ai';

/** What the guards fetch and resolve with: the Worker's own, or a test's stubs. As apps/api's `FetchGuards`. */
export interface FetchGuards {
  fetch: typeof fetch;
  resolve: (host: string, signal: AbortSignal) => Promise<string[]>;
  timeoutMs: number;
}

export class GuardError extends Error {
  readonly code: 'blocked' | 'elsewhere' | 'redirect' | 'timeout';
  constructor(message: string, options: ErrorOptions & { code: GuardError['code'] }) {
    super(message, options);
    this.code = options.code;
  }
}

/** The headers a provider call may carry, besides the key, which is set here. */
const ALLOWED = ['accept', 'content-type', 'anthropic-version', 'anthropic-beta'];

/**
 * A `wrapFetch` for one provider: requests go only to `origin`, with `key` as `auth`, through the
 * guards. The adapter's own fetch (`next`) is never called: the guards' fetch sends the request.
 */
export function guardedModelFetch(origin: string, auth: { header: 'x-api-key' | 'authorization'; value: string }, guards: FetchGuards): FetchWrapper {
  return () => async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) throw new GuardError(`a model call goes only to ${origin}, not ${url.origin}`, { code: 'elsewhere' });
    const problem = feedUrlProblem(url.href);
    if (problem) throw new GuardError(FEED_URL_PROBLEMS[problem], { code: 'blocked' });
    const deadline = AbortSignal.timeout(guards.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const addresses = await guards.resolve(url.hostname, signal);
    if (!addresses.length || addresses.some(isPrivate)) throw new GuardError('the host resolves to a private or reserved address', { code: 'blocked' });
    const headers = new Headers();
    for (const name of ALLOWED) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set(auth.header, auth.value);
    try {
      const res = await guards.fetch(url.href, { method: request.method, headers, body: await request.text(), redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new GuardError(`the provider redirected (${res.status}); a request with a key follows no redirect`, { code: 'redirect' });
      }
      return res;
    } catch (err) {
      if (deadline.aborted) throw new GuardError(`no answer in ${guards.timeoutMs / 1000} seconds`, { code: 'timeout', cause: err });
      throw err;
    }
  };
}

// A copy of apps/api/src/data/fetch.ts's address checks (see above).
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
const isIpv4 = (host: string) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host);
const v4Number = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const isPrivateV4 = (n: number) => V4_RESERVED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
const V6_RESERVED: [bigint, number][] = [
  [0x2001n << 112n, 23],
  [0x2001_0db8n << 96n, 32],
  [0x2002n << 112n, 16],
  [0x3fffn << 112n, 20],
];
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
  if (n === null) return true;
  if (n >> 32n === 0xffffn) return isPrivateV4(Number(n & 0xffff_ffffn));
  if (n >> 125n !== 1n) return true;
  return V6_RESERVED.some(([base, bits]) => n >> BigInt(128 - bits) === base >> BigInt(128 - bits));
}
