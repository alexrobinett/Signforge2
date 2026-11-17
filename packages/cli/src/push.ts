/**
 * The client side of `sf push`: send one `sf build` output to the API and make it a screen's
 * desired manifest. TEMPORARY, like the `/admin` routes it calls (apps/api/src/admin), until the
 * CMS publishes (M3-12 replaces both).
 *
 * No Node imports, so the API's own tests run it inside workerd against the real routes.
 *
 *   1. Ask which of the manifest's files the API lacks.
 *   2. Upload only those; the API checks each against its hash.
 *   3. Upload the manifest; the API validates it and makes it the screen's desired manifest.
 */

export interface PushOptions {
  /** Base URL of the API, e.g. `http://127.0.0.1:8787`. */
  api: string;
  screen: string;
  /** The `ADMIN_TOKEN` deploy secret. Never logged. */
  token: string;
  /** `manifest.json` exactly as `sf build` wrote it. */
  manifestText: string;
  /** The bytes of `blobs/<sha256>`. */
  readBlob: (sha256: string) => Promise<Uint8Array> | Uint8Array;
  /** Defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Uploads in flight at once. */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface PushResult {
  manifestId: string;
  files: number;
  uploaded: number;
  uploadedBytes: number;
  /** False when the screen was already on this manifest. */
  changed: boolean;
}

type Missing = { sha256: string; scope: 'org' | 'base' };

export class PushError extends Error {}

export async function push(opts: PushOptions): Promise<PushResult> {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const api = opts.api.replace(/\/+$/, '');
  const screen = encodeURIComponent(opts.screen);
  const auth = { authorization: `Bearer ${opts.token}` };
  const manifest = JSON.parse(opts.manifestText) as { id: string; files: Record<string, { type: string }> };

  const call = async <T>(method: string, path: string, body: BodyInit, type: string): Promise<T> => {
    const res = await doFetch(`${api}${path}`, { method, headers: { ...auth, 'content-type': type }, body });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { error?: string; problems?: string[] };
        detail = [j.error, ...(j.problems ?? []).map((p) => `  - ${p}`)].filter(Boolean).join('\n');
      } catch { /* not JSON */ }
      throw new PushError(`${method} ${path}: ${res.status}${detail ? `\n${detail}` : ''}`);
    }
    return JSON.parse(text) as T;
  };

  const { missing } = await call<{ missing: Missing[] }>('POST', `/admin/screens/${screen}/missing`, opts.manifestText, 'application/json');
  const files = Object.keys(manifest.files).length;
  log(`${files} files in manifest ${manifest.id.slice(0, 16)}, ${files - missing.length} already on the server, ${missing.length} to upload`);

  let uploadedBytes = 0;
  const queue = [...missing];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const data = await opts.readBlob(f.sha256);
      const path = f.scope === 'base' ? `/admin/base/blobs/${f.sha256}` : `/admin/screens/${screen}/blobs/${f.sha256}`;
      await call('PUT', path, data as BodyInit, manifest.files[f.sha256]?.type ?? 'application/octet-stream');
      uploadedBytes += data.byteLength;
      log(`  uploaded ${f.sha256.slice(0, 12)} ${f.scope === 'base' ? '(base template) ' : ''}${(data.byteLength / 1024).toFixed(0)} kB`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  const set = await call<{ manifestId: string; changed: boolean }>('PUT', `/admin/screens/${screen}/manifest`, opts.manifestText, 'application/json');
  log(set.changed ? `manifest ${set.manifestId.slice(0, 16)} is now the desired manifest of ${opts.screen}` : `${opts.screen} was already on manifest ${set.manifestId.slice(0, 16)}; nothing changed`);
  return { manifestId: set.manifestId, files, uploaded: missing.length, uploadedBytes, changed: set.changed };
}
