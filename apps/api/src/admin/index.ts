/**
 * `/admin`: uploads for `sf push`, protected by the `ADMIN_TOKEN` deploy secret (see ./auth.ts).
 * TEMPORARY: it moves bytes into R2 until the CMS uploads assets (M3-14) and agents get OAuth
 * grants (Milestone 4). Making a manifest live is not done here: the last step runs the
 * `publish_manifest_to_screen` tool through the dispatcher, as the CMS does, and is audited with
 * the system actor `sf-push`.
 *
 * The push protocol, in order (packages/cli/src/push.ts is the client):
 *
 *   POST /admin/screens/:screen/missing      body: the manifest. Which of its files R2 lacks.
 *   PUT  /admin/screens/:screen/blobs/:sha   body: a file, stored under the screen's org.
 *   PUT  /admin/base/blobs/:sha              body: a base template's HTML, stored under sys/b/.
 *   PUT  /admin/screens/:screen/manifest     body: the manifest. Stored, then published by the tool.
 *
 * `sf template push` (packages/cli/src/template-push.ts) uploads a built template the same way:
 *
 *   PUT  /admin/base/blobs/:sha              a base template's bundle or sources, under sys/b/
 *   PUT  /admin/orgs/:org/blobs/:sha         an org template's bundle or sources, under the org
 *   PUT  /admin/base/templates               body: { manifest, bundleId, sourcesId, approve }.
 *   PUT  /admin/orgs/:org/templates          Registers the version with `register_template_version`
 *                                            (which repeats the build's checks), then with `approve`
 *                                            approves a new draft with `set_template_version_status`.
 *
 * Base templates belong to no org, so their tools run from `platformRegistry` with `platform(db)`
 * and are audited in `platform_audit_log`; an org's run from the org registry with its scope.
 *
 * Keys follow docs/backend-plan.md#publishing and the device blob route: a base template's HTML
 * is read from `sys/b/`, every other file from the org's prefix. Every file is checked against
 * its hash before it is stored, and a manifest is checked by `validateManifest` and against its
 * own id before it is. Blobs and manifests are content-addressed and inert: nothing plays them
 * until a publish names them. Pushing the same build again uploads nothing and changes nothing.
 *
 * No request's body may be over `MAX_BODY_BYTES`: a larger one is refused (413) before a route reads it.
 */
import { baseTemplateHtml, isId, manifestIdInput, parseManifest, type ScreenManifest } from '@signforge/contract';
import { findDeviceScreen, organizationExists, platform, scoped, StaleVersionError } from '@signforge/db';
import {
  dispatch,
  platformRegistry,
  registry,
  type AnyTool,
  type Caller,
  type DataScope,
  type DispatchResult,
  type TemplateVersionView,
} from '@signforge/tools';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { baseBlobKey, manifestKey, orgBlobKey } from '../r2';
import { toolServices } from '../tool-services';
import { adminAuth, type AdminEnv } from './auth';

const SHA256 = /^[0-9a-f]{64}$/;
/** The audit log's actor and client for a publish from `sf push`. */
const SF_PUSH = 'sf-push';
const encoder = new TextEncoder();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: ArrayBuffer | string) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));

const fail = (c: Context, status: 400 | 404 | 409 | 413 | 429 | 500 | 503, error: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, ...extra }, status);

/** Where each of a manifest's files lives: base templates' HTML in `sys/b/`, the rest under the org. */
function fileKeys(m: ScreenManifest, orgId: string): { sha256: string; scope: 'org' | 'base'; key: string }[] {
  const base = baseTemplateHtml(m);
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
  const parsed = parseManifest(m);
  if (!parsed.ok) return { problems: parsed.problems };
  const manifest = parsed.value;
  const problems: string[] = [];
  if (!SHA256.test(manifest.id) || (await sha256(manifestIdInput(manifest))) !== manifest.id) {
    return { problems: ['id is not the hash of the manifest (see canonicalJson in packages/contract)'] };
  }
  for (const sha of Object.keys(manifest.files)) if (!SHA256.test(sha)) problems.push(`file key "${sha.slice(0, 16)}" is not a sha256`);
  return problems.length ? { problems } : { manifest };
}

