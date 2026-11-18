/**
 * `/v1/device`: what a screen fetches, authenticated by its bearer credential. Shapes are the
 * device API section of `packages/contract`; routes are in docs/backend-plan.md#screens.
 */
import { isCatalogueFontFile } from '@signforge/compiler';
import { isId, type DataSnapshot } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { baseBlobKey, blobHeaders, manifestKey, matches, orgBlobKey } from '../r2';
import { deviceAuth, type DeviceEnv } from './auth';
import { screenManifests } from './manifests';
import { pairPoll, pairStart } from './pairing';
import { socketRoute } from './socket';
import { syncRoute } from './sync';

const SHA256 = /^[0-9a-f]{64}$/;

const notFound = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const device = new Hono<DeviceEnv>();

// The player runs on the device's own origin and sends a bearer header, never cookies, so any
// origin may read these responses: without the credential they are all 401.
device.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['authorization', 'if-none-match', 'content-type'],
    exposeHeaders: ['etag'],
    maxAge: 86400,
  }),
);
// Before the bearer middleware: the socket authenticates with its ticket (./socket.ts).
device.get('/ws', socketRoute);
// And pairing, which a screen does before it has a credential (./pairing.ts).
device.post('/pair/start', pairStart);
device.post('/pair/poll', pairPoll);
device.use('*', deviceAuth);

device.post('/sync', syncRoute);

device.get('/manifest.json', async (c) => {
  const screen = c.get('screen');
  const id = screen.desiredManifestId;
  if (!id) return notFound('no manifest has been published to this screen');
  const etag = `"${id}"`;
  const headers = { etag, 'cache-control': 'no-cache' };
  if (matches(c.req.header('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  const obj = await c.env.BLOBS.get(manifestKey(screen.orgId, screen.screenId, id));
  if (!obj) return notFound('manifest not found');
  return new Response(obj.body, { headers: { ...headers, 'content-type': 'application/json' } });
});

device.get('/blobs/:sha256', async (c) => {
  const screen = c.get('screen');
  const sha = c.req.param('sha256');
  if (!SHA256.test(sha)) return notFound('file not found');
  const manifests = await screenManifests(c.env.BLOBS, screen);
  const listed = manifests.find((m) => m.files.has(sha));
  if (!listed) return notFound('file not found');

  // The org's own copy, or for a base template's HTML or a catalogue brand font the shared one.
  // Never another org's prefix.
  let obj = await c.env.BLOBS.get(orgBlobKey(screen.orgId, sha));
  if (!obj && (isCatalogueFontFile(sha) || manifests.some((m) => m.baseHtml.has(sha)))) obj = await c.env.BLOBS.get(baseBlobKey(sha));
  if (!obj) return notFound('file not found');

  // A screen keeps what it fetched in its own offline store, keyed by hash, so a file never changes under it.
  const type = listed.files.get(sha) || obj.httpMetadata?.contentType || 'application/octet-stream';
  return new Response(obj.body, { headers: blobHeaders(sha, type, obj.size, 'private, max-age=31536000, immutable') });
});

device.get('/data/:file', async (c) => {
  const screen = c.get('screen');
  const file = c.req.param('file');
  const id = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
  if (!isId(id)) return notFound('data source not found');
  const manifests = await screenManifests(c.env.BLOBS, screen);
  if (!manifests.some((m) => m.dataSources.has(id))) return notFound('data source not found');
  const snap = await scoped(c.env.DB, screen.orgId).dataSources.snapshot(id);
  if (!snap) return notFound('no snapshot yet');
  // The stored version is a hash, for telling whether data changed; a screen orders snapshots by the fetch time.
  const body: DataSnapshot = {
    id,
    version: snap.fetchedAt,
    fetchedAt: new Date(snap.fetchedAt).toISOString(),
    checkedAt: new Date(snap.checkedAt).toISOString(),
    data: JSON.parse(snap.dataJson),
  };
  return c.json(body, 200, { 'cache-control': 'no-store' });
});
