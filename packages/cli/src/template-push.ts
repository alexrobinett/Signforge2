/**
 * The client side of `sf template push`: send one built template to the API and register it.
 * TEMPORARY, like the `/admin` routes it calls (apps/api/src/admin), until templates are submitted
 * through the CMS and agents hold OAuth grants (Milestone 4).
 *
 * No Node imports, so the API's own tests run it inside workerd against the real routes.
 *
 *   1. Upload the bundle and the author's sources (a JSON object of file name to text): base
 *      templates to `sys/b/`, an org's to its prefix. The API checks each against its hash.
 *   2. Register the version: the API runs the `register_template_version` tool, which repeats the
 *      build's checks and stores the report, and with `approve` then approves a new draft. Both
 *      are audited as the system actor `sf-push`.
 */
import { FONTS, fontFilePath } from '@signforge/compiler';
import type { TemplateManifest } from '@signforge/contract';

export interface TemplatePushOptions {
  /** Base URL of the API, e.g. `http://127.0.0.1:8787`. */
  api: string;
  /** The `ADMIN_TOKEN` deploy secret. Never logged. */
  token: string;
  /** `base` for a platform template every org can use, or the id of the org that owns it. */
  owner: 'base' | { org: string };
  /** The built `template.json`, with its protocol. */
  manifest: TemplateManifest;
  /** The built HTML file. */
  html: string;
  /** The author's files by name. */
  sources: Record<string, string>;
  /** Approve the version if this push registers it as a draft. Never revives a retired version. */
  approve?: boolean;
  /** Defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

export interface TemplatePushResult {
  /** `<owner>/<id>@<version>`. */
  key: string;
  templateVersionId: string;
  status: 'draft' | 'approved' | 'retired';
  /** False when this exact version was already registered. */
  changed: boolean;
}

export class TemplatePushError extends Error {}

const encoder = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: BufferSource) => hex(await crypto.subtle.digest('SHA-256', data));

export async function pushTemplate(opts: TemplatePushOptions): Promise<TemplatePushResult> {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const api = opts.api.replace(/\/+$/, '');
  const prefix = opts.owner === 'base' ? '/admin/base' : `/admin/orgs/${encodeURIComponent(opts.owner.org)}`;

  const call = async <T>(method: string, path: string, body: BodyInit, type: string): Promise<T> => {
    const res = await doFetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${opts.token}`, 'content-type': type }, body });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { error?: string; problems?: string[] };
        detail = [j.error, ...(j.problems ?? []).map((p) => `  - ${p}`)].filter(Boolean).join('\n');
      } catch {
        /* not JSON */
      }
      throw new TemplatePushError(`${method} ${path}: ${res.status}${detail ? `\n${detail}` : ''}`);
    }
    return JSON.parse(text) as T;
  };

  const bundle = encoder.encode(opts.html);
  const sources = encoder.encode(JSON.stringify(opts.sources));
  const [bundleId, sourcesId] = await Promise.all([sha256(bundle), sha256(sources)]);
  await call('PUT', `${prefix}/blobs/${bundleId}`, bundle as BodyInit, 'text/html');
  await call('PUT', `${prefix}/blobs/${sourcesId}`, sources as BodyInit, 'application/json');
  log(`uploaded bundle ${bundleId.slice(0, 12)} (${(bundle.byteLength / 1024).toFixed(0)} kB) and sources ${sourcesId.slice(0, 12)}`);

  const r = await call<TemplatePushResult>(
    'PUT',
    `${prefix}/templates`,
    JSON.stringify({ manifest: opts.manifest, bundleId, sourcesId, approve: opts.approve ?? false }),
    'application/json',
  );
  log(r.changed ? `${r.key} registered, ${r.status}` : `${r.key} was already registered with these bytes (${r.status}); nothing changed`);
  return r;
}

/**
 * The client side of `sf fonts push`: upload every font file in the catalogue (compiler `FONTS`)
 * to `sys/b/`, where brand kits' manifests find them. Every file is checked against its catalogue
 * hash before anything is sent. Run on every deploy with `sf template seed`; a file already
 * stored is stored again unchanged.
 */
export async function pushFonts(opts: {
  api: string;
  /** The `ADMIN_TOKEN` deploy secret. Never logged. */
  token: string;
  /** A file's bytes by its path from the repo root (`fontFilePath`). */
  read: (path: string) => Uint8Array | Promise<Uint8Array>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}): Promise<{ uploaded: number; bytes: number }> {
  const doFetch = opts.fetch ?? fetch;
  const api = opts.api.replace(/\/+$/, '');
  const files: { path: string; sha: string; data: Uint8Array }[] = [];
  for (const font of FONTS)
    for (const f of font.files) {
      const path = fontFilePath(font, f);
      const data = await opts.read(path);
      if ((await sha256(data as BufferSource)) !== f.file)
        throw new TemplatePushError(`${path} does not match the catalogue's sha256 for ${font.id} ${f.weight}`);
      files.push({ path, sha: f.file, data });
    }
  let bytes = 0;
  for (const f of files) {
    const res = await doFetch(`${api}/admin/base/blobs/${f.sha}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'font/woff2' },
      body: f.data as BodyInit,
    });
    if (!res.ok) throw new TemplatePushError(`PUT /admin/base/blobs/${f.sha}: ${res.status} ${await res.text()}`);
    bytes += f.data.byteLength;
  }
  opts.log?.(`uploaded ${files.length} font files (${(bytes / 1024).toFixed(0)} kB) to sys/b/`);
  return { uploaded: files.length, bytes };
}
