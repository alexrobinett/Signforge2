/**
 * `/v1/player-releases`: the release workflows' way in (#628, `.github/workflows/player-release.yml` and
 * `player-promote.yml`), so CI holds no Cloudflare credential at all. Two writes, and nothing else:
 *
 *   POST /v1/player-releases/register   body: the manifest's bytes exactly as signed, then the tarball's;
 *                                       `x-release-manifest-bytes`: how many of the body's bytes are the manifest;
 *                                       `x-release-signature`: its signature. In this order, writing nothing until
 *                                       all pass: `releaseRow`'s checks, as `register` makes them; the signature,
 *                                       against this deployment's `PLAYER_RELEASE_PUBLIC_KEY`; the tarball's size and
 *                                       sha256, against the manifest. Then the tarball goes into PLAYER_RELEASES and
 *                                       the release is registered on `canary`. Sent again after either step failed,
 *                                       the same request finishes the job; once registered, it answers as it did.
 *   POST /v1/player-releases/promote    body: `{ "version": n, "dryRun": bool }`. The canary screens, and whatever
 *                                       keeps the release from `stable`; with nothing in the way and no `dryRun`,
 *                                       moves it to `stable`.
 *
 * `Authorization: Bearer` with the `PLAYER_RELEASE_ADMIN_SECRET` Worker secret, compared in constant time; while it or
 * the release key is unset the tree answers 404, as if it did not exist. No cookie is read, and a request carrying a
 * session is refused. Each address may try 10 times a minute, counted before the secret is checked.
 *
 * A register body is at most `MAX_RELEASE_MANIFEST_BYTES` plus `MAX_RELEASE_BYTES` (65 MiB), under Workers' 100 MB
 * request limit, and is read into one buffer of its declared length.
 */
import { MAX_RELEASE_BYTES, MAX_RELEASE_MANIFEST_BYTES } from '@signforge/contract';
import { platform, PlayerReleaseRefused, releaseRow } from '@signforge/db';
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sameSecret } from '../admin/auth';
import { refuseSession } from '../auth/guards';
import { boundedBytes } from '../body';
import { clientIp } from '../device/pairing';
import { playerReleaseKey } from '../r2';

/** The secret is not in wrangler.jsonc, so `wrangler types` only knows it when `.dev.vars` exists. */
type ReleaseEnv = { Bindings: Env & { PLAYER_RELEASE_ADMIN_SECRET?: string } };

/** A promote request is one number and a flag. */
const MAX_PROMOTE_BYTES = 1024;

/** How a register body says where the manifest ends: a count of bytes, from 1 to the manifest's bound. */
const MANIFEST_BYTES = /^[1-9][0-9]{0,6}$/;

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The contract's signature check: Ed25519 over the manifest's bytes, against a base64 SPKI DER key. */
async function verifies(key: string, signature: string, manifest: Uint8Array): Promise<boolean> {
  const der = Uint8Array.from(atob(key), (ch) => ch.charCodeAt(0));
  const sig = Uint8Array.from(atob(signature), (ch) => ch.charCodeAt(0));
  const pub = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', pub, sig, manifest);
}

const fail = (c: Context, status: 400 | 401 | 404 | 409 | 413 | 429, error: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, ...extra }, status, { 'cache-control': 'no-store' });

const releaseAuth = createMiddleware<ReleaseEnv>(async (c, next) => {
  const expected = c.env.PLAYER_RELEASE_ADMIN_SECRET;
  if (!expected || !c.env.PLAYER_RELEASE_PUBLIC_KEY) return fail(c, 404, 'not found');
  if (!(await c.env.PLAYER_RELEASE_LIMIT.limit({ key: clientIp(c) })).success) {
    c.header('retry-after', '60');
    return fail(c, 429, 'too many requests from this address; try again in a minute');
  }
  const match = /^Bearer[ ]+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!match || !(await sameSecret(match[1]!, expected))) {
    c.header('www-authenticate', 'Bearer realm="player-releases"');
    return fail(c, 401, 'unauthorized');
  }
  return next();
});

/**
 * A screen in a public run log: the first 8 hex digits of its id's sha256. Enough to tell canaries apart from run to
 * run; the id, and the org it names, stays out of the log.
 */
