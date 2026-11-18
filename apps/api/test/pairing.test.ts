// Pairing (M3-08): an unpaired screen gets a code and a poll token, a member claims the code with
// the claim_screen tool, and the screen's next poll collects its credential, once.
import type { PairPollResponse, PairStartResponse } from '@signforge/contract';
import { validatePairPollResponse, validatePairStartResponse } from '@signforge/contract';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, email, nextIp, testApp } from './client';

const BASE = 'https://api.test/v1/device';
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const device = (path: string, body: unknown, ip: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: JSON.stringify(body),
  });

async function start(ip = nextIp()): Promise<PairStartResponse & { ip: string }> {
  const res = await device('/pair/start', {}, ip);
  expect(res.status).toBe(200);
  const body = (await res.json()) as PairStartResponse;
  expect(validatePairStartResponse(body)).toEqual([]);
  return { ...body, ip };
}

async function poll(p: { pollToken: string; ip: string }): Promise<PairPollResponse> {
  const res = await device('/pair/poll', { pollToken: p.pollToken }, p.ip);
  expect(res.status).toBe(200);
  const body = (await res.json()) as PairPollResponse;
  expect(validatePairPollResponse(body)).toEqual([]);
  return body;
}

const claimInput = (code: string) => ({ code, name: 'Lobby', timezone: 'Europe/London', orientation: 'landscape' });

const t = testApp();
let owner: Client;
let orgId: string;
beforeAll(async () => {
  owner = new Client(t);
  await owner.signIn(email('pair-owner'));
  orgId = (await owner.createOrg('Pairing')).id;
  await owner.setActive(orgId);
});

describe('pairing', () => {
  it('makes a screen of the kind the screen says it is at start, a device by default', async () => {
    const browser = await device('/pair/start', { kind: 'browser' }, nextIp());
    const { code } = (await browser.json()) as PairStartResponse;
    const claimed = (await (await owner.tool('claim_screen', claimInput(code))).json()) as { screen: { kind: string } };
    expect(claimed.screen.kind).toBe('browser');
    const plain = await start();
    expect(((await (await owner.tool('claim_screen', claimInput(plain.code))).json()) as { screen: { kind: string } }).screen.kind).toBe('device');
    // No body at all, as players before M3-41 send it, is a device too.
    const empty = await exports.default.fetch(`${BASE}/pair/start`, { method: 'POST', headers: { 'cf-connecting-ip': nextIp() } });
    expect(empty.status).toBe(200);
    expect((await device('/pair/start', { kind: 'tv' }, nextIp())).status).toBe(400);
  });

  it('a claimed code gives the screen its credential, and the credential works', async () => {
    const p = await start();
    expect(p.code).toMatch(CODE);
    const ttl = Date.parse(p.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(await poll(p)).toEqual({ status: 'waiting' });

    // Typed as people type it: lower case, with a space.
    const typed = `${p.code.slice(0, 3).toLowerCase()} ${p.code.slice(3)}`;
    const res = await owner.tool('claim_screen', claimInput(typed));
    const claimed = (await res.json()) as { screen: { id: string; name: string; timezone: string; status: string } };
    expect(res.status, JSON.stringify(claimed)).toBe(200);
    expect(claimed.screen).toMatchObject({ name: 'Lobby', timezone: 'Europe/London', status: 'active' });

    // The first reply is lost: the repeat poll gets a fresh credential, and the lost one is dead.
    const lost = (await poll(p)) as { status: string; credential: string };
    expect(lost).toMatchObject({ status: 'paired', screenId: claimed.screen.id });
    const paired = await poll(p);
    expect(paired).toMatchObject({ status: 'paired', screenId: claimed.screen.id });
    const credential = (paired as { credential: string }).credential;
    expect(credential).not.toBe(lost.credential);
    const manifestWith = (cred: string) => exports.default.fetch(`${BASE}/manifest.json`, { headers: { authorization: `Bearer ${cred}` } });
    expect((await manifestWith(lost.credential)).status).toBe(401);
    // Authenticated: nothing is published yet, which is a 404, not a 401.
    expect((await manifestWith(credential)).status).toBe(404);
    // Used now, so a further poll is refused and the credential stays.
    expect(await poll(p)).toEqual({ status: 'expired' });
    expect((await manifestWith(credential)).status).toBe(404);

    const screen = (await (await owner.tool('get_screen', { screenId: claimed.screen.id })).json()) as { credentials: unknown[] };
    expect(screen.credentials).toHaveLength(1);
  });

  it('refuses an unknown code, a code claimed already, and a malformed one', async () => {
    expect((await owner.tool('claim_screen', claimInput('ZZZZZZ'))).status).toBe(404);
    const p = await start();
    expect((await owner.tool('claim_screen', claimInput(p.code))).status).toBe(200);
    expect((await owner.tool('claim_screen', claimInput(p.code))).status).toBe(404);
    expect((await owner.tool('claim_screen', { ...claimInput('AB'), name: 'x' })).status).toBe(400);
  });

  it('answers an unknown or malformed poll token as expired or invalid', async () => {
    expect(await poll({ pollToken: 'A'.repeat(43), ip: nextIp() })).toEqual({ status: 'expired' });
    expect((await device('/pair/poll', { pollToken: 3 }, nextIp())).status).toBe(400);
    expect((await device('/pair/poll', 'nope', nextIp())).status).toBe(400);
  });
});

describe('rate limits', () => {
  it('lets one member try 10 codes a minute, then refuses every claim, the right code included', async () => {
    const guesser = new Client(t);
    await guesser.signIn(email('pair-guesser'));
    await guesser.setActive((await guesser.createOrg('Guesser')).id);
    const p = await start();
    const wrong = p.code.startsWith('A') ? 'BBBBBB' : 'AAAAAA';
    for (let i = 0; i < 10; i++) expect((await guesser.tool('claim_screen', claimInput(wrong))).status, `guess ${i + 1}`).toBe(404);
    const refused = await guesser.tool('claim_screen', claimInput(p.code));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' });
    // The code is still open for its owner, who has a limit of their own.
    expect(await poll(p)).toEqual({ status: 'waiting' });
  });

  it('counts guesses per address too, across accounts', async () => {
    const ip = nextIp();
    const guessers = [new Client(t, ip), new Client(t, ip)];
    for (const g of guessers) {
      await g.signIn(email('pair-ip'));
      await g.setActive((await g.createOrg('Same address')).id);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await guessers[i % 2]!.tool('claim_screen', claimInput('CCCCCC'))).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('lets one address start 10 codes a minute', async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) expect((await device('/pair/start', {}, ip)).status, `start ${i + 1}`).toBe(200);
    const refused = await device('/pair/start', {}, ip);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    // Another address is unaffected.
    expect((await device('/pair/start', {}, nextIp())).status).toBe(200);
  });

  it('lets one address poll 600 times a minute', async () => {
    const p = await start();
    const polls = await Promise.all(Array.from({ length: 600 }, () => device('/pair/poll', { pollToken: p.pollToken }, p.ip)));
    expect(polls.map((r) => r.status).filter((s) => s !== 200)).toEqual([]);
    expect((await device('/pair/poll', { pollToken: p.pollToken }, p.ip)).status).toBe(429);
  });
});

it('has the rate limiter bindings', () => {
  expect(typeof env.PAIR_START_LIMIT.limit).toBe('function');
});
