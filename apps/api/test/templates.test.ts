// `sf template push` against the real /admin routes, driven by the real client
// (packages/cli/src/template-push.ts): every template in templates/ becomes an approved base
// template, read back through the CMS's tool route; the server's checks reject what the build
// would; versions are immutable; org templates stay in their org.
import { PROTOCOL_VERSION, type TemplateManifest } from '@signforge/contract';
import { pushFonts, pushTemplate, TemplatePushError, type TemplatePushOptions } from '@signforge/cli/template-push';
import { FONTS } from '@signforge/compiler';
import { platform, scoped } from '@signforge/db';
import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { app } from '../src/index';
import { baseBlobKey, orgBlobKey } from '../src/r2';
import { Client, clockLimits, email, testApp } from './client';

const TOKEN = 'test-admin-token'; // vitest.config.ts
const API = 'https://api.test';

interface Built {
  dir: string;
  manifest: TemplateManifest;
  html: string;
  sources: Record<string, string>;
  problems: string[];
}
const BUILDS = JSON.parse(env.TEMPLATE_BUILDS) as Built[];

const viaWorker = (url: string, init?: RequestInit) => exports.default.fetch(url, init);
const push = (b: Pick<Built, 'manifest' | 'html' | 'sources'>, extra: Partial<TemplatePushOptions> = {}) =>
  pushTemplate({ api: API, token: TOKEN, owner: 'base', manifest: b.manifest, html: b.html, sources: b.sources, fetch: viaWorker, ...extra });
const rejection = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TemplatePushError);
  return (err as Error).message;
};

/** A small template that passes every check, to vary in the rejection tests. */
const card = (over: { css?: string; main?: string; id?: string; version?: string } = {}) => {
  const clock = BUILDS.find((b) => b.dir === 'clock')!;
  return {
    manifest: { ...clock.manifest, id: over.id ?? 'card', version: over.version ?? '1.0.0', name: 'Card' },
    html: clock.html.replace('<style>', `<style>${over.css ?? ''}`),
    sources: { ...clock.sources, 'main.ts': over.main ?? clock.sources['main.ts']! },
  };
};

const hash = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Upload a template to the member's org and register it through the CMS's tool route, as the editor would. */
async function registerFromCms(c: ReturnType<typeof card>) {
  const sources = JSON.stringify(c.sources);
  const [bundleId, sourcesId] = await Promise.all([hash(c.html), hash(sources)]);
  await Promise.all([env.BLOBS.put(orgBlobKey(orgId, bundleId), c.html), env.BLOBS.put(orgBlobKey(orgId, sourcesId), sources)]);
  return member.tool('register_template_version', { manifest: c.manifest, bundleId, sourcesId });
}

const t = testApp();
const member = new Client(t);
let orgId: string;

beforeAll(async () => {
  await member.signIn(email('templates'));
  orgId = (await member.createOrg('Templates')).id;
});

describe('sf template seed', () => {
  it('builds all ten templates cleanly', () => {
    expect(BUILDS.map((b) => b.dir)).toEqual([
      'agenda',
      'alert',
      'announcement',
      'clock',
      'cstore-promo',
      'menu-board',
      'news',
      'photo-promo',
      'room-status',
      'weather',
    ]);
    for (const b of BUILDS) expect(b.problems, b.dir).toEqual([]);
  });

  it('pushes every template as an approved base template, and again changes nothing', async () => {
    for (const b of BUILDS) {
      const r = await push(b, { approve: true });
      expect(r, b.dir).toMatchObject({ key: `base/${b.manifest.id}@${b.manifest.version}`, status: 'approved', changed: true });
    }
    for (const b of BUILDS) expect(await push(b, { approve: true }), b.dir).toMatchObject({ status: 'approved', changed: false });

    // Bundles and sources under sys/b/, none under an org.
    const bundle = await env.BLOBS.list({ prefix: 'sys/b/' });
    expect(bundle.objects.length).toBe(BUILDS.length * 2);

    const audit = await platform(env.DB).auditLog.list({ limit: 100 });
    expect(audit.filter((a) => a.action === 'set_template_version_status')).toHaveLength(BUILDS.length);
    expect(audit.every((a) => a.actorKind === 'system' && a.actorId === 'sf-push' && a.clientId === 'sf-push')).toBe(true);
  });

  it("appear in every org's catalogue as approved base templates, with their check reports", async () => {
    const res = await member.tool('list_templates', { status: 'approved' });
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as {
      templates: {
        id: string;
        owner: string;
        key: string;
        versions: { id: string; key: string; status: string; manifest: TemplateManifest; checkReport: { ok: boolean; checks: unknown[] } }[];
      }[];
    };
    expect(templates.map((x) => x.key).sort()).toEqual(BUILDS.map((b) => b.manifest.id).sort());
    for (const x of templates) {
      expect(x.owner).toBe('base');
      expect(x.versions).toHaveLength(1);
      expect(x.versions[0]).toMatchObject({ status: 'approved', checkReport: { ok: true } });
      expect(x.versions[0]!.checkReport.checks).toHaveLength(6);
    }
    const weather = templates.find((x) => x.key === 'weather')!;
    const got = (await (await member.tool('get_template', { templateId: weather.id })).json()) as { template: { versions: { manifest: TemplateManifest }[] } };
    expect(got.template.versions[0]!.manifest).toMatchObject({ id: 'weather', orientations: expect.any(Array), protocol: PROTOCOL_VERSION });

    // Readable, not changeable, by an org.
    const retire = await member.tool('set_template_version_status', { templateVersionId: weather.versions[0]!.id, status: 'retired' });
    expect(retire.status).toBe(404);
  });
});

