// The temporary /admin tree that `sf push` uploads through (its publish step runs the tool),
// driven by the real client (packages/cli/src/push.ts) against local D1 and R2, then read back
// through the device API.
import { MANIFEST_SCHEMA, manifestIdInput, type ScreenManifest } from '@signforge/contract';
import { push, PushError, type PushOptions } from '@signforge/cli/push';
import { scoped } from '@signforge/db';
import { claimFileForSweep, seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { mintCredential } from '../src/device/credential';
import { baseBlobKey, manifestKey, orgBlobKey } from '../src/r2';

const TOKEN = 'test-admin-token'; // vitest.config.ts
const API = 'https://api.test';
const encoder = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Uint8Array | string) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));

interface Build {
  manifest: ScreenManifest;
  manifestText: string;
  blobs: Map<string, Uint8Array>;
}

/** What `sf build` would write: a base template, its HTML, and an image, with real hashes. */
async function build(seed: string): Promise<Build> {
  const html = encoder.encode(`<!doctype html><title>${seed}</title>`);
  const image = encoder.encode(`png ${seed}`);
  const [htmlSha, imageSha] = await Promise.all([sha256(html), sha256(image)]);
  const tm = {
    id: 'card',
    version: '1.0.0',
    name: 'Card',
    fields: {},
    duration: { defaultMs: 5000, minMs: 1000, maxMs: 9000 },
    orientations: ['landscape' as const],
    uses: [],
    background: '#000',
    protocol: 1,
  };
  const body: Omit<ScreenManifest, 'id' | 'generatedAt'> = {
    schema: MANIFEST_SCHEMA,
    screen: { id: 'local', name: 'Local', timezone: 'UTC', orientation: 'landscape' },
    files: { [htmlSha]: { size: html.byteLength, type: 'text/html' }, [imageSha]: { size: image.byteLength, type: 'image/png' } },
    templates: { 'base/card@1.0.0': { manifest: tm, html: htmlSha } },
    spots: {
      card: { id: 'card', name: 'Card', kind: 'template', template: 'base/card@1.0.0', data: {}, assets: {}, durationMs: 5000 },
      photo: { id: 'photo', name: 'Photo', kind: 'image', file: imageSha, fit: 'cover', durationMs: 5000 },
    },
    playlists: { main: { id: 'main', name: 'Main', transition: { type: 'cut' }, items: [{ spot: 'card' }, { spot: 'photo' }] } },
    dataSources: {},
    schedule: [],
    defaultPlaylist: 'main',
  };
  const manifest: ScreenManifest = { ...body, id: await sha256(manifestIdInput(body)), generatedAt: '2026-11-17T00:00:00.000Z' };
  return {
    manifest,
    manifestText: JSON.stringify(manifest, null, 2),
    blobs: new Map([
      [htmlSha, html],
      [imageSha, image],
    ]),
  };
}

/** Counts PUTs of files so a test can tell what a push uploaded. */
function client(b: Build, screen: string, extra: Partial<PushOptions> = {}) {
  const puts: string[] = [];
  const opts: PushOptions = {
    api: API,
    screen,
    token: TOKEN,
    manifestText: b.manifestText,
    readBlob: (sha) => b.blobs.get(sha)!,
    fetch: (url, init) => {
      if (init?.method === 'PUT' && url.includes('/blobs/')) puts.push(url);
      return exports.default.fetch(url, init);
    },
    ...extra,
  };
  return { puts, run: () => push(opts) };
}

