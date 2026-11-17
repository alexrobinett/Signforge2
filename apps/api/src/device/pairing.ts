/**
 * Pairing (docs/backend-plan.md#screens), the screen's half. Before the bearer middleware: an
 * unpaired screen has no credential.
 *
 *   POST /v1/device/pair/start                  -> PairStartResponse: a code to show, a poll token to keep
 *   POST /v1/device/pair/poll  { pollToken }    -> PairPollResponse: waiting, expired, or paired with the credential (once)
 *
 * A member claims the code with the `claim_screen` tool (packages/tools/src/pairing.ts). Both calls
 * are rate limited per address (`PAIR_START_LIMIT`, `PAIR_POLL_LIMIT`); 429 carries `retry-after`.
 */
import type { PairPollResponse, PairStartResponse } from '@signforge/contract';
import { collectPairing, PAIRING_TTL_MS, startPairing } from '@signforge/db';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '@signforge/tools';
import type { Context } from 'hono';
import { hashSecret, mintCredential } from './credential';

type PairEnv = { Bindings: Env };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

const tooMany = () => json({ error: 'rate_limited', message: 'too many pairing requests from this address; try again in a minute' }, 429, { 'retry-after': '60' });

/** The caller's address as Cloudflare saw it. */
export const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? 'unknown';

const POLL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function randomCode(): string {
  // 256 is a multiple of the alphabet's 32 letters, so every letter is equally likely.
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  return [...bytes].map((b) => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pairStart(c: Context<PairEnv>): Promise<Response> {
  if (!(await c.env.PAIR_START_LIMIT.limit({ key: clientIp(c) })).success) return tooMany();
  const pollToken = randomToken();
  const pollTokenHash = await hashSecret(pollToken);
  const now = Date.now();
  // A clash with a live code is rare (a billion codes); pick another.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    if (await startPairing(c.env.DB, { code, pollTokenHash, now })) {
      const body: PairStartResponse = { code, pollToken, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() };
      return json(body);
    }
  }
  return json({ error: 'unavailable', message: 'no free pairing code; try again' }, 503);
}

export async function pairPoll(c: Context<PairEnv>): Promise<Response> {
  if (!(await c.env.PAIR_POLL_LIMIT.limit({ key: clientIp(c) })).success) return tooMany();
  let pollToken: unknown;
  try {
    pollToken = ((await c.req.json()) as { pollToken?: unknown } | null)?.pollToken;
  } catch {
    // Not JSON: refused below.
  }
  if (typeof pollToken !== 'string' || !POLL_TOKEN.test(pollToken)) return json({ error: 'invalid_input', message: 'send { pollToken } from pair/start' }, 400);
  const result: PairPollResponse = await collectPairing(c.env.DB, await hashSecret(pollToken), Date.now(), mintCredential);
  return json(result);
}
