// The guard: on `/api`, only Better Auth and the tool route change data, and the tool route
// changes it only through the dispatcher, which writes the audit log. The test enumerates the
// Worker's routes, so a new route fails here until it is either read-only or listed below.
import { scoped } from '@signforge/db';
import { seedBaseTemplate } from '@signforge/db/testing';
import { registry } from '@signforge/tools';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { orgBlobKey } from '../src/r2';
import { Client, email, testApp } from './client';

/**
 * Every route that is not a GET, and why it may change data. `/api` allows exactly Better Auth
 * and the tool route. Other trees list each route with its reason; a screen reporting about
 * itself on `/v1/device` (M3-07's sync) goes here too, as a deliberate decision.
 */
const WRITERS: Record<string, string> = {
  'POST /api/auth/*': 'Better Auth: sign-in, organizations, members, invitations',
  'POST /api/tools/:name': 'the tool registry, through the dispatcher',
  'POST /admin/screens/:screen/missing': 'reads only: POST because the body is a manifest',
  'PUT /admin/screens/:screen/blobs/:sha256': 'sf push: content-addressed bytes in R2, inert until a publish names them',
  'PUT /admin/base/blobs/:sha256': 'sf push: content-addressed bytes in R2, inert until a publish names them',
  'PUT /admin/screens/:screen/manifest': 'sf push: stores the manifest file, then publishes through the dispatcher (admin.test.ts checks the audit row)',
  'PUT /admin/orgs/:org/blobs/:sha256': 'sf template push: content-addressed bytes in R2, inert until a template version names them',
  'PUT /admin/base/templates': 'sf template push: registers a base template version through the dispatcher, audited in platform_audit_log (templates.test.ts)',
  'PUT /admin/orgs/:org/templates':
    "sf template push: registers an org's template version through the dispatcher, audited in its audit_log (templates.test.ts)",
  'POST /v1/device/pair/start': 'an unpaired screen asking for a code: a pairing_codes row, which belongs to no org (not audited: no actor yet)',
  'POST /v1/device/pair/poll':
    "an unpaired screen collecting its credential: once a member's audited claim_screen bound the code, its first screen_credentials row (packages/db/src/pairing.ts)",
  'POST /v1/device/sync':
    'a screen reporting about itself: its heartbeat, last-seen time and play counts, on its own screen row (not audited: the screen is the actor, every few minutes)',
};
/** Middleware each tree mounts on its whole prefix. A wildcard on any other path is a route and fails. */
const MIDDLEWARE = new Set(['ALL /api/*', 'ALL /v1/device/*', 'ALL /admin/*']);
/** Better Auth's own GETs may write its tables (OAuth callbacks, sign-out links). */
const AUTH_GET = 'GET /api/auth/*';

