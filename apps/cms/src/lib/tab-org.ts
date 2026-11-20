/**
 * The org this tab shows, named in `TAB_ORG_HEADER` on every call to the API (#129): from the
 * browser (`callTool`, Better Auth's client) and through server functions (src/start.ts, then
 * `callApi`). The API refuses a call from a tab whose org is no longer the session's, so a tab left
 * on the old org after a switch in another tab is told to reload instead of acting on the new org.
 *
 * Browser only. The server renders for the session's org, so a server render sends no header.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { getRouterInstance } from '@tanstack/react-start';
import { TAB_ORG_HEADER } from '@signforge/api/tab-org';

/** Set while this tab's own switch reloads its data, before its shell shows the new org. */
let switchingTo: string | undefined;

/** The header naming the org of the shell on screen, or none outside the app shell or before an org is chosen. */
export async function tabOrgHeaders(): Promise<Record<string, string>> {
  const router = await getRouterInstance();
  const shell = router.state.matches.find((m) => m.routeId === '/_app')?.loaderData;
  const org = switchingTo ?? (shell && 'organization' in shell ? shell.organization?.id : undefined);
  return org ? { [TAB_ORG_HEADER]: org } : {};
}

/**
 * Reloads the tab's data after its own switch to `orgId`, its calls naming that org: the one its
 * shell is about to show. It waits for every loader, since one left running would name the old org.
 */
export async function reloadAs(router: AnyRouter, orgId: string) {
  switchingTo = orgId;
  try {
    await router.invalidate({ sync: true });
  } finally {
    switchingTo = undefined;
  }
}
