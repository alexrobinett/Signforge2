/**
 * Templates: read the catalogue, register a built version, approve or retire one.
 *
 * The registering and status tools are shared: dispatched with an org's scope they write the
 * org's own templates, dispatched by `/admin` with `platform(db)` (the platform registry) they
 * write base templates. Reads go through an org's scope and see its own templates and base ones.
 *
 * Registering repeats `sf build`'s checks on what was uploaded (`checkTemplateBundle` in the
 * contract): the manifest, forbidden CSS, the size budget and network references on the bundle,
 * the forbidden-code list on the author's sources. These are a lint. The template sandbox and its
 * no-network policy are the guarantee; the bundle carries the SDK, which itself calls
 * `parent.postMessage`, so the code list cannot run on it.
 */
import { canonicalJson, checkTemplateBundle, TEMPLATE_CHECKS, templateKey, type TemplateCheckReport, type TemplateManifest } from '@signforge/contract';
import type { Template, TemplateVersion } from '@signforge/db';
import { z } from 'zod';
import { id } from './fields';
import { nextOutput, page, pageInput, type SortKey } from './paging';
import { baseBlobKey, orgBlobKey } from './r2';
import { defineSharedTool, defineTool, notFound, ToolError, type DataScope } from './tool';

const SHA256 = /^[0-9a-f]{64}$/;
const sha = (what: string) => z.string().regex(SHA256, `not a ${what} hash (64 lowercase hex characters)`);

const STATUSES = ['draft', 'approved', 'retired'] as const;

/**
 * A built `template.json`. Checked loosely: the contract has no runtime schema for it yet (M3-31);
 * `checkTemplateBundle` checked it in full when the version was registered.
 */
const manifestOutput = z
  .custom<TemplateManifest>(
    (v) =>
      z
        .looseObject({ id: z.string(), version: z.string(), name: z.string(), fields: z.record(z.string(), z.unknown()), orientations: z.array(z.string()) })
        .safeParse(v).success,
    'not a template manifest',
  )
  .describe("The template's template.json, as built: id, version, name, fields, duration, orientations, uses, background");

/** What is stored on a version: the contract's report, plus when it ran and on which sources. */
const checkReportOutput = z.object({
  ok: z.boolean(),
  bundleBytes: z.number(),
  checks: z.array(z.object({ check: z.enum(TEMPLATE_CHECKS), ok: z.boolean(), problems: z.array(z.string()) })),
  warnings: z.array(z.string()).optional().describe('Findings that do not stop the version: colour literals outside a var(--sf-*) fallback'),
  checkedAt: z.number(),
  sourcesSha256: z.string(),
});
export type StoredCheckReport = TemplateCheckReport & { checkedAt: number; sourcesSha256: string };

const versionOutput = z.object({
  id: z.string(),
  templateId: z.string(),
  key: z.string().describe('How manifests and spots name it: <owner>/<id>@<version>'),
  version: z.string(),
  status: z.enum(STATUSES),
  manifest: manifestOutput,
  bundleSha256: z.string(),
  checkReport: checkReportOutput.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TemplateVersionView = z.infer<typeof versionOutput>;

const templateOutput = z.object({
  id: z.string(),
  owner: z.enum(['base', 'org']).describe("base for the platform's templates, every org's to use; org for the org's own"),
  key: z.string().describe('The id in its template.json, such as menu-board'),
  name: z.string(),
  versions: z.array(versionOutput).describe('Oldest first'),
});
export type TemplateView = z.infer<typeof templateOutput>;

const versionView = (v: TemplateVersion): TemplateVersionView => {
  const manifest = JSON.parse(v.manifestJson) as TemplateManifest;
  return {
    id: v.id,
    templateId: v.templateId,
    key: templateKey(manifest, v.orgId ?? 'base'),
    version: v.version,
    status: v.status,
    manifest,
    bundleSha256: v.bundleSha256,
    checkReport: v.checkReportJson ? (JSON.parse(v.checkReportJson) as StoredCheckReport) : null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
};

const templateView = (t: Template, versions: TemplateVersion[]): TemplateView => ({
  id: t.id,
  owner: t.orgId === null ? 'base' : 'org',
  key: t.key,
  name: t.name,
  versions: versions.map(versionView),
});

/** Where a scope's uploads live in R2: base templates under `sys/b/`, an org's under its prefix. */
const blobKey = (scope: DataScope, sha256: string) => (scope.orgId === null ? baseBlobKey(sha256) : orgBlobKey(scope.orgId, sha256));

/** Base templates first, then by name as people read it, then by id. */
const byOwnerThenName = (a: SortKey, b: SortKey) =>
  Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1])) || (a[2] === b[2] ? 0 : String(a[2]) < String(b[2]) ? -1 : 1);