describe("the server's checks", () => {
  it('reject a bundle with backdrop-filter, with the reason', async () => {
    const message = await rejection(push(card({ id: 'glass', css: '.panel{backdrop-filter:blur(8px)}' })));
    expect(message).toMatch(/400/);
    expect(message).toMatch(/forbidden-css: `backdrop-filter` drops about a fifth of frames/);
    expect(await platform(env.DB).templates.ownByKey('glass')).toBeUndefined();
  });

  it('reject sources with a fetch( call, with the reason, though the bundled SDK calls parent.postMessage', async () => {
    expect(card().html).toContain('parent.postMessage');
    const message = await rejection(push(card({ id: 'fetcher', main: "const data = await fetch('/feed.json');\n" })));
    expect(message).toMatch(/source-code: templates may not make network requests/);
    expect(await platform(env.DB).templates.ownByKey('fetcher')).toBeUndefined();
  });

  it('refuse an existing version with different bytes', async () => {
    const message = await rejection(push(card({ id: 'clock', version: BUILDS.find((b) => b.dir === 'clock')!.manifest.version, css: 'h1{color:red}' })));
    expect(message).toMatch(/409/);
    expect(message).toMatch(/bump the version/);
  });
});

describe('org templates', () => {
  // The `unavailable` cases silence and read console.error; restored even when one fails.
  afterEach(() => vi.restoreAllMocks());
  it("go under the org's prefix, as drafts in its catalogue, audited in its log", async () => {
    const r = await push(card({ id: 'own-card', css: '.own{color:teal}' }), { owner: { org: orgId } });
    expect(r).toMatchObject({ key: `${orgId}/own-card@1.0.0`, status: 'draft', changed: true });
    const version = await scoped(env.DB, orgId).templates.versions.get(r.templateVersionId);
    expect(await env.BLOBS.head(orgBlobKey(orgId, version!.bundleSha256))).not.toBeNull();
    expect(await env.BLOBS.head(baseBlobKey(version!.bundleSha256))).toBeNull();

    const { templates } = (await (await member.tool('list_templates', {})).json()) as { templates: { key: string; owner: string }[] };
    expect(templates).toContainEqual(expect.objectContaining({ key: 'own-card', owner: 'org' }));
    const [entry] = await scoped(env.DB, orgId).auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ actorKind: 'system', actorId: 'sf-push', action: 'register_template_version', targetId: r.templateVersionId });
  });

  it('carry the runtime check in their check report', async () => {
    const r = await push(card({ id: 'checked-card' }), { owner: { org: orgId } });
    const version = await scoped(env.DB, orgId).templates.versions.get(r.templateVersionId);
    // Checked in the org's own container: the API names the org from its scope.
    expect(JSON.parse(version!.checkReportJson!).runtime).toMatchObject({
      ok: true,
      runner: { image: `stand-in /check/org/${orgId}` },
      renders: [{ orientation: 'landscape' }, { orientation: 'portrait' }],
    });
  });

  it('are refused when the runtime check finds a problem, with the problem', async () => {
    const message = await rejection(push(card({ id: 'leaky-card', css: '/* sf-runtime-fail */' }), { owner: { org: orgId } }));
    expect(message).toMatch(/runtime: requested https:\/\/example\.com\/leak \(blocked\)/);
    expect(await scoped(env.DB, orgId).templates.ownByKey('leaky-card')).toBeUndefined();
  });

  it('are not registered when the check answers with a report the contract refuses', async () => {
    const message = await rejection(push(card({ id: 'garbled-card', css: '/* sf-runtime-garbage */' }), { owner: { org: orgId } }));
    expect(message).toMatch(/500/);
    expect(await scoped(env.DB, orgId).templates.ownByKey('garbled-card')).toBeUndefined();
  });

  it('are refused to retry, not registered, when the check is not available', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = await rejection(push(card({ id: 'down-card', css: '/* sf-runtime-down */' }), { owner: { org: orgId } }));
    // Its answer says why to the operator's logs, not to the member or agent.
    expect(message).toMatch(/503\nthe template check is not available \(it answered 503\); try again in a minute$/);
    expect(logged).toHaveBeenCalledWith(`template check for ${orgId}: it answered 503`, expect.stringContaining('the check container did not start'));
    expect(await scoped(env.DB, orgId).templates.ownByKey('down-card')).toBeUndefined();

    const res = await registerFromCms(card({ id: 'down-cms-card', css: '/* sf-runtime-down */' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'unavailable', details: { retryAfterSeconds: 60 } });
  });

  for (const [marker, why, cause] of [
    ['sf-runtime-not-json', 'its answer could not be read', SyntaxError],
    ['sf-runtime-cut', 'its answer could not be read', Error],
  ] as const) {
    it(`are refused to retry when the check answers 200 but its body fails: ${marker}`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const message = await rejection(push(card({ id: `${marker}-card`, css: `/* ${marker} */` }), { owner: { org: orgId } }));
      expect(message).toMatch(new RegExp(`503\\nthe template check is not available \\(${why}\\); try again in a minute$`));
      expect(await scoped(env.DB, orgId).templates.ownByKey(`${marker}-card`)).toBeUndefined();
      // The cause goes to the operator's logs; the member or agent sees only the sentence above.
      expect(logged).toHaveBeenCalledWith(`template check for ${orgId}: ${why}`, expect.any(cause));
    });
  }

  it('are checked when registered from the CMS too', async () => {
    const res = await registerFromCms(card({ id: 'cms-card', css: '/* sf-runtime-fail */' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/^the template failed its runtime check: requested/);
  });

  it('are checked at most 10 times a minute per org: the next push is refused before the check, and the next minute counts anew', async () => {
    const busy = (await member.createOrg('Busy templates')).id;
    const calm = (await member.createOrg('Calm templates')).id;
    const bindings = clockLimits();
    const pushTo = (org: string, version: string) =>
      push(card({ id: 'busy-card', version }), { owner: { org }, fetch: async (url, init) => app.request(url, init, bindings, createExecutionContext()) });
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime('2026-11-20T12:00:00Z');
    for (let i = 0; i < 10; i++) expect((await pushTo(busy, `1.0.${i}`)).changed, `push ${i + 1}`).toBe(true);
    vi.setSystemTime('2026-11-20T12:00:59.999Z');
    expect(await rejection(pushTo(busy, '1.0.10'))).toMatch(/429\ntoo many template checks for this org; wait a minute and try again$/);
    // Another org's limit is its own.
    expect((await pushTo(calm, '1.0.0')).changed).toBe(true);
    vi.setSystemTime('2026-11-20T12:01:00Z');
    expect((await pushTo(busy, '1.0.10')).changed).toBe(true);
  });

  it('need an org that exists', async () => {
    expect(await rejection(push(card({ id: 'nobody' }), { owner: { org: 'org-nobody' } }))).toMatch(/404/);
  });
});

describe('sf fonts push', () => {
  const files = JSON.parse(env.FONT_FILES) as Record<string, string>;
  const read = (path: string) => Uint8Array.from(atob(files[path]!), (c) => c.charCodeAt(0));

  it('uploads every catalogue font file under sys/b/, where any org can read it', async () => {
    const r = await pushFonts({ api: API, token: TOKEN, read, fetch: viaWorker });
    const all = FONTS.flatMap((f) => f.files);
    expect(r.uploaded).toBe(all.length);
    for (const f of all) expect((await env.BLOBS.head(baseBlobKey(f.file)))?.size).toBe(f.size);
    expect((await env.BLOBS.head(baseBlobKey(all[0]!.file)))?.httpMetadata?.contentType).toBe('font/woff2');
    const res = await member.get(`/api/blobs/v2/${all[0]!.file}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(read('fonts/inter/400-normal.woff2'));
  });

  it('refuses a file whose bytes are not the catalogue entry, before uploading anything', async () => {
    const message = await rejection(pushFonts({ api: API, token: TOKEN, read: () => new Uint8Array([1, 2, 3]), fetch: viaWorker }));
    expect(message).toMatch(/^fonts\/inter\/400-normal\.woff2 does not match the catalogue/);
  });
});
