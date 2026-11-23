import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const WRITE = 'Bearer test-write-token';
const READ = 'Bearer test-read-token';
const BASE = 'https://cache.test/v8/artifacts';

const bytes = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

// Tags shaped like turbo's: the base64 of an HMAC-SHA256.
const TAG = btoa('a'.repeat(32));
const OTHER_TAG = btoa('b'.repeat(32));

const call = (path: string, init: RequestInit & { auth?: string } = {}) => {
  const { auth = WRITE, ...rest } = init;
  return exports.default.fetch(`${BASE}${path}`, { ...rest, headers: { authorization: auth, ...rest.headers } });
};

// The requests turbo 2.11 sends on an upload (crates/turborepo-api-client, put_artifact).
const upload = (hash: string, body: string, headers: Record<string, string> = {}, auth = WRITE) =>
  call(`/${hash}?slug=signforge`, {
    method: 'PUT',
    auth,
    body,
    headers: { 'content-type': 'application/octet-stream', 'x-artifact-duration': '1234', 'x-artifact-tag': TAG, ...headers },
  });

describe('the status', () => {
  it('says the cache is on, and whether the token only reads', async () => {
    expect(await (await call('/status?slug=signforge')).json()).toEqual({ status: 'enabled', readOnly: false });
    expect(await (await call('/status?slug=signforge', { auth: READ })).json()).toEqual({ status: 'enabled', readOnly: true });
  });
});

describe('tokens', () => {
  it.each([
    ['no token', ''],
    ['an unknown token', 'Bearer test-write-tokenx'],
    ['a token without Bearer', 'test-write-token'],
  ])('refuses %s on every route', async (_, auth) => {
    for (const [path, method] of [
      ['/status', 'GET'],
      ['/0123abcd?slug=signforge', 'GET'],
      ['/0123abcd?slug=signforge', 'HEAD'],
      ['/0123abcd?slug=signforge', 'PUT'],
    ] as const) {
      const res = await call(path, { method, auth, body: method === 'PUT' ? 'x' : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('lets the read token read but not write, with the error turbo reads on a 403', async () => {
    await upload('aa01', 'from CI');
    const refused = await upload('aa02', 'from a laptop', {}, READ);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: 'forbidden', message: 'this token only reads the cache' } });
    expect((await call('/aa02?slug=signforge', { auth: READ })).status).toBe(404);
    expect(await bytes(await call('/aa01?slug=signforge', { auth: READ }))).toBe('from CI');
  });
});

describe('artifacts', () => {
  it('returns an upload byte for byte, with its duration and signature tag', async () => {
    expect((await upload('bb01', 'tar.zst bytes')).status).toBe(202);
    const res = await call('/bb01?slug=signforge');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-artifact-duration')).toBe('1234');
    expect(res.headers.get('x-artifact-tag')).toBe(TAG);
    expect(await bytes(res)).toBe('tar.zst bytes');
  });

  it('answers HEAD with the same headers and no body', async () => {
    await upload('bb02', 'body');
    const res = await call('/bb02?slug=signforge', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-artifact-duration')).toBe('1234');
    expect(res.headers.get('x-artifact-tag')).toBe(TAG);
    expect(await bytes(res)).toBe('');
  });

  it('says 404 for a hash nobody uploaded, which turbo reads as a miss', async () => {
    expect((await call('/bb03?slug=signforge')).status).toBe(404);
    expect((await call('/bb03?slug=signforge', { method: 'HEAD' })).status).toBe(404);
  });

  it('replaces an artifact uploaded again', async () => {
    await upload('bb04', 'first');
    await upload('bb04', 'second', { 'x-artifact-tag': OTHER_TAG });
    const res = await call('/bb04?slug=signforge');
    expect(res.headers.get('x-artifact-tag')).toBe(OTHER_TAG);
    expect(await bytes(res)).toBe('second');
  });

  it('keeps an unsigned upload unsigned, and drops a duration turbo could not read back', async () => {
    const headers = new Headers({ authorization: WRITE, 'x-artifact-duration': '12.5' });
    await exports.default.fetch(`${BASE}/bb05?slug=signforge`, { method: 'PUT', body: 'unsigned', headers });
    const res = await call('/bb05?slug=signforge');
    expect(res.headers.get('x-artifact-tag')).toBeNull();
    expect(res.headers.get('x-artifact-duration')).toBeNull();
    expect(await bytes(res)).toBe('unsigned');
  });
});

describe('uploads it refuses, storing nothing', () => {
  it('refuses an artifact over 64 MiB before reading it, with a 413', async () => {
    const res = await upload('ee01', 'small', { 'content-length': String(64 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect((await call('/ee01?slug=signforge', { method: 'HEAD' })).status).toBe(404);
  });

  it('wants a Content-Length (411), as R2 needs a known length', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('chunked'));
        c.close();
      },
    });
    const res = await call('/ee03?slug=signforge', { method: 'PUT', body, headers: { 'x-artifact-tag': TAG } });
    expect(res.status).toBe(411);
    expect((await call('/ee03?slug=signforge', { method: 'HEAD' })).status).toBe(404);
  });

  it.each([
    ['too long for a signature', btoa('a'.repeat(97))],
    ['not base64', 'tag-for-the-body'],
  ])('refuses an x-artifact-tag %s with a 400, not a 500 from R2', async (_, tag) => {
    const res = await upload('ee04', 'body', { 'x-artifact-tag': tag });
    expect(res.status).toBe(400);
    expect((await call('/ee04?slug=signforge', { method: 'HEAD' })).status).toBe(404);
  });
});

describe('teams', () => {
  it('keeps each team apart, by TURBO_TEAM (slug) or TURBO_TEAMID (teamId)', async () => {
    await upload('cc01', 'signforge’s');
    expect((await call('/cc01?slug=other')).status).toBe(404);
    expect(await bytes(await call('/cc01?teamId=signforge'))).toBe('signforge’s');
  });

  it.each([
    ['no team', ''],
    ['a team with a slash', '?slug=a/b'],
  ])('refuses %s', async (_, query) => {
    const res = await call(`/cc02${query}`);
    expect(res.status).toBe(400);
  });
});

describe('routes', () => {
  it.each([
    ['the batch lookup, so turbo falls back to HEAD', 'POST', ''],
    ['the usage events', 'POST', '/events'],
    ['a hash that is not hex', 'GET', '/not-hex?slug=signforge'],
  ])('has no %s', async (_, method, path) => {
    expect((await call(path, { method, body: method === 'POST' ? '{}' : undefined })).status).toBe(404);
  });

  it('refuses other methods on an artifact', async () => {
    expect((await call('/dd01?slug=signforge', { method: 'DELETE' })).status).toBe(405);
  });
});