async function screenTag(screenId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(screenId)));
  return [...digest.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const releases = new Hono<ReleaseEnv>();
releases.use('*', refuseSession, releaseAuth);

releases.post('/register', async (c) => {
  const split = c.req.header('x-release-manifest-bytes') ?? '';
  const length = MANIFEST_BYTES.test(split) ? Number(split) : 0;
  if (!length || length > MAX_RELEASE_MANIFEST_BYTES) return fail(c, 400, `x-release-manifest-bytes must be a count from 1 to ${MAX_RELEASE_MANIFEST_BYTES}`);
  const body = await boundedBytes(c.req.raw, MAX_RELEASE_MANIFEST_BYTES + MAX_RELEASE_BYTES);
  if (body === undefined) return fail(c, 413, `the body is over ${MAX_RELEASE_MANIFEST_BYTES + MAX_RELEASE_BYTES} bytes`);
  if (body.byteLength <= length) return fail(c, 400, 'the body holds no tarball after the manifest');
  const manifestBytes = body.subarray(0, length);
  const tarball = body.subarray(length);
  let manifest: string;
  try {
    // Fatal, and the BOM kept: text that is not the bytes signed would register a release no screen can verify.
    manifest = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(manifestBytes);
  } catch {
    return fail(c, 400, 'the manifest is not UTF-8');
  }
  const signature = c.req.header('x-release-signature') ?? '';
  let claimed: ReturnType<typeof releaseRow>;
  try {
    claimed = releaseRow(manifest, signature, 'canary', Date.now());
  } catch (err) {
    if (err instanceof PlayerReleaseRefused) return fail(c, 400, 'not a player release', { problems: err.problems });
    throw err;
  }
  if (!(await verifies(c.env.PLAYER_RELEASE_PUBLIC_KEY, signature, manifestBytes))) {
    return fail(c, 400, "the signature does not verify against this deployment's release key");
  }
  if (tarball.byteLength !== claimed.size || hex(await crypto.subtle.digest('SHA-256', tarball)) !== claimed.sha256) {
    return fail(c, 400, `the tarball is not the ${claimed.size}-byte ${claimed.sha256} the manifest names`);
  }
  const db = platform(c.env.DB).playerReleases;
  const answer = (status: 200 | 201) =>
    c.json({ version: claimed.version, sha256: claimed.sha256, size: claimed.size, channel: 'canary' }, status, { 'cache-control': 'no-store' });
  const same = await db.bySha256('canary', claimed.sha256);
  if (same) return same.version === claimed.version && same.manifest === manifest ? answer(200) : fail(c, 409, `tarball ${claimed.sha256} is another release's`);
  if (await db.offers('canary', claimed.version)) return fail(c, 409, `release ${claimed.version} is registered already`);
  // Content-addressed, so writing it again after a failed register changes nothing.
  await c.env.PLAYER_RELEASES.put(playerReleaseKey(claimed.sha256), tarball, { httpMetadata: { contentType: 'application/gzip' } });
  if (!(await db.register(manifest, signature))) return fail(c, 409, `release ${claimed.version} is registered already`);
  return answer(201);
});

releases.post('/promote', async (c) => {
  const bytes = await boundedBytes(c.req.raw, MAX_PROMOTE_BYTES);
  if (bytes === undefined) return fail(c, 413, `the body is over ${MAX_PROMOTE_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail(c, 400, 'the body is not JSON');
  }
  const version = typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined;
  const dryRun = typeof body === 'object' && body !== null && 'dryRun' in body ? body.dryRun : false;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || typeof dryRun !== 'boolean') {
    return fail(c, 400, 'the body must be { "version": a whole number from 1, "dryRun": true or false }');
  }
  const db = platform(c.env.DB).playerReleases;
  if (!(await db.offers('canary', version))) return fail(c, 404, `no release ${version} is registered`);
  if (await db.offers('stable', version)) return fail(c, 409, `release ${version} is stable already`);
  const canaries = await Promise.all(
    (await db.canaries()).map(async ({ screenId, lastSeenAt, release }) => ({
      screen: await screenTag(screenId),
      release: release.running,
      releaseSince: release.since,
      failedReleases: release.failed,
      lastSeenAt,
    })),
  );
  const problems: string[] = [];
  if (!canaries.length) problems.push('no screen is on the canary channel');
  // A canary on a newer release has run this one first, as each canary installs every release.
  else if (!canaries.some((s) => s.release !== null && s.release >= version)) problems.push(`no canary runs release ${version}`);
  for (const s of canaries) {
    const failed = s.failedReleases.find((f) => f.version === version);
    if (failed) problems.push(`canary ${s.screen} rolled release ${version} back (${failed.reason})`);
  }
  const report = { version, canaries, problems };
  if (problems.length) return fail(c, 409, `release ${version} cannot be promoted`, report);
  if (dryRun) return c.json({ ...report, promoted: false }, 200, { 'cache-control': 'no-store' });
  if (!(await db.promote(version))) return fail(c, 409, `release ${version} is no longer on canary`);
  return c.json({ ...report, promoted: true }, 200, { 'cache-control': 'no-store' });
});
