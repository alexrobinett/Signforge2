/**
 * What a screen may fetch, read from its current and previous desired manifests in R2, and, for
 * files only, from the last good one it reports: a screen that fell back past its previous
 * manifest needs that one's files.
 *
 * A manifest's id is the hash of its body, so the object at a manifest key never changes and
 * its parsed summary can be kept for the life of the isolate.
 */
import { baseTemplateHtml, type ManifestNeeds, manifestNeeds, type ScreenManifest } from '@signforge/contract';
import type { DeviceScreen } from '@signforge/db';
import { type BoundField, manifestBoundFields } from '@signforge/player-core';
import { manifestKey } from '../r2';

/** A manifest as a screen's sync reads it: what it needs of a player (`manifestNeeds`), and what the screen may fetch. */
export interface ManifestSummary extends ManifestNeeds {
  id: string;
  /** File hash to content type. */
  files: Map<string, string>;
  /** Hashes of base templates' HTML, which may live under `sys/b/`. */
  baseHtml: Set<string>;
  dataSources: Set<string>;
  /** By source: the fields its spots bind, which a snapshot must fit to be sent (player-core's `snapshotFit`). */
  bound: Map<string, BoundField[]>;
}

const MAX_CACHED = 256;
const cache = new Map<string, ManifestSummary>();

function summarise(id: string, m: ScreenManifest): ManifestSummary {
  return {
    id,
    ...manifestNeeds(m),
    files: new Map(Object.entries(m.files ?? {}).map(([sha, f]) => [sha, f.type])),
    baseHtml: baseTemplateHtml(m),
    dataSources: new Set(Object.keys(m.dataSources ?? {})),
    bound: manifestBoundFields(m),
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

/** One screen's manifest `id`, summarised, or undefined if R2 has none: for the poller, which reads what screens play (#481). */
export const manifestSummary = (bucket: R2Bucket, orgId: string, screenId: string, id: string) => load(bucket, manifestKey(orgId, screenId, id), id);

const summaries = async (bucket: R2Bucket, screen: DeviceScreen, ids: (string | null)[]): Promise<ManifestSummary[]> => {
  const found = await Promise.all([...new Set(ids)].filter((id): id is string => !!id).map((id) => manifestSummary(bucket, screen.orgId, screen.screenId, id)));
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