/** Better Auth's tables. Writes to any other table are ours and must come from the dispatcher. */
const AUTH_TABLES = new Set(['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation', 'rateLimit']);
const WRITE = /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`]?(\w+)/i;

/** A D1 binding that records the table of every write statement prepared through it. */
function recordingD1(db: D1Database, writes: string[]): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const m = WRITE.exec(sql);
          if (m) writes.push(m[1]!);
          return target.prepare(sql);
        };
      }
      if (prop === 'exec') throw new Error('exec is not expected on a request path');
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const routes = () => [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))];

describe('the route table', () => {
  it('has no route that changes data except those listed', () => {
    const unexpected = routes().filter((r) => !r.startsWith('GET ') && !MIDDLEWARE.has(r) && !(r in WRITERS));
    expect(unexpected, 'a new route that is not a GET: make it a tool, or list it in WRITERS with a reason').toEqual([]);
  });

  it('allows exactly Better Auth and the tool route to change data on /api', () => {
    expect(Object.keys(WRITERS).filter((r) => r.split(' ')[1]!.startsWith('/api/'))).toEqual(['POST /api/auth/*', 'POST /api/tools/:name']);
    // Every listed writer still exists, so the list cannot rot.
    for (const r of Object.keys(WRITERS)) expect(routes(), r).toContain(r);
  });
});

describe('requests', () => {
  const t = testApp();
  const writes: string[] = [];
  let owner: Client;
  let screenId: string;
  let assetId: string;
  let brandKitId: string;
  let spotId: string;
  let baseTemplate: string;
  let baseVersion: string;

  beforeAll(async () => {
    ({ template: baseTemplate, templateVersion: baseVersion } = await seedBaseTemplate(env.DB));
    const setup = new Client(t);
    await setup.signIn(email('guard'));
    const org = await setup.createOrg('Guard');
    screenId = (await scoped(env.DB, org.id).screens.insert({ name: 'Guarded', timezone: 'UTC', orientation: 'landscape' })).id;
    assetId = (
      await scoped(env.DB, org.id).assets.insert({ kind: 'image', name: 'a.png', sha256: 'a'.repeat(64), type: 'image/png', size: 1, width: 1, height: 1 })
    ).id;
    await env.BLOBS.put(orgBlobKey(org.id, 'a'.repeat(64)), 'a');
    brandKitId = (
      await scoped(env.DB, org.id).brandKits.insert({
        name: 'House',
        colorsJson: JSON.stringify({ primary: '#000000', accent: '#ffffff', background: '#000000', surface: '#111111', text: '#ffffff', muted: '#aaaaaa' }),
        shape: 'soft',
      })
    ).id;
    spotId = (await scoped(env.DB, org.id).spots.insert({ name: 'Site', kind: 'url', durationMs: 10_000, url: 'https://example.com' })).id;
    // get_data_source's example names `weather`.
    await scoped(env.DB, org.id).dataSources.insert({ id: 'weather', name: 'Weather', format: 'json', urlEncrypted: 'sealed', refreshS: 300 });
    // The same session, on a D1 binding that records writes.
    owner = new Client(t, setup.ip, { ...env, DB: recordingD1(env.DB, writes) });
    for (const [k, v] of setup.jar) owner.jar.set(k, v);
  });

  const ours = () => writes.filter((table) => !AUTH_TABLES.has(table));

  it('to every GET on /api, other than Better Auth, write nothing of ours', async () => {
    const gets = routes().filter((r) => r.startsWith('GET /api/') && r !== AUTH_GET);
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) {
      writes.length = 0;
      // A hash names the org's one file; any other parameter is a placeholder.
      const path = r
        .slice('GET '.length)
        .replace(/:sha256/g, 'a'.repeat(64))
        .replace(/:\w+/g, 'x');
      const res = await owner.get(path);
      expect(res.status, r).toBe(200);
      expect(ours(), r).toEqual([]);
    }
  });

  it('to a read tool write nothing, and to a changing tool write the audit log with the change', async () => {
    for (const tool of registry.values()) {
      if (tool.mutates) continue;
      writes.length = 0;
      const example = tool.example as Record<string, unknown>;
      // Each id the example names, as one of this org's (or a base template's).
      const orgIds: Record<string, string> = { screenId, templateId: baseTemplate, templateVersionId: baseVersion, assetId, brandKitId, spotId };
      const input = Object.fromEntries(Object.entries(example).map(([k, v]) => [k, orgIds[k] ?? v]));
      expect((await owner.tool(tool.name, input)).status, tool.name).toBe(200);
      expect(ours(), tool.name).toEqual([]);
    }

    writes.length = 0;
    expect((await owner.tool('rename_screen', { screenId, name: 'Renamed' })).status).toBe(200);
    expect(ours()).toEqual(['screens', 'audit_log']);

    // A change that finds nothing (its UPDATE matched no row) is not audited.
    writes.length = 0;
    expect((await owner.tool('rename_screen', { screenId: 'scr_nobody', name: 'x' })).status).toBe(404);
    expect(ours()).not.toContain('audit_log');
  });
});

describe('POST /api/tools/:name', () => {
  const t = testApp();
  const owner = new Client(t);
  const viewer = new Client(t);
  let screenId: string;

  beforeAll(async () => {
    await owner.signIn(email('owner'));
    await viewer.signIn(email('viewer'));
    const org = await owner.createOrg('Tools');
    screenId = (await scoped(env.DB, org.id).screens.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })).id;
    const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', {
      email: (await viewer.session()).body.user.email,
      role: 'viewer',
      organizationId: org.id,
    });
    await viewer.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    expect((await viewer.setActive(org.id)).status).toBe(200);
  });

  it('maps refusals to HTTP statuses', async () => {
    const cases: [Client, string, unknown, number, string][] = [
      [owner, 'no_such_tool', {}, 404, 'unknown_tool'],
      [owner, 'rename_screen', { screenId, name: '' }, 400, 'invalid_input'],
      [owner, 'rename_screen', { screenId: 'scr_nobody', name: 'x' }, 404, 'not_found'],
      [viewer, 'rename_screen', { screenId, name: 'x' }, 403, 'forbidden'],
    ];
    for (const [who, name, input, status, error] of cases) {
      const res = await who.tool(name, input);
      expect(res.status, name).toBe(status);
      expect(await res.json(), name).toMatchObject({ error, message: expect.any(String) });
    }
  });

  it('records the session user as the actor, through the cms client', async () => {
    const res = await owner.tool('rename_screen', { screenId, name: 'Front desk' });
    expect(await res.json()).toMatchObject({ screen: { id: screenId, name: 'Front desk' } });
    const { user, organization } = (await owner.session()).body;
    const [entry] = await scoped(env.DB, organization.id).auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ actorKind: 'user', actorId: user.id, clientId: 'cms', action: 'rename_screen', targetKind: 'screen', targetId: screenId });
  });

  it('takes JSON only', async () => {
    const form = await owner.request('POST', '/api/tools/rename_screen', undefined, { 'content-type': 'text/plain' });
    expect(form.status).toBe(415);
    const broken = await owner.request('POST', '/api/tools/list_screens', undefined, { 'content-type': 'application/json' });
    expect(broken.status).toBe(200); // an empty body is an empty input
  });

  it('hands out presigned uploads to the local bucket in dev', async () => {
    const r = { sha256: '1'.repeat(64), type: 'image/jpeg', size: 1000, width: 1920, height: 1080 };
    const res = await owner.tool('create_asset_upload', {
      name: 'Photo',
      renditions: { landscape: r, portrait: { ...r, sha256: '2'.repeat(64), width: 1920 } },
    });
    expect(res.status).toBe(200);
    const { asset, uploads } = (await res.json()) as { asset: { id: string; status: string }; uploads: { url: string }[] };
    expect(asset.status).toBe('pending');
    expect(uploads).toHaveLength(2);
    const url = new URL(uploads[0]!.url);
    expect(url.pathname).toMatch(new RegExp(`^/cdn-cgi/local/r2/s3/signforge-dev/up/[^/]+/${asset.id}/[0-9a-f]{64}$`));
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^signforge-local\//);
  });

  it('lists what the caller may use', async () => {
    const names = async (c: Client) => ((await (await c.get('/api/tools')).json()) as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(await names(owner)).toHaveLength(registry.size);
    expect((await names(viewer)).sort()).toEqual([
      'find_places',
      'get_asset',
      'get_brand_kit',
      'get_data_source',
      'get_org_settings',
      'get_screen',
      'get_spot',
      'get_spot_preview',
      'get_template',
      'list_assets',
      'list_brand_kits',
      'list_data_sources',
      'list_fonts',
      'list_groups',
      'list_screen_status',
      'list_screens',
      'list_spots',
      'list_templates',
    ]);
  });
});