const admin = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
  exports.default.fetch(`${API}/admin${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });

let org: SeededOrg;
let credential: string;
let first: Build;

beforeAll(async () => {
  org = await seedOrg(env.DB, 'push-org');
  const minted = await mintCredential(org.screen);
  await org.scope.screens.credentials.insert({ screenId: org.screen, secretHash: minted.secretHash });
  credential = minted.credential;
  first = await build('one');
});

describe('admin auth', () => {
  const paths: [string, string][] = [
    ['POST', '/screens/x/missing'],
    ['PUT', `/screens/x/blobs/${'a'.repeat(64)}`],
    ['PUT', `/base/blobs/${'a'.repeat(64)}`],
    ['PUT', '/screens/x/manifest'],
    ['PUT', `/orgs/x/blobs/${'a'.repeat(64)}`],
    ['PUT', '/base/templates'],
    ['PUT', '/orgs/x/templates'],
  ];

  it('is a 401 with no token, a wrong token, or a device credential', async () => {
    for (const [method, path] of paths) {
      for (const auth of [
        undefined,
        'Bearer wrong-token',
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`,
        `Basic ${btoa(`admin:${TOKEN}`)}`,
        `Bearer ${credential}`,
      ]) {
        const res = await exports.default.fetch(`${API}/admin${path}`, { method, body: '{}', headers: auth ? { authorization: auth } : {} });
        expect(res.status, `${method} ${path} ${auth?.slice(0, 12)}`).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
      }
    }
  });

  it('is off entirely when ADMIN_TOKEN is unset', async () => {
    for (const token of [undefined, '']) {
      for (const [method, path] of paths) {
        const res = await app.fetch(new Request(`${API}/admin${path}`, { method, body: '{}', headers: { authorization: `Bearer ${token}` } }), {
          ...env,
          ADMIN_TOKEN: token,
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it('is not accepted on the device tree', async () => {
    const res = await exports.default.fetch(`${API}/v1/device/manifest.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(401);
  });
});

describe('push', () => {
  it('uploads every file the first time, nothing the second, and leaves the desired manifest alone', async () => {
    const one = client(first, org.screen);
    const r1 = await one.run();
    expect(r1).toMatchObject({ manifestId: first.manifest.id, files: 2, uploaded: 2, changed: true });
    expect(one.puts).toHaveLength(2);

    const two = client(first, org.screen);
    const r2 = await two.run();
    expect(r2).toMatchObject({ manifestId: first.manifest.id, uploaded: 0, uploadedBytes: 0, changed: false });
    expect(two.puts).toHaveLength(0);

    // Pushing the same id again did not move it into previous_manifest_id.
    const s = await org.scope.screens.get(org.screen);
    expect(s?.desiredManifestId).toBe(first.manifest.id);
    expect(s?.previousManifestId).toBeNull();

    // The publish ran the tool through the dispatcher, audited as sf push. The second push changed
    // nothing, so it wrote nothing, audit row included.
    const audit = (await org.scope.auditLog.list()).filter((e) => e.action === 'publish_manifest_to_screen');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'system', actorId: 'sf-push', clientId: 'sf-push', targetKind: 'screen', targetId: org.screen });
    expect(JSON.parse(audit[0]!.detailJson!)).toEqual({ input: { screenId: org.screen, manifestId: first.manifest.id } });
  });

  it('stores base template HTML under sys/b/ and the rest under the org', async () => {
    const [htmlSha] = Object.values(first.manifest.templates).map((t) => t.html);
    const imageSha = Object.keys(first.manifest.files).find((s) => s !== htmlSha)!;
    expect(await env.BLOBS.head(baseBlobKey(htmlSha!))).not.toBeNull();
    expect(await env.BLOBS.head(orgBlobKey(org.orgId, htmlSha!))).toBeNull();
    const img = await env.BLOBS.get(orgBlobKey(org.orgId, imageSha));
    expect(img?.httpMetadata?.contentType).toBe('image/png');
    expect(await env.BLOBS.head(manifestKey(org.orgId, org.screen, first.manifest.id))).not.toBeNull();
  });

  it('serves the pushed manifest and its files to the screen', async () => {
    const res = await exports.default.fetch(`${API}/v1/device/manifest.json`, { headers: { authorization: `Bearer ${credential}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${first.manifest.id}"`);
    expect(await res.text()).toBe(first.manifestText);
    for (const [sha, bytes] of first.blobs) {
      const blob = await exports.default.fetch(`${API}/v1/device/blobs/${sha}`, { headers: { authorization: `Bearer ${credential}` } });
      expect(blob.status, sha).toBe(200);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    }
  });

  it('uploads only what changed, and keeps the old manifest as previous', async () => {
    const second = await build('two');
    const c = client(second, org.screen);
    expect(await c.run()).toMatchObject({ manifestId: second.manifest.id, uploaded: 2, changed: true });
    const s = await org.scope.screens.get(org.screen);
    expect(s).toMatchObject({ desiredManifestId: second.manifest.id, previousManifestId: first.manifest.id });
  });

  it('reports an unknown screen', async () => {
    await expect(client(first, 'scr_nobody').run()).rejects.toThrow(/404\nscreen not found/);
  });
});

describe('blob upload', () => {
  it('rejects bytes that do not match their hash, and stores nothing', async () => {
    const claimed = await sha256('the real bytes');
    for (const path of [`/screens/${org.screen}/blobs/${claimed}`, `/base/blobs/${claimed}`]) {
      const res = await admin('PUT', path, 'other bytes', { 'content-type': 'image/png' });
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: 'body does not match its sha256' });
    }
    expect(await env.BLOBS.head(orgBlobKey(org.orgId, claimed))).toBeNull();
    expect(await env.BLOBS.head(baseBlobKey(claimed))).toBeNull();
    expect((await admin('PUT', `/base/blobs/NOTAHASH`, 'x')).status).toBe(400);
  });

  it('rejects a client whose file on disk changed since the build', async () => {
    const b = await build('tampered');
    const c = client(b, org.screen, { readBlob: (sha) => encoder.encode(`not ${sha}`) });
    await expect(c.run()).rejects.toThrow(PushError);
    expect((await org.scope.screens.get(org.screen))?.desiredManifestId).not.toBe(b.manifest.id);
  });
});

describe('the storage sweep (#235, review of #429, round 2)', () => {
  // On a fixed clock (review of #429, round 3): the API reads the same one.
  const AT = Date.UTC(2026, 4, 1, 9);
  beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT }));
  afterEach(() => vi.useRealTimers());
  /** The sweep's claim on an org's hash: held for an hour, or run out. */
  const claimFile = (orgId: string, sha: string, held: boolean) => claimFileForSweep(env.DB, orgId, sha, held ? AT + 3_600_000 : 0);

  it("refuses an org's blob while the sweep claims its hash, and stores it once the claim has run out", async () => {
    const bytes = 'bytes the sweep is deleting';
    const sha = await sha256(bytes);
    await claimFile(org.orgId, sha, true);
    for (const path of [`/screens/${org.screen}/blobs/${sha}`, `/orgs/${org.orgId}/blobs/${sha}`]) {
      const res = await admin('PUT', path, bytes, { 'content-type': 'image/png' });
      expect(res.status, path).toBe(409);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('storage clean-up') });
    }
    expect(await env.BLOBS.head(orgBlobKey(org.orgId, sha))).toBeNull();
    await claimFile(org.orgId, sha, false);
    expect((await admin('PUT', `/orgs/${org.orgId}/blobs/${sha}`, bytes, { 'content-type': 'image/png' })).status).toBe(200);
  });

  it('refuses a push whose files the sweep claims after they were uploaded, and indexes the manifest of one it makes desired', async () => {
    const b = await build('swept');
    const image = Object.keys(b.manifest.files).find((s) => !Object.values(b.manifest.templates).some((t) => t.html === s))!;
    // The files land, then the sweep claims the image before the manifest is pushed.
    const raced = client(b, org.screen, {
      fetch: async (url, init) => {
        if (init?.method === 'PUT' && url.endsWith('/manifest')) await claimFile(org.orgId, image, true);
        return exports.default.fetch(url, init);
      },
    });
    await expect(raced.run()).rejects.toThrow(/storage clean-up/);
    expect((await org.scope.screens.get(org.screen))?.desiredManifestId).not.toBe(b.manifest.id);
    await claimFile(org.orgId, image, false);
    expect(await client(b, org.screen).run()).toMatchObject({ manifestId: b.manifest.id, changed: true });
    const row = await env.DB.prepare('SELECT files_json AS f FROM stored_manifests WHERE org_id = ? AND screen_id = ? AND manifest_id = ?')
      .bind(org.orgId, org.screen, b.manifest.id)
      .first<{ f: string }>();
    expect(JSON.parse(row!.f)).toEqual(Object.keys(b.manifest.files).sort());
  });

  it('uploads again a file the sweep deleted, though a copy is back, which clears its tombstone (#432)', async () => {
    const b = await build('tombstoned');
    const image = Object.keys(b.manifest.files).find((s) => !Object.values(b.manifest.templates).some((t) => t.html === s))!;
    await client(b, org.screen).run();
    // The sweep deleted the image's earlier copy (its tombstone), and a copy is back in R2 since.
    await env.DB.prepare('INSERT INTO blob_deletes (org_id, sha256, queued_at, deleted_at) VALUES (?, ?, 0, ?)')
      .bind(org.orgId, image, AT - 1)
      .run();
    const missing = await admin('POST', `/screens/${org.screen}/missing`, b.manifestText);
    expect(((await missing.json()) as { missing: { sha256: string }[] }).missing).toEqual([{ sha256: image, scope: 'org' }]);
    const again = client(b, org.screen);
    expect(await again.run()).toMatchObject({ manifestId: b.manifest.id, uploaded: 1 });
    expect(again.puts).toEqual([expect.stringContaining(image)]);
    expect(await scoped(env.DB, org.orgId).storage.deleted([image])).toEqual([]);
  });
});

