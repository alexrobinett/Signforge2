// Template tools: the server's lint on register, immutable versions, status, and base templates
// registered through the platform registry and read by every org.
import { platform, scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseBlobKey, dispatch, orgBlobKey, platformRegistry, registry, type Caller, type TemplateChecker } from '../src';
import type { PlatformScope } from '@signforge/db';
import type { TemplateRuntimeReport } from '@signforge/contract';

const encoder = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(s)));

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'promo',
  version: '1.0.0',
  name: 'Promo',
  fields: { title: { type: 'text', label: 'Title', default: 'Hi' } },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape'],
  uses: [],
  background: '#000',
  protocol: 1,
  ...over,
});
const html = (css = 'h1{color:red}', script = '"use strict";parent.postMessage({type:"loaded"},"*")') =>
  `<!doctype html><html><head><style>${css}</style></head><body><h1 data-sf="title"></h1><script>${script}</script></body></html>`;
const sources = (main = "import { defineTemplate } from '@signforge/template-sdk';\ndefineTemplate({});\n") =>
  JSON.stringify({ 'index.html': '<h1 data-sf="title"></h1>', 'style.css': 'h1 { color: red; }', 'main.ts': main });

/** A runtime check's report: `problems` decides whether it passed. */
const runtimeReport = (problems: string[] = []): TemplateRuntimeReport => ({
  ok: !problems.length,
  problems,
  runner: { image: 'test-runner', browser: 'Chromium 159' },
  renders: [{ orientation: 'landscape', viewport: { width: 1920, height: 1080 }, readyMs: 80, frames: { count: 60, longestMs: 17 } }],
  cost: { startMs: 0, checkMs: 2800 },
});
/** The checks a fake runtime check was asked for, as `<org>/<template id>`. */
const checked: string[] = [];
const passing: TemplateChecker = async ({ orgId, manifest }) => {
  checked.push(`${orgId}/${manifest.id}`);
  return runtimeReport();
};

let o: SeededOrg;
let owner: Caller;
let system: Caller<PlatformScope>;

/** Upload a bundle and sources under `key`, as `/admin` would, and return their hashes. */
async function upload(key: (sha: string) => string, bundle: string, src: string) {
  const [bundleId, sourcesId] = await Promise.all([sha256(bundle), sha256(src)]);
  await Promise.all([env.BLOBS.put(key(bundleId), bundle), env.BLOBS.put(key(sourcesId), src)]);
  return { bundleId, sourcesId };
}
const orgUpload = (bundle: string, src = sources()) => upload((sha) => orgBlobKey(o.orgId, sha), bundle, src);

const call = async <T = any>(name: string, input: unknown, as: Caller = owner): Promise<T> => {
  const r = await dispatch(registry, name, input, as);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};

beforeAll(async () => {
  o = await seedOrg(env.DB, 'tpl-org');
  owner = {
    org: scoped(env.DB, o.orgId),
    role: 'owner',
    actor: { kind: 'user', id: 'user-1', clientId: 'cms' },
    blobs: env.BLOBS,
    templateCheck: passing,
    rateLimit: async () => true,
  };
  system = {
    org: platform(env.DB),
    role: 'owner',
    scopes: ['content:draft', 'content:publish'],
    actor: { kind: 'system', id: 'sf-push', clientId: 'sf-push' },
    blobs: env.BLOBS,
  };
});

