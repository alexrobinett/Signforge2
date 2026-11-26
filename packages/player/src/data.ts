/**
 * Live data on the device. Snapshots arrive two ways: from the device API, on each sync's response
 * (`offerSnapshots`), which sends only those newer than the screen reports holding; or, for static
 * content beside the player (the demo, `sf build` output), by fetching `data/<id>.json` for each
 * source in the manifest (`startDataLoop`). Either way the latest is kept in memory for spots to
 * read and stored on disk, so the last good value survives a restart with no network.
 *
 * Live data is checked twice. A snapshot is kept only if it is well formed and fits the fields
 * bound to it in the current manifest (player-core's `snapshotFit`, which the server runs too);
 * and each bound value is checked against its field again when a spot plays (`resolveSpotData`),
 * so a value that does not fit leaves the spot's fallback on screen. Every refusal is counted
 * against its source in `dataRejections`.
 */
import { isNewsImage, MIN_REFRESH_S, parseDataSnapshot, type DataSnapshot, type ScreenManifest, type SyncResponse } from '@signforge/contract';
import { manifestBoundFields, snapshotFit, type Rejected } from '@signforge/player-core';

const STATE = 'sf-state-v1';
const key = (id: string) => `/_sf/data/${id}`;

const snapshots = new Map<string, DataSnapshot>();
/** The highest version offered per source, kept or refused: reported on sync so a refused one is not sent again. */
const seen = new Map<string, number>();
/** When static content last fetched each source's file. */
const fetchedAt = new Map<string, number>();
/** Sources whose first load has finished, with or without data. */
const settled = new Set<string>();
const waiters = new Set<() => void>();
const markSettled = (id: string) => {
  settled.add(id);
  waiters.forEach((w) => w());
};

/**
 * Snapshots refused for the manifest playing while the sync already named another, by source,
 * with that one's id. The server does not send a version again once the screen reports it, so
 * each is offered again when a manifest is adopted: a table whose column was renamed and remapped
 * while the screen was behind fits the manifest that maps it.
 */
const pending = new Map<string, { snapshot: DataSnapshot; desired: string }>();

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
  if (!res) return;
  const stored: DataSnapshot = await res.json();
  // A copy stored before snapshots carried checkedAt (M3-23) counts as checked when fetched; the next sync's `checked` moves it on.
  snapshots.set(id, { ...stored, checkedAt: stored.checkedAt ?? stored.fetchedAt });
}

const store = async (id: string, snap: DataSnapshot) =>
  (await caches.open(STATE)).put(key(id), new Response(JSON.stringify(snap), { headers: { 'content-type': 'application/json' } }));

/**
 * Keep `input` as the source's latest if it is a well-formed snapshot, newer, and fits the fields
 * bound to it in `manifest`. `desired` is the manifest the sync named, when it names one.
 */
async function offer(id: string, input: unknown, manifest: ScreenManifest | undefined, desired?: string): Promise<void> {
  // A malformed snapshot never replaces the last good one, which is also what survives offline.
  const parsed = parseDataSnapshot(input);
  if (!parsed.ok || parsed.value.id !== id) {
    reportRejected([{ source: id, problem: `snapshot ignored: ${parsed.ok ? `it is for "${parsed.value.id}"` : parsed.problems[0]}` }]);
    return;
  }
  const next = parsed.value;
  if (Number.isSafeInteger(next.version) && next.version >= 0) seen.set(id, Math.max(seen.get(id) ?? -1, next.version));
  // Keep the newest: an older snapshot can arrive after a newer one. (A copy stored before
  // snapshots had versions has none, and any versioned one replaces it.)
  if (next.version <= (snapshots.get(id)?.version ?? -1)) return;
  // Nor does one that fits none of the fields bound to it, or lacks a column a table maps: the last good one stays the latest.
  const fit = manifest ? snapshotFit(manifestBoundFields(manifest).get(id) ?? [], next.data) : undefined;
  if (fit?.refused) {
    const why = fit.refused === 'unfit' ? 'fits no bound field' : 'lacks a column a table maps';
    reportRejected([{ source: id, problem: `snapshot ${why}: ${fit.problems[0]}` }]);
    if (desired && desired !== manifest?.id) pending.set(id, { snapshot: next, desired });
    return;
  }
  pending.delete(id);
  snapshots.set(id, next);
  await store(id, next);
}

