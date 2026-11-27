// `/v1/player-releases` (#628): the release workflows' register and promote, behind their own secret, and nothing else.
import { MAX_RELEASE_BYTES, MAX_RELEASE_MANIFEST_BYTES } from '@signforge/contract';
import { platform } from '@signforge/db';
import { seedOrg, signedRelease, type SeededOrg } from '@signforge/db/testing';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { playerReleaseKey } from '../src/r2';
import { releases } from '../src/releases';

const SECRET = 'test-release-secret'; // vitest.config.ts
const API = 'https://api.test/v1/player-releases';
let ips = 0;
/** Each test its own address, so the per-address limit counts only the requests it means to. */
const nextIp = () => `198.51.100.${++ips}`;

const call = (path: string, init: RequestInit & { ip?: string; secret?: string | null } = {}) => {
  const { ip = nextIp(), secret = SECRET, headers, ...rest } = init;
  return exports.default.fetch(`${API}${path}`, {
    method: 'POST',
    ...rest,
    headers: { 'cf-connecting-ip': ip, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }), ...headers },
  });
};
const encoder = new TextEncoder();
const bytesOf = (x: string | Uint8Array) => (typeof x === 'string' ? encoder.encode(x) : x);
/** A register request as the workflow sends it: the manifest's bytes, then the tarball's, and where one ends. */
const register = (manifest: string | Uint8Array, signature: string, tarball: Uint8Array, split = bytesOf(manifest).byteLength) => {
  const m = bytesOf(manifest);
  const body = new Uint8Array(m.byteLength + tarball.byteLength);
  body.set(m);
  body.set(tarball, m.byteLength);
  return call('/register', { body, headers: { 'x-release-signature': signature, 'x-release-manifest-bytes': String(split) } });
};
const promote = (body: unknown) => call('/promote', { body: JSON.stringify(body) });
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** A release signed with the contract's test key, which dev's PLAYER_RELEASE_PUBLIC_KEY is, and its tarball's bytes. */
async function release(version: number, fill = String(version)) {
  const tarball = encoder.encode(fill.repeat(1024 / fill.length));
  const signed = await signedRelease({ version, sha256: hex(await crypto.subtle.digest('SHA-256', tarball)), size: tarball.byteLength });
  return { ...signed, tarball };
}

let a: SeededOrg;
let b: SeededOrg;
beforeAll(async () => {
  a = await seedOrg(env.DB, 'org-release-a');
  b = await seedOrg(env.DB, 'org-release-b');
});