describe('register_template_version', () => {
  it('registers a draft with its check report, and the same bytes again change nothing', async () => {
    const ids = await orgUpload(html());
    const first = await call('register_template_version', { manifest: manifest(), ...ids });
    expect(first.changed).toBe(true);
    expect(first.version).toMatchObject({ key: `${o.orgId}/promo@1.0.0`, status: 'draft', bundleSha256: ids.bundleId });
    expect(first.version.checkReport).toMatchObject({
      ok: true,
      sourcesSha256: ids.sourcesId,
      checks: expect.arrayContaining([{ check: 'forbidden-css', ok: true, problems: [] }]),
    });
    // A colour literal outside var() is a warning: the version still registers.
    expect(first.version.checkReport.warnings).toEqual(['style.css:1: literal colour red in color; use var(--sf-*) with it as the fallback']);

    const again = await call('register_template_version', { manifest: manifest(), ...ids });
    expect(again).toMatchObject({ changed: false, version: { id: first.version.id } });
    expect(await scoped(env.DB, o.orgId).templates.versions.forTemplate(first.template.id)).toHaveLength(1);
  });

  it('refuses an existing version with different bytes', async () => {
    const ids = await orgUpload(html('h1{color:blue}'));
    const r = await dispatch(registry, 'register_template_version', { manifest: manifest(), ...ids }, owner);
    expect(r).toMatchObject({ ok: false, error: 'conflict', message: expect.stringMatching(/bump the version/) });
    // A new version is fine.
    expect((await call('register_template_version', { manifest: manifest({ version: '1.1.0' }), ...ids })).version.key).toBe(`${o.orgId}/promo@1.1.0`);
  });

  it('rejects a bundle with backdrop-filter, with the reason', async () => {
    const ids = await orgUpload(html('.panel{backdrop-filter: blur(8px)}'));
    const r = await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'glass' }), ...ids }, owner);
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'forbidden-css', message: expect.stringMatching(/backdrop-filter/) }] });
    expect(await scoped(env.DB, o.orgId).templates.ownByKey('glass')).toBeUndefined();
  });

  it("rejects sources that call fetch, though the bundle's SDK reaches its parent", async () => {
    const ids = await orgUpload(html(), sources("const r = await fetch('/data.json');\n"));
    const r = await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'fetcher' }), ...ids }, owner);
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'source-code', message: expect.stringMatching(/network requests/) }] });
  });

  it('rejects an invalid manifest, a bundle over budget and a network reference', async () => {
    const big = await orgUpload(html(`h1{content:"${'x'.repeat(600_001)}"}`));
    expect(await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'big' }), ...big }, owner)).toMatchObject({
      ok: false,
      details: [{ path: 'size', message: expect.stringMatching(/budget/) }],
    });
    const net = await orgUpload(html('h1{background:url(https://example.com/x.png)}'));
    expect(await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'net' }), ...net }, owner)).toMatchObject({
      ok: false,
      details: [{ path: 'network' }],
    });
    const ok = await orgUpload(html());
    expect(await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'Bad Id', duration: {} }), ...ok }, owner)).toMatchObject({
      ok: false,
      details: [{ path: 'manifest' }, { path: 'manifest' }],
    });
  });

  it('needs the files uploaded first', async () => {
    expect(
      await dispatch(registry, 'register_template_version', { manifest: manifest(), bundleId: 'e'.repeat(64), sourcesId: 'e'.repeat(64) }, owner),
    ).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('the runtime check', () => {
  it('runs on a new org version, and its report is stored with the version', async () => {
    const ids = await orgUpload(html('h1{color:teal}'));
    const out = await call('register_template_version', { manifest: manifest({ id: 'rendered' }), ...ids });
    expect(checked).toContain(`${o.orgId}/rendered`);
    expect(out.version.checkReport.runtime).toEqual(runtimeReport());
  });

  it("runs in the caller's org, from its scope, whatever the input names", async () => {
    const other = await seedOrg(env.DB, 'tpl-other');
    const as: Caller = { ...owner, org: scoped(env.DB, other.orgId) };
    const ids = await upload((sha) => orgBlobKey(other.orgId, sha), html('h1{color:lime}'), sources());
    await call('register_template_version', { manifest: manifest({ id: 'scoped' }), ...ids, orgId: o.orgId }, as);
    expect(checked).toContain(`${other.orgId}/scoped`);
    expect(checked).not.toContain(`${o.orgId}/scoped`);
  });

  it('refuses a version that fails it, with each problem, and stores nothing', async () => {
    const ids = await orgUpload(html('h1{color:olive}'));
    const failing: TemplateChecker = async () => runtimeReport(['requested https://example.com/x (blocked)', 'did not report ready within 2000 ms']);
    const r = await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'leaky' }), ...ids }, { ...owner, templateCheck: failing });
    expect(r).toMatchObject({
      ok: false,
      error: 'invalid_input',
      message: 'the template failed its runtime check: requested https://example.com/x (blocked); did not report ready within 2000 ms',
      details: [
        { path: 'runtime', message: 'requested https://example.com/x (blocked)' },
        { path: 'runtime', message: 'did not report ready within 2000 ms' },
      ],
    });
    expect(await scoped(env.DB, o.orgId).templates.ownByKey('leaky')).toBeUndefined();
  });

  it("counts against the org's rate limit, and over it is refused before the check runs", async () => {
    const ids = await orgUpload(html('h1{color:coral}'));
    const buckets: string[] = [];
    const over: Caller = {
      ...owner,
      rateLimit: async (bucket) => {
        buckets.push(bucket);
        return false;
      },
    };
    const before = checked.length;
    expect(await dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'busy' }), ...ids }, over)).toMatchObject({
      ok: false,
      error: 'rate_limited',
      message: 'too many template checks for this org; wait a minute and try again',
      details: { retryAfterSeconds: 60 },
    });
    expect(buckets).toEqual(['template_check']);
    expect(checked.length).toBe(before);
  });

  it('does not run again for a version already registered', async () => {
    const ids = await orgUpload(html('h1{color:navy}'));
    await call('register_template_version', { manifest: manifest({ id: 'once' }), ...ids });
    const before = checked.length;
    expect((await call('register_template_version', { manifest: manifest({ id: 'once' }), ...ids })).changed).toBe(false);
    expect(checked.length).toBe(before);
  });

  it('is required for an org template: without one, registering fails rather than skip it', async () => {
    const ids = await orgUpload(html('h1{color:maroon}'));
    const { templateCheck: _, ...unchecked } = owner;
    await expect(dispatch(registry, 'register_template_version', { manifest: manifest({ id: 'unchecked' }), ...ids }, unchecked)).rejects.toThrow(
      /runtime check/,
    );
  });

  it('does not run on base templates, which CI checks', async () => {
    const ids = await upload(baseBlobKey, html('h1{color:gold}'), sources());
    const never: TemplateChecker = () => Promise.reject(new Error('the runtime check ran on a base template'));
    const reg = await dispatch(
      platformRegistry,
      'register_template_version',
      { manifest: manifest({ id: 'base-unchecked' }), ...ids },
      { ...system, templateCheck: never },
    );
    expect(reg).toMatchObject({ ok: true });
    expect((reg as { output: { version: { checkReport: object } } }).output.version.checkReport).not.toHaveProperty('runtime');
  });
});

