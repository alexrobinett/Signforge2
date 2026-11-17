/**
 * What a screen may fetch, read from its current and previous desired manifests in R2.
 *
 * A manifest's id is the hash of its body, so the object at a manifest key never changes and
 * its parsed summary can be kept for the life of the isolate.
 */
import type { ScreenManifest } from '@signforge/contract';
import type { DeviceScreen } from '@signforge/db';
import { manifestKey } from '../r2';

export interface ManifestSummary {
  id: string;
  schema: number;
  /** The frame protocol of each template, 1 where a bundle names none. */
  protocols: number[];
  /** File hash to content type. */
  files: Map<string, string>;
  /** Hashes of base templates' HTML, which may live under `sys/b/`. */
  baseHtml: Set<string>;
  dataSources: Set<string>;
}

const MAX_CACHED = 256;
const cache = new Map<string, ManifestSummary>();

function summarise(id: string, m: ScreenManifest): ManifestSummary {
  return {
    id,
    schema: m.schema,
    protocols: [...new Set(Object.values(m.templates ?? {}).map((t) => t.manifest?.protocol ?? 1))],
    files: new Map(Object.entries(m.files ?? {}).map(([sha, f]) => [sha, f.type])),
    baseHtml: new Set(Object.entries(m.templates ?? {}).filter(([key]) => key.startsWith('base/')).map(([, t]) => t.html)),
    dataSources: new Set(Object.keys(m.dataSources ?? {})),
  };
}

async function load(bucket: R2Bucket, key: string, id: string): Promise<ManifestSummary | undefined> {
  const hit = cache.get(key);
  if (hit) return hit;
  const obj = await bucket.get(key);
  if (!obj) return undefined;
  const summary = summarise(id, await obj.json<ScreenManifest>());
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, summary);
  return summary;
}

/** Summaries of the screen's current and previous desired manifests, whichever exist. */
export async function screenManifests(bucket: R2Bucket, screen: DeviceScreen): Promise<ManifestSummary[]> {
  const ids = [...new Set([screen.desiredManifestId, screen.previousManifestId])].filter((id): id is string => !!id);
  const found = await Promise.all(ids.map((id) => load(bucket, manifestKey(screen.orgId, screen.screenId, id), id)));
  return found.filter((m): m is ManifestSummary => !!m);
}
