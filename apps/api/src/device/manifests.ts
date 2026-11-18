/**
 * What a screen may fetch, read from its current and previous desired manifests in R2, and, for
 * files only, from the last good one it reports: a screen that fell back past its previous
 * manifest needs that one's files.
 *
 * A manifest's id is the hash of its body, so the object at a manifest key never changes and
 * its parsed summary can be kept for the life of the isolate.
 */
import { baseTemplateHtml, type ScreenManifest } from '@signforge/contract';
import type { DeviceScreen } from '@signforge/db';
import type { BoundField } from '../data/fit';
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
  /** By source: the fields its spots bind, which a snapshot must fill one of to be sent (../data/fit.ts). */
  bound: Map<string, BoundField[]>;
}

const MAX_CACHED = 256;
const cache = new Map<string, ManifestSummary>();

function boundBySource(m: ScreenManifest): Map<string, BoundField[]> {
  const out = new Map<string, BoundField[]>();
  for (const spot of Object.values(m.spots ?? {})) {
    if (spot.kind !== 'template') continue;
    const fields = m.templates[spot.template]?.manifest.fields;
    for (const [field, b] of Object.entries(spot.bindings ?? {})) out.set(b.source, [...(out.get(b.source) ?? []), { fields, field, path: b.path }]);
  }
  return out;
}

function summarise(id: string, m: ScreenManifest): ManifestSummary {
  return {
    id,
    schema: m.schema,
    protocols: [...new Set(Object.values(m.templates ?? {}).map((t) => t.manifest?.protocol ?? 1))],
    files: new Map(Object.entries(m.files ?? {}).map(([sha, f]) => [sha, f.type])),
    baseHtml: baseTemplateHtml(m),
    dataSources: new Set(Object.keys(m.dataSources ?? {})),
    bound: boundBySource(m),
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

const summaries = async (bucket: R2Bucket, screen: DeviceScreen, ids: (string | null)[]): Promise<ManifestSummary[]> => {
  const found = await Promise.all(
    [...new Set(ids)].filter((id): id is string => !!id).map((id) => load(bucket, manifestKey(screen.orgId, screen.screenId, id), id)),
  );
  return found.filter((m): m is ManifestSummary => !!m);
};

/** Summaries of the screen's current and previous desired manifests, whichever exist: what it may sync and read data for. */
export const screenManifests = (bucket: R2Bucket, screen: DeviceScreen): Promise<ManifestSummary[]> =>
  summaries(bucket, screen, [screen.desiredManifestId, screen.previousManifestId]);

/**
 * The manifests whose files the screen may fetch: `screenManifests` and the last good one it
 * reports. Files only: a file is fixed by its hash, while a feed's latest snapshot may postdate
 * the manifest. The id comes from the screen, but is read only under this screen's own prefix.
 */
export const fileManifests = (bucket: R2Bucket, screen: DeviceScreen): Promise<ManifestSummary[]> =>
  summaries(bucket, screen, [screen.desiredManifestId, screen.previousManifestId, screen.lastGoodManifestId]);
