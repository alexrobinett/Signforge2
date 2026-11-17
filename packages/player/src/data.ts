/**
 * Live data on the device. For each data source in the manifest the player fetches the latest
 * snapshot from `data/<id>.json` (with the device credential when the base is the API), keeps it
 * in memory for spots to read, and stores it on disk so the last good value survives a restart
 * with no network.
 *
 * Live data is checked twice. A snapshot is kept only if it is well formed and fills at least one
 * field bound to it in the current manifest; and each bound value is checked against its field
 * again when a spot plays (`resolveSpotData`), so a value that does not fit leaves the spot's
 * fallback on screen. Every refusal is counted against its source in `dataRejections`.
 */
import { validateDataSnapshot, type DataSnapshot, type ScreenManifest } from '@signforge/contract';
import { snapshotFit, type Rejected } from '@signforge/player-core';

const STATE = 'sf-state-v1';
const key = (id: string) => `/_sf/data/${id}`;

const snapshots = new Map<string, DataSnapshot>();
const checkedAt = new Map<string, number>();
/** Sources whose first load has finished, with or without data. */
const settled = new Set<string>();
const waiters = new Set<() => void>();
const markSettled = (id: string) => {
  settled.add(id);
  waiters.forEach((w) => w());
};

const rejections = new Map<string, number>();
const warned = new Set<string>();

/**
 * Count refused live data against its source and log each distinct problem once, so a broken feed
 * shows in `__sf` (and the heartbeat, once it reports this) without filling the console every play.
 */
export function reportRejected(rejected: Rejected[]): void {
  for (const { source, problem } of rejected) {
    rejections.set(source, (rejections.get(source) ?? 0) + 1);
    const line = `[sf] data from ${source} ignored: ${problem}`;
    if (warned.has(line)) continue;
    if (warned.size < 200) warned.add(line);
    console.warn(line);
  }
}

/** Live values and snapshots refused per source since the player started. */
export function dataRejections(): Record<string, number> {
  return Object.fromEntries(rejections);
}

/** Latest snapshot per source. Read by a spot each time it starts. */
export const liveData: ReadonlyMap<string, DataSnapshot> = snapshots;

async function restore(id: string): Promise<void> {
  if (snapshots.has(id)) return;
  const res = await (await caches.open(STATE)).match(key(id));
  if (res) snapshots.set(id, (await res.json()) as DataSnapshot);
}

async function refresh(base: string, id: string, manifest: ScreenManifest, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${base}/data/${id}.json`, { cache: 'no-store', headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return;
  const text = await res.text();
  const next = JSON.parse(text) as DataSnapshot;
  // A malformed snapshot never replaces the last good one, which is also what survives offline.
  const problems = validateDataSnapshot(next);
  if (problems.length || next.id !== id) {
    reportRejected([{ source: id, problem: `snapshot ignored: ${problems[0] ?? `it is for "${String(next.id)}"`}` }]);
    return;
  }
  if (next.fetchedAt === snapshots.get(id)?.fetchedAt) return;
  // Nor does one that fits none of the fields bound to it: the last good one stays the latest.
  const fit = snapshotFit(manifest, next);
  if (fit.problems.length && !fit.fits) {
    reportRejected([{ source: id, problem: `snapshot fits no bound field: ${fit.problems[0]}` }]);
    return;
  }
  snapshots.set(id, next);
  await (await caches.open(STATE)).put(key(id), new Response(text, { headers: { 'content-type': 'application/json' } }));
}

/**
 * Keep every source in the current manifest fresh. Returns `wake`, which runs a pass now: call it
 * when a manifest is adopted, so a fresh screen does not wait for the next scheduled pass (on a
 * cold boot the first pass runs before any manifest has loaded and finds no sources). Fetch
 * failures are silent: the last good value stays.
 */
export function startDataLoop(
  base: string,
  manifest: () => ScreenManifest | undefined,
  headers: () => Promise<Record<string, string>> = async () => ({}),
): () => void {
  // Every source at once: one slow feed must not hold back the others.
  const one = async (m: ScreenManifest, s: ScreenManifest['dataSources'][string]) => {
    await restore(s.id).catch(() => undefined);
    const last = checkedAt.get(s.id) ?? 0;
    if (Date.now() - last >= s.refreshS * 1000) {
      checkedAt.set(s.id, Date.now());
      await refresh(base, s.id, m, await headers()).catch(() => undefined);
    }
    if (!settled.has(s.id)) markSettled(s.id);
  };
  let running: Promise<void> | undefined;
  let timer = 0;
  const tick = (): Promise<void> => {
    clearTimeout(timer);
    const m = manifest();
    running ??= Promise.all(m ? Object.values(m.dataSources).map((s) => one(m, s)) : []).then(() => {
      running = undefined;
      timer = window.setTimeout(() => void tick(), 5000);
    });
    return running;
  };
  void tick();
  // A wake during a pass runs one more pass after it, so sources added meanwhile are not missed.
  return () => void (running ? running.then(() => tick()) : tick());
}

/**
 * Resolve once each source has finished its first load (from the network, or failing that the
 * stored copy), or after `timeoutMs`. Data is fixed for one play, so a spot that starts before its
 * feed has loaded shows its fallback values for the whole play: after a cold boot that was the
 * first weather or calendar spot. Waiting is bounded so a screen with no network still plays.
 */
export function dataSettled(ids: string[], timeoutMs: number): Promise<void> {
  const done = () => ids.every((id) => settled.has(id));
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      waiters.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => done() && finish();
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(check);
  });
}

/** When each source was last updated, for the status overlay. */
export function dataStatus(): Record<string, string> {
  return Object.fromEntries([...snapshots].map(([id, s]) => [id, s.fetchedAt]));
}