describe('base templates', () => {
  let baseVersion: string;

  it('are registered and approved through the platform registry, audited outside any org', async () => {
    const ids = await upload(baseBlobKey, html(), sources());
    const reg = await dispatch(platformRegistry, 'register_template_version', { manifest: manifest({ id: 'base-promo' }), ...ids }, system);
    expect(reg).toMatchObject({ ok: true, output: { changed: true, version: { key: 'base/base-promo@1.0.0', status: 'draft' } } });
    baseVersion = (reg as { output: { version: { id: string } } }).output.version.id;
    expect(await dispatch(platformRegistry, 'set_template_version_status', { templateVersionId: baseVersion, status: 'approved' }, system)).toMatchObject({
      ok: true,
      output: { changed: true, version: { status: 'approved' } },
    });

    const audit = await platform(env.DB).auditLog.list({ limit: 2 });
    expect(audit.map((a) => a.action)).toEqual(['set_template_version_status', 'register_template_version']);
    expect(audit[0]).toMatchObject({ actorKind: 'system', actorId: 'sf-push', clientId: 'sf-push', targetKind: 'template_version', targetId: baseVersion });
  });

  it("does not look in an org's prefix for a base template's files", async () => {
    const ids = await orgUpload(html('h1{color:green}'));
    expect(await dispatch(platformRegistry, 'register_template_version', { manifest: manifest({ id: 'stray' }), ...ids }, system)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('are listed for every org, which can read but not change them', async () => {
    const { templates } = await call('list_templates', { status: 'approved' });
    expect(templates[0]).toMatchObject({ owner: 'base', key: 'base-promo', versions: [{ id: baseVersion, status: 'approved', manifest: { name: 'Promo' } }] });
    expect(templates.every((t: { versions: { status: string }[] }) => t.versions.every((v) => v.status === 'approved'))).toBe(true);
    const got = await call('get_template', { templateId: templates[0].id });
    expect(got.template.versions[0].checkReport).toMatchObject({ ok: true });

    expect(await dispatch(registry, 'set_template_version_status', { templateVersionId: baseVersion, status: 'retired' }, owner)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    // Registering the same id and version in the org makes the org's own template, not a change to the base one.
    const ids = await orgUpload(html('h1{color:purple}'));
    expect((await call('register_template_version', { manifest: manifest({ id: 'base-promo' }), ...ids })).version.key).toBe(`${o.orgId}/base-promo@1.0.0`);
  });
});

describe('set_template_version_status', () => {
  it("approves and retires the org's own versions, owners only", async () => {
    const { templates } = await call('list_templates', { status: 'draft' });
    const draft = templates.find((t: { key: string }) => t.key === 'promo').versions[0].id;
    const editor = { ...owner, role: 'editor' as const };
    expect(await dispatch(registry, 'set_template_version_status', { templateVersionId: draft, status: 'approved' }, editor)).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect((await call('set_template_version_status', { templateVersionId: draft, status: 'approved' })).changed).toBe(true);
    expect((await call('set_template_version_status', { templateVersionId: draft, status: 'approved' })).changed).toBe(false);
    expect((await call('set_template_version_status', { templateVersionId: draft, status: 'retired' })).version.status).toBe('retired');
  });
});

describe('list_templates', () => {
  it('pages through names in any script', async () => {
    const intl = await seedOrg(env.DB, 'tpl-intl');
    const as: Caller = { ...owner, org: scoped(env.DB, intl.orgId) };
    const ids = await upload((sha) => orgBlobKey(intl.orgId, sha), html(), sources());
    const names = ['Zürich', '東京', 'القاهرة', '😀 Promo'];
    for (const [i, name] of names.entries()) await call('register_template_version', { manifest: manifest({ id: `intl-${i}`, name }), ...ids }, as);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const out = await call<{ templates: { owner: string; name: string }[]; next: string | null }>('list_templates', { limit: 1, cursor }, as);
      seen.push(...out.templates.filter((t) => t.owner !== 'base').map((t) => t.name));
      cursor = out.next ?? undefined;
    } while (cursor);
    // The seeded org has its own template too.
    expect(seen.filter((n) => names.includes(n)).sort()).toEqual([...names].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});