/** Files of the manifest that R2 does not hold yet, or whose copy the storage sweep deleted. */
async function missingFiles(c: Context<AdminEnv>, m: ScreenManifest, orgId: string) {
  const files = fileKeys(m, orgId);
  // One the storage sweep deleted is uploaded again, even if a copy is back: the upload clears its tombstone (#432).
  const [held, deleted] = await Promise.all([
    Promise.all(files.map((f) => c.env.BLOBS.head(f.key))),
    scoped(c.env.DB, orgId).storage.deleted(
      files.filter((f) => f.scope === 'org').map((f) => f.sha256),
      Date.now(),
    ),
  ]);
  return files.filter((f, i) => !held[i] || (f.scope === 'org' && deleted.includes(f.sha256))).map(({ sha256, scope }) => ({ sha256, scope }));
}

/** Store a file under `key` if its bytes hash to `sha`. */
async function putBlob(c: Context<AdminEnv>, key: string, sha: string) {
  const body = await c.req.arrayBuffer();
  if ((await sha256(body)) !== sha) return fail(c, 400, 'body does not match its sha256');
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  await c.env.BLOBS.put(key, body, { sha256: sha, httpMetadata: { contentType } });
  return c.json({ stored: sha, size: body.byteLength });
}

/**
 * An org's blob, refused while the storage sweep claims its hash (#235, review of #429, round 2): stored then, it could
 * be deleted under the manifest that is to name it. The push that names it is fenced too (`publish_manifest_to_screen`).
 */
async function putOrgBlob(c: Context<AdminEnv>, orgId: string, sha: string) {
  const org = scoped(c.env.DB, orgId);
  if (await org.storage.claimed([sha], Date.now()))
    return fail(c, 409, 'the storage clean-up is deleting an earlier copy of these bytes: try again in a few minutes');
  const since = Date.now();
  const stored = await putBlob(c, orgBlobKey(orgId, sha), sha);
  if (!stored.ok) return stored;
  // Stored again: a tombstone the sweep left for these bytes before goes (#432). Not if it claims them, or deleted them
  // after `since`: this copy may be the one gone (review of #434).
  try {
    await org.commit(org.storage.stage.restored([sha], Date.now(), since));
  } catch (err) {
    if (!(err instanceof StaleVersionError)) throw err;
    return fail(c, 409, 'the storage clean-up deleted these bytes as they were stored: upload them again');
  }
  return stored;
}

