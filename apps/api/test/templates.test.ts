// `sf template push` against the real /admin routes, driven by the real client
// (packages/cli/src/template-push.ts): every template in templates/ becomes an approved base
// template, read back through the CMS's tool route; the server's checks reject what the build
// would; versions are immutable; org templates stay in their org.
import type { TemplateManifest } from '@signforge/contract';
import { pushTemplate, TemplatePushError, type TemplatePushOptions } from '@signforge/cli/template-push';
import { platform, scoped } from '@signforge/db';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseBlobKey, orgBlobKey } from '../src/r2';
import { Client, email, testApp } from './client';

const TOKEN = 'test-admin-token'; // vitest.config.ts
const API = 'https://api.test';

interface Built { dir: string; manifest: TemplateManifest; html: string; sources: Record<string, string>; problems: string[] }
const BUILDS = JSON.parse(env.TEMPLATE_BUILDS) as Built[];

const viaWorker = (url: string, init?: RequestInit) => exports.default.fetch(url, init);
const push = (b: Pick<Built, 'manifest' | 'html' | 'sources'>, extra: Partial<TemplatePushOptions> = {}) =>
  pushTemplate({ api: API, token: TOKEN, owner: 'base', manifest: b.manifest, html: b.html, sources: b.sources, fetch: viaWorker, ...extra });
const rejection = async (p: Promise<unknown>) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
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

const t = testApp();
const member = new Client(t);
let orgId: string;

beforeAll(async () => {
  await member.signIn(email('templates'));
  orgId = (await member.createOrg('Templates')).id;
});

describe('sf template seed', () => {
  it('builds all seven templates cleanly', () => {
    expect(BUILDS.map((b) => b.dir)).toEqual(['agenda', 'clock', 'cstore-promo', 'menu-board', 'news', 'photo-promo', 'weather']);
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
    const { templates } = (await res.json()) as { templates: { id: string; owner: string; key: string; versions: { id: string; key: string; status: string; manifest: TemplateManifest; checkReport: { ok: boolean; checks: unknown[] } }[] }[] };
    expect(templates.map((x) => x.key).sort()).toEqual(BUILDS.map((b) => b.manifest.id).sort());
    for (const x of templates) {
      expect(x.owner).toBe('base');
      expect(x.versions).toHaveLength(1);
      expect(x.versions[0]).toMatchObject({ status: 'approved', checkReport: { ok: true } });
      expect(x.versions[0]!.checkReport.checks).toHaveLength(5);
    }
    const weather = templates.find((x) => x.key === 'weather')!;
    const got = (await (await member.tool('get_template', { templateId: weather.id })).json()) as { template: { versions: { manifest: TemplateManifest }[] } };
    expect(got.template.versions[0]!.manifest).toMatchObject({ id: 'weather', orientations: expect.any(Array), protocol: 1 });

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
    const message = await rejection(push(card({ id: 'clock', version: '1.0.0', css: 'h1{color:red}' })));
    expect(message).toMatch(/409/);
    expect(message).toMatch(/bump the version/);
  });
});

describe('org templates', () => {
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

  it('need an org that exists', async () => {
    expect(await rejection(push(card({ id: 'nobody' }), { owner: { org: 'org-nobody' } }))).toMatch(/404/);
  });
});