describe('manifest upload', () => {
  it('rejects a manifest that fails validateManifest, before and after the file check', async () => {
    const bad = { ...first.manifest, defaultPlaylist: 'nope' };
    for (const path of ['/missing', '/manifest']) {
      const res = await admin(path === '/missing' ? 'POST' : 'PUT', `/screens/${org.screen}${path}`, JSON.stringify(bad));
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid manifest', problems: ['defaultPlaylist does not exist'] });
    }
    expect((await admin('PUT', `/screens/${org.screen}/manifest`, 'not json')).status).toBe(400);
  });

  it('rejects a manifest whose id is not its hash', async () => {
    const forged = { ...first.manifest, screen: { ...first.manifest.screen, name: 'Changed' } };
    const res = await admin('PUT', `/screens/${org.screen}/manifest`, JSON.stringify(forged));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ problems: [expect.stringMatching(/^id is not the hash/)] });
  });

  it('refuses to make a manifest desired while any of its files is missing', async () => {
    const b = await build('incomplete');
    const res = await admin('PUT', `/screens/${org.screen}/manifest`, b.manifestText);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { missing: unknown[] }).missing).toHaveLength(2);
    expect(await env.BLOBS.head(manifestKey(org.orgId, org.screen, b.manifest.id))).toBeNull();
  });

  it("puts files under the screen's own org only", async () => {
    const other = await seedOrg(env.DB, 'push-other');
    const b = await build('other-org');
    await client(b, other.screen).run();
    const imageSha = Object.keys(b.manifest.files).find((s) => !Object.values(b.manifest.templates).some((t) => t.html === s))!;
    expect(await env.BLOBS.head(orgBlobKey(other.orgId, imageSha))).not.toBeNull();
    expect(await env.BLOBS.head(orgBlobKey(org.orgId, imageSha))).toBeNull();
    expect((await scoped(env.DB, other.orgId).screens.get(other.screen))?.desiredManifestId).toBe(b.manifest.id);
  });
});