/**
 * The largest body a route reads: 20 MiB, an image rendition's own limit (`MAX_RENDITION_BYTES`) and twice the
 * largest file a push sends today. Each route holds its body whole, to hash or parse it, in a Worker with 128 MB.
 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export const admin = new Hono<AdminEnv>();
admin.use('*', adminAuth);
admin.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, `the body is over ${MAX_BODY_BYTES} bytes, the most /admin takes`) }));

admin.post('/screens/:screen/missing', async (c) => {
  const screen = await findDeviceScreen(c.env.DB, c.req.param('screen'));
  if (!screen) return fail(c, 404, 'screen not found');
  const read = await readManifest(await c.req.text());
  if ('problems' in read) return fail(c, 400, 'invalid manifest', { problems: read.problems });
  return c.json({ manifestId: read.manifest.id, missing: await missingFiles(c, read.manifest, screen.orgId) });
});

admin.put('/screens/:screen/blobs/:sha256', async (c) => {
  const sha = c.req.param('sha256');
  if (!SHA256.test(sha)) return fail(c, 400, 'not a sha256');
  const screen = await findDeviceScreen(c.env.DB, c.req.param('screen'));
  if (!screen) return fail(c, 404, 'screen not found');
  return putOrgBlob(c, screen.orgId, sha);
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
  const missing = await missingFiles(c, manifest, screen.orgId);
  if (missing.length) return fail(c, 409, 'files are missing; upload them first', { missing });

  const key = manifestKey(screen.orgId, screen.screenId, manifest.id);
  if (!(await c.env.BLOBS.head(key))) await c.env.BLOBS.put(key, text, { httpMetadata: { contentType: 'application/json' } });

  // The deploy secret speaks for every org, so the system actor publishes with the owner's role,
  // but its grant is publishing alone.
  const caller: Caller = {
    org: scoped(c.env.DB, screen.orgId),
    role: 'owner',
    scopes: ['content:publish'],
    actor: { kind: 'system', id: SF_PUSH, clientId: SF_PUSH },
    blobs: c.env.BLOBS,
    services: { notify: toolServices(c, { orgId: screen.orgId }).notify },
  };
  const result = await dispatch(registry, 'publish_manifest_to_screen', { screenId: screen.screenId, manifestId: manifest.id }, caller);
  if (!result.ok) return fail(c, result.error === 'not_found' ? 404 : 409, result.message);
  const { changed } = result.output as { changed: boolean };
  return c.json({ manifestId: manifest.id, changed });
});

admin.put('/orgs/:org/blobs/:sha256', async (c) => {
  const sha = c.req.param('sha256');
  if (!SHA256.test(sha)) return fail(c, 400, 'not a sha256');
  const org = c.req.param('org');
  if (!isId(org) || !(await organizationExists(c.env.DB, org))) return fail(c, 404, 'organization not found');
  return putOrgBlob(c, org, sha);
});

/** The system actor `sf-push`, with the owner's role and a grant for drafting and approving templates. Org templates get the runtime check. */
const templateCaller = <D extends DataScope>(c: Context<AdminEnv>, org: D): Caller<D> => {
  const { templateCheck, rateLimit } = toolServices(c, { orgId: org.orgId });
  return {
    org,
    role: 'owner',
    scopes: ['content:draft', 'content:publish'],
    actor: { kind: 'system', id: SF_PUSH, clientId: SF_PUSH },
    blobs: c.env.BLOBS,
    services: { templateCheck, rateLimit },
  };
};

const STATUS = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  sample_text: 409,
  rate_limited: 429,
  unavailable: 503,
  forbidden: 500,
  unknown_tool: 500,
} as const;
const refused = (c: Context, r: Extract<DispatchResult, { ok: false }>) => {
  const problems = Array.isArray(r.details)
    ? r.details.map((d: { path?: string; message?: string }) => (d.path ? `${d.path}: ${d.message}` : String(d.message)))
    : undefined;
  return fail(c, STATUS[r.error], r.message, problems ? { problems } : {});
};

/** Register a template version through the dispatcher, then approve it if asked and it is a new draft. */
async function registerTemplate<D extends DataScope>(c: Context<AdminEnv>, tools: ReadonlyMap<string, AnyTool<D>>, caller: Caller<D>) {
  let body: { approve?: unknown } & Record<string, unknown>;
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return fail(c, 400, 'body is not JSON');
  }
  const { approve, ...input } = body ?? {};
  const reg = await dispatch(tools, 'register_template_version', input, caller);
  if (!reg.ok) return refused(c, reg);
  let { version, changed } = reg.output as { version: TemplateVersionView; changed: boolean };
  if (approve === true && version.status === 'draft') {
    const set = await dispatch(tools, 'set_template_version_status', { templateVersionId: version.id, status: 'approved' }, caller);
    if (!set.ok) return refused(c, set);
    version = (set.output as { version: TemplateVersionView }).version;
    changed = true;
  }
  return c.json({ key: version.key, templateVersionId: version.id, status: version.status, changed, checkReport: version.checkReport });
}

admin.put('/base/templates', (c) => registerTemplate(c, platformRegistry, templateCaller(c, platform(c.env.DB))));

admin.put('/orgs/:org/templates', async (c) => {
  const org = c.req.param('org');
  if (!isId(org) || !(await organizationExists(c.env.DB, org))) return fail(c, 404, 'organization not found');
  return registerTemplate(c, registry, templateCaller(c, scoped(c.env.DB, org)));
});
