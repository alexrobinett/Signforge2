import { isRedirect } from '@tanstack/react-router';
import { isOrgChanged } from '~/lib/tools';

/**
 * Retry a failed read up to `tries` times, but never a redirect: a read whose session has ended
 * throws one to sign-in (`tool` in src/server/tools.server.ts), and the router's Query integration
 * follows it on the last failure. Retried, sign-in came 7s late, and a retry still running once the
 * address was sign-in's took it as the page to come back to (CI, 2026-11-19). Nor a refusal from a
 * tab left on the old org (#129): it holds until the tab reloads, so it shows at once.
 */
export const retryUnlessRedirect =
  (tries: number) =>
  (failures: number, error: Error): boolean =>
    !isRedirect(error) && !isOrgChanged(error) && failures < tries;
