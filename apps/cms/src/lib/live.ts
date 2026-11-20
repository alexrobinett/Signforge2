/**
 * A ticking clock for relative times, and what the member may do. Pages re-read their data on
 * navigation and after an action; the Screens page also polls what each screen is doing
 * (src/queries/screens.ts).
 */
import { getRouteApi, useRouterState, type AnyRouter } from '@tanstack/react-router';
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

type Matches = AnyRouter['state']['matches'];
function shellOrg(matches: Matches): string | undefined {
  const shell: unknown = matches.find((m) => m.routeId === '/_app')?.loaderData;
  if (typeof shell !== 'object' || shell === null || !('organization' in shell)) return undefined;
  const org = shell.organization;
  return typeof org === 'object' && org !== null && 'id' in org && typeof org.id === 'string' ? org.id : undefined;
}

/**
 * The org the page shows, or undefined outside the app shell: a store action checks a late answer
 * against it, so an answer for the org the tab has left changes nothing in the one it shows.
 */
export const orgOnScreen = (router: AnyRouter) => shellOrg(router.state.matches);

/** The same, for a component that may render outside the app shell (the invitation page). */
export const useOrgOnScreen = () => useRouterState({ select: (s) => shellOrg(s.matches) });

/** Editors and owners manage screens; viewers read. */
export const useCanManage = () => useRole() !== 'viewer';

/** Whether the member may publish here: the tools the shell lists for them include it (an editor loses it when only owners publish). */
export const useCanPublish = () => app.useLoaderData().tools.some((t) => t.name === 'publish');