const listTemplates = defineTool({
  name: 'list_templates',
  description:
    "List the templates this org can use for spots: the platform's base templates and the org's own. Each has its versions, oldest first, with the version's manifest (name, fields, duration range, orientations), status (draft, approved or retired) and the server's check report. Only approved versions should be offered for new spots. Pass status to list only versions with that status; templates with none are left out. Base templates come first, then by name, a page at a time. Returns { templates: Template[], next }; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ status: z.enum(STATUSES).optional().describe('Only versions with this status'), ...pageInput }),
  output: z.object({ templates: z.array(templateOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    const templates = await org.templates.list();
    const out: TemplateView[] = [];
    for (const t of templates) {
      const versions = (await org.templates.versions.forTemplate(t.id)).filter((v) => !input.status || v.status === input.status);
      if (input.status && !versions.length) continue;
      out.push(templateView(t, versions));
    }
    const { rows, next } = page(out, (t) => [t.owner === 'base' ? 0 : 1, t.name, t.id], input, byOwnerThenName);
    return { templates: rows, next };
  },
});

const getTemplate = defineTool({
  name: 'get_template',
  description:
    "Get one template this org can use (its own or a base one) with every version: manifest, status and the server's check report. Returns { template }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ templateId: id('template') }),
  output: z.object({ template: templateOutput }),
  example: { templateId: 'tpl_example' },
  handler: async ({ org, input }) => {
    const t = await org.templates.get(input.templateId);
    if (!t) throw notFound('template', input.templateId);
    return { template: templateView(t, await org.templates.versions.forTemplate(t.id)) };
  },
});

/** Sources as uploaded: a JSON object of file name to text. */
const sourcesSchema = z.record(z.string(), z.string());

const registerTemplateVersion = defineSharedTool({
  name: 'register_template_version',
  description:
    "Register a built template version whose bundle and sources are already uploaded (`sf template push` does both). The server lints them as `sf build` does: the manifest, forbidden CSS (backdrop-filter), the 600 kB size budget and network references on the bundle, and forbidden code (fetch, navigation) on the author's sources. Colour literals in the CSS outside a var(--sf-*) fallback are reported as warnings in the check report and do not stop the version. A version that fails is refused with each problem and nothing is stored. Versions are immutable: registering an existing version with the same bundle and manifest changes nothing, and with different ones is refused; bump the version instead. A new version is a draft. Returns { template, version, changed }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    manifest: z.record(z.string(), z.unknown()).describe("The built template's template.json, with the protocol the build added"),
    bundleId: sha('bundle').describe("SHA-256 of the built HTML file, uploaded to the owner's prefix"),
    sourcesId: sha('sources').describe("SHA-256 of the author's sources, uploaded as a JSON object of file name to text"),
  }),
  output: z.object({ template: templateOutput, version: versionOutput, changed: z.boolean() }),
  example: {
    manifest: {
      id: 'promo',
      version: '1.0.0',
      name: 'Promo',
      fields: { title: { type: 'text', label: 'Title', default: 'Hello' } },
      duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
      orientations: ['landscape'],
      uses: [],
      background: '#000',
      protocol: 1,
    },
    bundleId: '0'.repeat(64),
    sourcesId: '1'.repeat(64),
  },
  target: (_input, output) => ({ kind: 'template_version', id: output.version.id }),
  handler: async ({ org, blobs, input, write }) => {
    const [bundle, sourcesObj] = await Promise.all([blobs.get(blobKey(org, input.bundleId)), blobs.get(blobKey(org, input.sourcesId))]);
    if (!bundle) throw new ToolError('not_found', `bundle ${input.bundleId} has not been uploaded`);
    if (!sourcesObj) throw new ToolError('not_found', `sources ${input.sourcesId} have not been uploaded`);
    const html = await bundle.text();
    let sources: Record<string, string>;
    try {
      sources = sourcesSchema.parse(JSON.parse(await sourcesObj.text()));
    } catch {
      throw new ToolError('invalid_input', 'the sources are not a JSON object of file name to text', [
        { path: 'sourcesId', message: 'not a JSON object of file name to text' },
      ]);
    }

    const report = checkTemplateBundle({ manifest: input.manifest, html, sources });
    if (!report.ok) {
      const problems = report.checks.flatMap((c) => c.problems.map((message) => ({ path: c.check, message })));
      throw new ToolError('invalid_input', `the template failed its checks: ${problems.map((p) => p.message).join('; ')}`, problems);
    }
    const manifest = input.manifest as unknown as TemplateManifest;
    const manifestJson = JSON.stringify(manifest);

    const existing = await org.templates.ownByKey(manifest.id);
    if (existing) {
      const prior = await org.templates.versions.ownVersion(existing.id, manifest.version);
      if (prior) {
        const same = prior.bundleSha256 === input.bundleId && canonicalJson(JSON.parse(prior.manifestJson)) === canonicalJson(manifest);
        if (!same) {
          throw new ToolError(
            'conflict',
            `${templateKey(manifest, org.orgId ?? 'base')} is already registered with a different bundle or manifest; versions never change, so bump the version`,
            {
              versionId: prior.id,
              bundleSha256: prior.bundleSha256,
            },
          );
        }
        return { template: templateView(existing, [prior]), version: versionView(prior), changed: false };
      }
    }

    // A new template and its first version are written together.
    const template = existing
      ? write(org.templates.stage.update(existing, { name: manifest.name }))
      : write(org.templates.stage.insert({ key: manifest.id, name: manifest.name }));
    const stored: StoredCheckReport = { ...report, checkedAt: Date.now(), sourcesSha256: input.sourcesId };
    const version = write(
      org.templates.versions.stage.insert({
        templateId: template.id,
        version: manifest.version,
        manifestJson,
        bundleSha256: input.bundleId,
        status: 'draft',
        checkReportJson: JSON.stringify(stored),
      }),
    );
    return { template: templateView(template, [version]), version: versionView(version), changed: true };
  },
});

