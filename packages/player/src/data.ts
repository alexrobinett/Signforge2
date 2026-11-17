/**
 * Live data on the device. For each data source in the manifest the player fetches the latest
 * snapshot from `data/<id>.json` (with the device credential when the base is the API), keeps it
 * in memory for spots to read, and stores it on disk so the last good value survives a restart
 * with no network.
 */
import { validateDataSnapshot, type DataSnapshot, type DataSource } from '@signforge/contract';

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

/** Latest snapshot per source. Read by a spot each time it starts. */
export const liveData: ReadonlyMap<string, DataSnapshot> = snapshots;

async function restore(id: string): Promise<void> {
  if (snapshots.has(id)) return;
  const res = await (await caches.open(STATE)).match(key(id));
  if (res) snapshots.set(id, (await res.json()) as DataSnapshot);
}

async function refresh(base: string, id: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${base}/data/${id}.json`, { cache: 'no-store', headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return;
  const text = await res.text();
  const next = JSON.parse(text) as DataSnapshot;
  // A malformed snapshot never replaces the last good one, which is also what survives offline.
  const problems = validateDataSnapshot(next);
  if (problems.length || next.id !== id) {
    console.warn(`[sf] snapshot for ${id} ignored: ${problems[0] ?? `it is for "${String(next.id)}"`}`);
    return;
  }
  if (next.fetchedAt === snapshots.get(id)?.fetchedAt) return;
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
  sources: () => Record<string, DataSource>,
  headers: () => Promise<Record<string, string>> = async () => ({}),
): () => void {
  // Every source at once: one slow feed must not hold back the others.
  const one = async (s: DataSource) => {
    await restore(s.id).catch(() => undefined);
    const last = checkedAt.get(s.id) ?? 0;
    if (Date.now() - last >= s.refreshS * 1000) {
      checkedAt.set(s.id, Date.now());
      await refresh(base, s.id, await headers()).catch(() => undefined);
    }
    if (!settled.has(s.id)) markSettled(s.id);
  };
  let running: Promise<void> | undefined;
  let timer = 0;
  const tick = (): Promise<void> => {
    clearTimeout(timer);
    running ??= Promise.all(Object.values(sources()).map(one)).then(() => {
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
