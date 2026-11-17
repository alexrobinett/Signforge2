/**
 * Live data on the device. For each data source in the manifest the player fetches the latest
 * snapshot from `data/<id>.json`, keeps it in memory for spots to read, and stores it on disk
 * so the last good value survives a restart with no network.
 */
import type { DataSnapshot, DataSource } from '@signforge/contract';

const STATE = 'sf-state-v1';
const key = (id: string) => `/_sf/data/${id}`;

const snapshots = new Map<string, DataSnapshot>();
const checkedAt = new Map<string, number>();

/** Latest snapshot per source. Read by a spot each time it starts. */
export const liveData: ReadonlyMap<string, DataSnapshot> = snapshots;

async function restore(id: string): Promise<void> {
  if (snapshots.has(id)) return;
  const res = await (await caches.open(STATE)).match(key(id));
  if (res) snapshots.set(id, (await res.json()) as DataSnapshot);
}

async function refresh(base: string, id: string): Promise<void> {
  const res = await fetch(`${base}/data/${id}.json`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return;
  const text = await res.text();
  const next = JSON.parse(text) as DataSnapshot;
  if (next.fetchedAt === snapshots.get(id)?.fetchedAt) return;
  snapshots.set(id, next);
  await (await caches.open(STATE)).put(key(id), new Response(text, { headers: { 'content-type': 'application/json' } }));
}

/** Keep every source in the current manifest fresh. Failures are silent: the last good value stays. */
export function startDataLoop(base: string, sources: () => Record<string, DataSource>): void {
  const tick = async () => {
    for (const s of Object.values(sources())) {
      await restore(s.id).catch(() => undefined);
      const last = checkedAt.get(s.id) ?? 0;
      if (Date.now() - last < s.refreshS * 1000) continue;
      checkedAt.set(s.id, Date.now());
      await refresh(base, s.id).catch(() => undefined);
    }
    setTimeout(tick, 5000);
  };
  void tick();
}

/** When each source was last updated, for the status overlay. */
export function dataStatus(): Record<string, string> {
  return Object.fromEntries([...snapshots].map(([id, s]) => [id, s.fetchedAt]));
}
