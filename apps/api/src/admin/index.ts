/**
 * `/admin`: publishing from `sf push` until the CMS exists. TEMPORARY, protected by the
 * `ADMIN_TOKEN` deploy secret (see ./auth.ts); M3-12's tool registry replaces the whole tree.
 *
 * The push protocol, in order (packages/cli/src/push.ts is the client):
 *
 *   POST /admin/screens/:screen/missing      body: the manifest. Which of its files R2 lacks.
 *   PUT  /admin/screens/:screen/blobs/:sha   body: a file, stored under the screen's org.
 *   PUT  /admin/base/blobs/:sha              body: a base template's HTML, stored under sys/b/.
 *   PUT  /admin/screens/:screen/manifest     body: the manifest. Stored, then made desired.
 *
 * Keys follow docs/backend-plan.md#publishing and the device blob route: a base template's HTML
 * is read from `sys/b/`, every other file from the org's prefix. Every file is checked against
 * its hash before it is stored, and a manifest is checked by `validateManifest` and against its
 * own id before it is. Pushing the same build again uploads nothing and changes nothing.
 */
import { manifestIdInput, type ScreenManifest } from '@signforge/contract';
import { findDeviceScreen, scoped } from '@signforge/db';
import { validateManifest } from '@signforge/player-core';
import { Hono, type Context } from 'hono';
import { baseBlobKey, manifestKey, orgBlobKey } from '../r2';
import { adminAuth, type AdminEnv } from './auth';

const SHA256 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: ArrayBuffer | string) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));

const fail = (c: Context, status: 400 | 404 | 409, error: string, extra: Record<string, unknown> = {}) => c.json({ error, ...extra }, status);

/** Where each of a manifest's files lives: base templates' HTML in `sys/b/`, the rest under the org. */
function fileKeys(m: ScreenManifest, orgId: string): { sha256: string; scope: 'org' | 'base'; key: string }[] {
  const base = new Set(Object.entries(m.templates).filter(([key]) => key.startsWith('base/')).map(([, t]) => t.html));
  return Object.keys(m.files).map((sha) =>
    base.has(sha) ? { sha256: sha, scope: 'base', key: baseBlobKey(sha) } : { sha256: sha, scope: 'org', key: orgBlobKey(orgId, sha) },
  );
}

/** The request body as a manifest that passes `validateManifest` and whose id is its hash, or the problems. */
async function readManifest(text: string): Promise<{ manifest: ScreenManifest } | { problems: string[] }> {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return { problems: ['body is not JSON'] };
  }
  const problems = validateManifest(m);
  if (problems.length) return { problems };
  const manifest = m as ScreenManifest;
  if (!SHA256.test(manifest.id) || (await sha256(manifestIdInput(manifest))) !== manifest.id) {
    return { problems: ['id is not the hash of the manifest (see canonicalJson in packages/contract)'] };
  }
  for (const sha of Object.keys(manifest.files)) if (!SHA256.test(sha)) problems.push(`file key "${sha.slice(0, 16)}" is not a sha256`);
  return problems.length ? { problems } : { manifest };
}

/** Files of the manifest that R2 does not hold yet. */
async function missingFiles(bucket: R2Bucket, m: ScreenManifest, orgId: string) {
  const files = fileKeys(m, orgId);
  const held = await Promise.all(files.map((f) => bucket.head(f.key)));
  return files.filter((_, i) => !held[i]).map(({ sha256, scope }) => ({ sha256, scope }));
}

/** Store a file under `key` if its bytes hash to `sha`. */
async function putBlob(c: Context<AdminEnv>, key: string, sha: string) {
  const body = await c.req.arrayBuffer();
  if ((await sha256(body)) !== sha) return fail(c, 400, 'body does not match its sha256');
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  await c.env.BLOBS.put(key, body, { sha256: sha, httpMetadata: { contentType } });
  return c.json({ stored: sha, size: body.byteLength });
}

export const admin = new Hono<AdminEnv>();
admin.use('*', adminAuth);

admin.post('/screens/:screen/missing', async (c) => {
  const screen = await findDeviceScreen(c.env.DB, c.req.param('screen'));
  if (!screen) return fail(c, 404, 'screen not found');
  const read = await readManifest(await c.req.text());
  if ('problems' in read) return fail(c, 400, 'invalid manifest', { problems: read.problems });
  return c.json({ manifestId: read.manifest.id, missing: await missingFiles(c.env.BLOBS, read.manifest, screen.orgId) });
});

admin.put('/screens/:screen/blobs/:sha256', async (c) => {
  const sha = c.req.param('sha256');
  if (!SHA256.test(sha)) return fail(c, 400, 'not a sha256');
  const screen = await findDeviceScreen(c.env.DB, c.req.param('screen'));
  if (!screen) return fail(c, 404, 'screen not found');
  return putBlob(c, orgBlobKey(screen.orgId, sha), sha);
});

admin.put('/base/blobs/:sha256', async (c) => {
  const sha = c.req.param('sha256');
  if (!SHA256.test(sha)) return fail(c, 400, 'not a sha256');
  return putBlob(c, baseBlobKey(sha), sha);
});

admin.put('/screens/:screen/manifest', async (c) => {
  const screen = await findDeviceScreen(c.env.DB, c.req.param('screen'));
  if (!screen) return fail(c, 404, 'screen not found');
  // Stored byte for byte as sent: what the screen fetches is exactly what was built.
  const text = await c.req.text();
  const read = await readManifest(text);
  if ('problems' in read) return fail(c, 400, 'invalid manifest', { problems: read.problems });
  const { manifest } = read;

  // Nothing a screen could not fetch is ever made desired.
  const missing = await missingFiles(c.env.BLOBS, manifest, screen.orgId);
  if (missing.length) return fail(c, 409, 'files are missing; upload them first', { missing });

  const key = manifestKey(screen.orgId, screen.screenId, manifest.id);
  if (!(await c.env.BLOBS.head(key))) await c.env.BLOBS.put(key, text, { httpMetadata: { contentType: 'application/json' } });
  await scoped(c.env.DB, screen.orgId).screens.setDesiredManifest(screen.screenId, manifest.id);
  return c.json({ manifestId: manifest.id, changed: screen.desiredManifestId !== manifest.id });
});