async function refresh(base: string, id: string, manifest: ScreenManifest): Promise<void> {
  const res = await fetch(`${base}/data/${id}.json`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return;
  await offer(id, await res.json(), manifest);
}

/**
 * Snapshots from a sync's response, each checked against the manifest `playing` gives as it comes
 * to it: a new manifest the answer names is adopted later, by the content worker, which then marks
 * that manifest's sources loaded too, and one it adopts while these are written is the one the rest
 * are checked against.
 */
export async function offerSnapshots(list: readonly DataSnapshot[], playing: () => ScreenManifest | undefined, desired: string | undefined): Promise<void> {
  for (const snap of list) await offer(snap.id, snap, playing(), desired).catch((err: unknown) => console.warn('[sf] could not keep a snapshot', err));
}

/** Offer `manifest`, just adopted, the snapshots refused for the one before it while the sync named another. */
export async function offerPending(manifest: ScreenManifest): Promise<void> {
  // Each stays waiting until its own offer is done: a sync between offers prunes photos by `namedImages`, which reads
  // the waiting ones too.
  for (const [id, p] of [...pending]) {
    await offer(id, p.snapshot, manifest, p.desired).catch((err: unknown) => console.warn('[sf] could not keep a snapshot', err));
    if (pending.get(id) === p) pending.delete(id);
  }
}

/**
 * A sync's `checked`: the server confirmed a snapshot again without sending its data. Moves on the
 * held copy's `checkedAt` (which staleness counts from) only for the version it names, so a
 * refused newer version never freshens the older copy still held.
 */
export async function offerChecked(checked: NonNullable<SyncResponse['checked']>): Promise<void> {
  for (const [id, c] of Object.entries(checked)) {
    const held = snapshots.get(id);
    if (!held || held.version !== c.version || Date.parse(c.checkedAt) <= Date.parse(held.checkedAt)) continue;
    const next = { ...held, checkedAt: c.checkedAt };
    snapshots.set(id, next);
    await store(id, next).catch((err: unknown) => console.warn('[sf] could not keep a snapshot', err));
  }
}

/**
 * Every feed photo a snapshot the screen holds or keeps waiting names (any `{ file, thumb }` in its data): what a
 * manifest still on its way can need. A photo only a superseded snapshot named is in none of them.
 */
export function namedImages(): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (isNewsImage(v)) {
      out.add(v.file);
      out.add(v.thumb);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(visit);
  };
  for (const snap of snapshots.values()) visit(snap.data);
  for (const { snapshot } of pending.values()) visit(snapshot.data);
  return out;
}

/** Load the stored snapshots of `manifest`'s sources, for a screen whose data comes on sync. */
export async function restoreSources(manifest: ScreenManifest): Promise<void> {
  await Promise.all(Object.keys(manifest.dataSources).map((id) => restore(id).catch(() => undefined)));
}

/** Every source of `manifest` has had its first load, with or without data (no network: the stored copy). */
export function settleSources(manifest: ScreenManifest | undefined): void {
  for (const id of Object.keys(manifest?.dataSources ?? {})) if (!settled.has(id)) markSettled(id);
}

/** The version of each snapshot held, or refused, by source: what a sync reports. */
export function heldVersions(): Record<string, number> {
  const out = Object.fromEntries(seen);
  for (const [id, snap] of snapshots) if (Number.isSafeInteger(snap.version)) out[id] = Math.max(out[id] ?? -1, snap.version);
  return out;
}

/**
 * Static content: keep every source in the current manifest fresh by fetching its file each minute. Returns `wake`, which runs a pass now: call it
 * when a manifest is adopted, so a fresh screen does not wait for the next scheduled pass (on a
 * cold boot the first pass runs before any manifest has loaded and finds no sources). Fetch
 * failures are silent: the last good value stays.
 */
export function startDataLoop(base: string, manifest: () => ScreenManifest | undefined, onSnapshot?: (m: ScreenManifest) => Promise<void>): () => void {
  // Every source at once: one slow feed must not hold back the others.
  const one = async (m: ScreenManifest, s: ScreenManifest['dataSources'][string]) => {
    await restore(s.id).catch(() => undefined);
    // Every source once a minute: `refreshS` is the server's poll interval, not the screen's.
    const last = fetchedAt.get(s.id) ?? 0;
    if (Date.now() - last >= MIN_REFRESH_S * 1000) {
      fetchedAt.set(s.id, Date.now());
      await refresh(base, s.id, m).catch(() => undefined);
    }
    if (onSnapshot) await onSnapshot(m).catch(() => undefined);
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
  // biome-ignore lint/nursery/noMisusedPromises: `running` is tested for being there, not awaited as a condition; it is undefined between passes.
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

/**
 * Preview: the CMS posts each source's latest snapshot with the draft, in place of the data loop.
 * Every source of the draft counts as loaded, with or without one, so no spot waits for a feed.
 * Bound values are still checked against their fields when a spot plays.
 */
export function usePostedData(manifest: ScreenManifest, posted: readonly DataSnapshot[]): void {
  for (const s of posted) snapshots.set(s.id, s);
  for (const id of Object.keys(manifest.dataSources)) if (!settled.has(id)) markSettled(id);
}
