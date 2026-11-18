/**
 * A ticking clock for relative times, and what the member may do. Pages re-read their data on
 * navigation and after an action. Fleet status does not refresh on its own yet: it is to poll
 * through TanStack Query (docs/research/cms-data-layer.md, Decision; GitHub issue #35).
 */
import { getRouteApi } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';

/** How often the clock the pages read from ticks. */
const TICK_MS = 10_000;

/** The clock, in TICK_MS steps, as an outside store. */
const clock = {
  subscribe(changed: () => void) {
    const t = setInterval(changed, TICK_MS);
    return () => clearInterval(t);
  },
  now: () => Math.floor(Date.now() / TICK_MS) * TICK_MS,
};

/** The time the page reads from: never earlier than when its data came (`at`), then ticking. */
export function useNow(at: number): number {
  const ticked = useSyncExternalStore(clock.subscribe, clock.now, () => at);
  return Math.max(at, ticked);
}

const app = getRouteApi('/_app');

/** The member's role in the active org. The API checks it again on every call. */
export function useRole() {
  return app.useLoaderData().organization?.role ?? 'viewer';
}

/** The active org's id: the first part of every Query key (src/queries/). The `_app` layout renders pages only with one. */
export function useOrgId(): string {
  return app.useLoaderData().organization?.id ?? '';
}

/** Editors and owners manage screens; viewers read. */
export const useCanManage = () => useRole() !== 'viewer';