describe('the gate', () => {
  it('refuses a missing or wrong secret, and answers 404 while no secret is set', async () => {
    expect((await call('/promote', { secret: null, body: '{}' })).status).toBe(401);
    expect((await call('/promote', { secret: 'wrong', body: '{}' })).status).toBe(401);
    expect((await call('/promote', { secret: `${SECRET}x`, body: '{}' })).status).toBe(401);
    const unset = await releases.request('/promote', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, { ...env, PLAYER_RELEASE_ADMIN_SECRET: '' });
    expect(unset.status).toBe(404);
  });

  it('reaches nothing but POST register and promote, and no other tree', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await call('/register', { method })).status, method).toBe(404);
    expect((await call('/')).status).toBe(404);
    expect((await call('/canaries')).status).toBe(404);
    expect((await call('/register/x')).status).toBe(404);
    // The secret opens nothing elsewhere: not /admin, not the device tree.
    const admin = await exports.default.fetch('https://api.test/admin/base/templates', { method: 'PUT', headers: { authorization: `Bearer ${SECRET}` } });
    expect(admin.status).toBe(401);
    const device = await exports.default.fetch('https://api.test/v1/device/player-release', { headers: { authorization: `Bearer ${SECRET}` } });
    expect(device.status).toBe(401);
  });

  it('refuses a request that carries a session, even with the secret', async () => {
    const res = await call('/promote', { body: '{}', headers: { cookie: 'sf.session_token=x' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_not_accepted' });
  });

  it('limits each address to 10 tries a minute, counted before the secret', async () => {
    const ip = nextIp();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await call('/promote', { ip, secret: 'guess', body: '{}' })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
    expect((await call('/promote', { ip, body: '{}' })).status).toBe(429);
  });
});

describe('POST /register', () => {
  it('stores the tarball and registers on canary the exact text signed; sent again, it answers as it did', async () => {
    const r = await release(20);
    const res = await register(r.manifest, r.signature, r.tarball);
    expect(res.status).toBe(201);
    const answer = { version: 20, sha256: hex(await crypto.subtle.digest('SHA-256', r.tarball)), size: 1024, channel: 'canary' };
    expect(await res.json()).toEqual(answer);
    expect(await platform(env.DB).playerReleases.offered('canary')).toMatchObject({ version: 20, manifest: r.manifest, signature: r.signature });
    const stored = await env.PLAYER_RELEASES.get(playerReleaseKey(answer.sha256));
    expect({ bytes: await stored?.text(), type: stored?.httpMetadata?.contentType }).toEqual({ bytes: '20'.repeat(512), type: 'application/gzip' });
    // A retry after a lost answer converges; another build under the same number does not.
    const again = await register(r.manifest, r.signature, r.tarball);
    expect([again.status, await again.json()]).toEqual([200, answer]);
    const other = await release(20, 'x');
    expect((await register(other.manifest, other.signature, other.tarball)).status).toBe(409);
  });

  it('finishes a release whose tarball was stored but not registered', async () => {
    const r = await release(21);
    await env.PLAYER_RELEASES.put(playerReleaseKey(JSON.parse(r.manifest).sha256), r.tarball);
    expect((await register(r.manifest, r.signature, r.tarball)).status).toBe(201);
    expect(await platform(env.DB).playerReleases.offers('canary', 21)).toBe(true);
  });

  it('refuses a mismatched tarball, a bad signature or manifest, and an oversized body, storing and registering nothing', async () => {
    const good = await release(24);
    const refused = async (manifest: string | Uint8Array, signature = good.signature, tarball = good.tarball, split?: number) => {
      const res = await register(manifest, signature, tarball, split);
      return { status: res.status, ...(await res.json<{ error: string; problems?: string[] }>()) };
    };
    const tampered = good.tarball.slice();
    tampered[0] = 0x79;
    expect(await refused(good.manifest, good.signature, tampered)).toMatchObject({ status: 400, error: expect.stringMatching(/^the tarball is not the 1024-byte/) });
    expect(await refused(good.manifest, good.signature, good.tarball.subarray(1))).toMatchObject({ status: 400 });
    // Signed by the test key, then changed: the text no longer verifies.
    const resigned = good.manifest.replace('"minSupervisor":1', '"minSupervisor":2');
    expect(await refused(resigned)).toMatchObject({ status: 400, error: "the signature does not verify against this deployment's release key" });
    expect(await refused(good.manifest, 'c2ln')).toMatchObject({ status: 400, problems: ['the signature is not an Ed25519 signature in base64'] });
    expect(await refused('not json')).toMatchObject({ status: 400, problems: ['the manifest text is not JSON'] });
    expect(await refused(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({ status: 400, error: 'the manifest is not UTF-8' });
    expect(await refused(good.manifest, good.signature, new Uint8Array())).toMatchObject({ status: 400, error: 'the body holds no tarball after the manifest' });
    expect(await refused(good.manifest, good.signature, good.tarball, 0)).toMatchObject({ status: 400 });
    // Where the manifest ends, moved: its text is no longer what was signed.
    expect((await refused(good.manifest, good.signature, good.tarball, encoder.encode(good.manifest).byteLength - 1)).status).toBe(400);
    const tooBig = await call('/register', {
      body: new Uint8Array(1),
      headers: { 'x-release-signature': good.signature, 'x-release-manifest-bytes': '1', 'content-length': String(MAX_RELEASE_MANIFEST_BYTES + MAX_RELEASE_BYTES + 1) },
    });
    expect(tooBig.status).toBe(413);
    expect(await platform(env.DB).playerReleases.offers('canary', 24)).toBe(false);
    expect((await env.PLAYER_RELEASES.list()).objects.map((o) => o.key)).not.toContain(playerReleaseKey(JSON.parse(good.manifest).sha256));
  });

  it("checks against the key screens ship with: demo's is device/pi/player-release.pub, once it is committed", () => {
    const vars: Record<string, { PLAYER_RELEASE_PUBLIC_KEY?: string }> = JSON.parse(env.DEPLOYED_VARS);
    const pub = env.RELEASE_PUB_FILE.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
    if (pub) expect(vars.demo?.PLAYER_RELEASE_PUBLIC_KEY).toBe(pub);
    expect(vars.dev?.PLAYER_RELEASE_PUBLIC_KEY).toMatch(/^MCow/);
  });
});

describe('POST /promote', () => {
  const heartbeat = (release: number, failed: { version: number; reason: string }[] = []) =>
    JSON.stringify({ player: { release }, releaseSince: 1_000, failedReleases: failed });

  it('refuses a release with no canary, none running it, or one that rolled it back; promotes it once none is in the way', async () => {
    const r = await release(30);
    expect((await register(r.manifest, r.signature, r.tarball)).status).toBe(201);
    expect((await promote({ version: 99, dryRun: true })).status).toBe(404);
    const problems = async (body: unknown) => {
      const res = await promote(body);
      return { status: res.status, ...(await res.json<{ problems?: string[] }>()) };
    };
    expect(await problems({ version: 30, dryRun: true })).toMatchObject({ status: 409, problems: ['no screen is on the canary channel'] });

    await a.scope.screens.update(a.screen, { playerChannel: 'canary', heartbeatJson: heartbeat(20), lastSeenAt: 2_000 });
    expect(await problems({ version: 30, dryRun: true })).toMatchObject({ status: 409, problems: ['no canary runs release 30'] });

    await a.scope.screens.update(a.screen, { heartbeatJson: heartbeat(30) });
    await b.scope.screens.update(b.screen, { playerChannel: 'canary', heartbeatJson: heartbeat(20, [{ version: 30, reason: 'not-alive' }]) });
    const rolled = await problems({ version: 30, dryRun: true });
    expect(rolled.status).toBe(409);
    expect(rolled.problems).toEqual([expect.stringMatching(/^canary [0-9a-f]{8} rolled release 30 back \(not-alive\)$/)]);

    await b.scope.screens.update(b.screen, { playerChannel: 'stable' });
    const dry = await promote({ version: 30, dryRun: true });
    const text = await dry.text();
    expect(dry.status).toBe(200);
    // Screens by a short hash only: the log it lands in is public.
    expect(text).not.toContain(a.screen);
    expect(JSON.parse(text)).toEqual({
      version: 30,
      canaries: [{ screen: expect.stringMatching(/^[0-9a-f]{8}$/), release: 30, releaseSince: 1_000, failedReleases: [], lastSeenAt: 2_000 }],
      problems: [],
      promoted: false,
    });
    expect(await platform(env.DB).playerReleases.offers('stable', 30)).toBe(false);

    expect(await problems({ version: 30, dryRun: false })).toMatchObject({ status: 200, promoted: true });
    expect(await platform(env.DB).playerReleases.offers('stable', 30)).toBe(true);
    expect(await problems({ version: 30, dryRun: false })).toMatchObject({ status: 409, error: 'release 30 is stable already' });
  });

  it('reads only a version and a flag', async () => {
    for (const body of [{}, { version: '30' }, { version: 0 }, { version: 1.5 }, { version: 30, dryRun: 'yes' }]) {
      expect((await promote(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('/promote', { body: 'not json' })).status).toBe(400);
    expect((await call('/promote', { body: 'x'.repeat(2048) })).status).toBe(413);
  });
});
