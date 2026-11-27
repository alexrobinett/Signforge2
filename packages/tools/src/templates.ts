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
 *
 * An org's new version is then rendered by the runtime check (`apps/template-check`, through
 * `templateCheck`), which sees what the lint cannot: a request, a navigation, an error, no ready.
 * Base templates skip it here; CI checks every one, so a failure there fails a build, not a seed.
 */
import {
  canonicalJson,
  checkTemplateBundle,
  parseTemplateManifest,
  templateKey,
  type TemplateCheckReport,
  type TemplateManifest,
  type TemplateRuntimeReport,
} from '@signforge/contract';
import type { Template, TemplateVersion } from '@signforge/db';
import { z } from 'zod';
import { page, type SortKey } from './paging';
import { baseBlobKey, orgBlobKey } from './r2';
import { clearOfSweep } from './assets';
import { defineSharedTool, defineTool, notFound, ToolError, type DataScope } from './tool';
import { outputs, type TemplateVersionView, type TemplateView } from './outputs';
import { inputs } from './inputs';

export type StoredCheckReport = TemplateCheckReport & { checkedAt: number; sourcesSha256: string };

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
  input: inputs.list_templates,
  output: outputs.list_templates,
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
  input: inputs.get_template,
  output: outputs.get_template,
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
    "Register a built template version whose bundle and sources are already uploaded (`sf template push` does both). The server lints them as `sf build` does: the manifest, forbidden CSS (backdrop-filter), the 600 kB size budget and network references on the bundle, and forbidden code (fetch, navigation) on the author's sources. An org's new version is then rendered headless in the player's sandbox, with no network, in each orientation it supports (a few seconds): any request, navigation, uncaught error, failed prepare, no ready within 2 s, or no second of frames within 3 s of play refuses it. Colour literals in the CSS outside a var(--sf-*) fallback are reported as warnings in the check report and do not stop the version. A version that fails is refused with each problem and nothing is stored. Versions are immutable: registering an existing version with the same bundle and manifest changes nothing, and with different ones is refused; bump the version instead. A new version is a draft. Returns { template, version, changed }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  // Only an org's new version uses them; /admin passes them for base templates too.
  needs: ['templateCheck', 'rateLimit'],
  input: inputs.register_template_version,
  output: outputs.register_template_version,
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
  target: (_input, output) => (output ? { kind: 'template_version', id: output.version.id } : undefined),
  handler: async ({ org, blobs, input, write, services: { templateCheck, rateLimit } }) => {
    const [bundle, sourcesObj] = await Promise.all([blobs.get(blobKey(org, input.bundleId)), blobs.get(blobKey(org, input.sourcesId))]);
    if (!bundle) throw new ToolError('not_found', `bundle ${input.bundleId} has not been uploaded`);
    if (!sourcesObj) throw new ToolError('not_found', `sources ${input.sourcesId} have not been uploaded`);
    const html = await bundle.text();
    let sources: Record<string, string>;
    try {
      sources = sourcesSchema.parse(JSON.parse(await sourcesObj.text()));
    } catch (e) {
      // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
      throw new ToolError(
        'invalid_input',
        'the sources are not a JSON object of file name to text',
        [{ path: 'sourcesId', message: 'not a JSON object of file name to text' }],
        false,
        { cause: e },
      );
    }

    const report = checkTemplateBundle({ manifest: input.manifest, html, sources });
    // The parse fails only when the report's manifest check does, so the problems below are never empty.
    const parsed = parseTemplateManifest(input.manifest);
    if (!report.ok || !parsed.ok) {
      const problems = report.checks.flatMap((c) => c.problems.map((message) => ({ path: c.check, message })));
      throw new ToolError('invalid_input', `the template failed its checks: ${problems.map((p) => p.message).join('; ')}`, problems);
    }
    const manifest = parsed.value;
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
    // An org's bundle and sources are content-addressed in its own prefix, as uploads are: not while a sweep deletes them.
    // After the version already registered returns, which writes nothing (review of #429, round 2).
    if ('storage' in org) {
      await clearOfSweep(org, write, [input.bundleId, input.sourcesId]);
      // Read above, and held across the runtime check below, which takes seconds: refused if the sweep has deleted
      // either, from here or at the commit (review of #434, 2).
      const now = Date.now();
      const deleted = await org.storage.deleted([input.bundleId, input.sourcesId], now);
      if (deleted.length) throw new ToolError('conflict', 'the storage clean-up deleted files this version names: upload them again', { deleted });
      write({ row: undefined, writes: org.storage.stage.notDeleted([input.bundleId, input.sourcesId], now) });
    }

    let runtime: TemplateRuntimeReport | undefined;
    if (org.orgId !== null) {
      // An org's checks share its one container: a push loop is slowed here, before it reaches it.
      if (!(await rateLimit('template_check'))) {
        throw new ToolError('rate_limited', 'too many template checks for this org; wait a minute and try again', { retryAfterSeconds: 60 });
      }
      runtime = await templateCheck({ orgId: org.orgId, manifest, html });
      if (!runtime.ok) {
        throw new ToolError(
          'invalid_input',
          `the template failed its runtime check: ${runtime.problems.join('; ')}`,
          runtime.problems.map((message) => ({ path: 'runtime', message })),
        );
      }
    }

    // A new template and its first version are written together.
    const template = existing
      ? write(org.templates.stage.update(existing, { name: manifest.name }))
      : write(org.templates.stage.insert({ key: manifest.id, name: manifest.name }));
    const stored: StoredCheckReport = { ...report, ...(runtime ? { runtime } : {}), checkedAt: Date.now(), sourcesSha256: input.sourcesId };
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
    'Approve a template version, so spots may use it, or retire it, so no new spot does. Spots already using a retired version keep playing it. Base templates belong to the platform; an org can change only its own. Setting the status it already has changes nothing. People only: an agent is refused. Returns { version, changed }.',
  scope: 'content:publish',
  minRole: 'owner',
  mutates: true,
  // Approving code that runs on every screen showing it is a person's review (#122): an agent could otherwise approve the
  // version it registered.
  people: true,
  input: inputs.set_template_version_status,
  output: outputs.set_template_version_status,
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