const setTemplateVersionStatus = defineSharedTool({
  name: 'set_template_version_status',
  description:
    'Approve a template version, so spots may use it, or retire it, so no new spot does. Spots already using a retired version keep playing it. Base templates belong to the platform; an org can change only its own. Setting the status it already has changes nothing. Returns { version, changed }.',
  scope: 'content:publish',
  minRole: 'owner',
  mutates: true,
  input: z.object({
    templateVersionId: id('template version'),
    status: z.enum(['approved', 'retired']),
  }),
  output: z.object({ version: versionOutput, changed: z.boolean() }),
  example: { templateVersionId: 'tpv_example', status: 'approved' },
  target: (input) => ({ kind: 'template_version', id: input.templateVersionId }),
  handler: async ({ org, input, write }) => {
    // The scope's own version only: an org may read a base version but not change it.
    const current = await org.templates.versions.get(input.templateVersionId);
    if (!current || current.orgId !== org.orgId) throw notFound('template version', input.templateVersionId);
    if (current.status === input.status) return { version: versionView(current), changed: false };
    return { version: versionView(write(org.templates.versions.stage.update(current, { status: input.status }))), changed: true };
  },
});

export const templateTools = [listTemplates, getTemplate, registerTemplateVersion, setTemplateVersionStatus];

/** The tools `/admin` runs with `platform(db)` on base templates. */
export const platformTemplateTools = [registerTemplateVersion, setTemplateVersionStatus];
