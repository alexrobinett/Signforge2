/**
 * Better Auth's browser client, against the API's `/api/auth` on this same origin. The browser
 * keeps every cookie a response sets, including the cache cookie `setActive` reissues, so the
 * next request sees the new active org.
 */
import { ac, roles } from '@signforge/api/roles';
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { tabOrgHeaders } from './tab-org';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  // The API's roles (owner, editor, viewer), so member and invitation calls take them by name.
  plugins: [emailOTPClient(), organizationClient({ ac, roles })],
  // The tab's org, so a call on the active org from a tab left on another is refused (#129).
  fetchOptions: {
    async onRequest(ctx) {
      for (const [name, value] of Object.entries(await tabOrgHeaders())) ctx.headers.set(name, value);
    },
  },
});

/** Better Auth's error, as a sentence for the page. */
export function authErrorMessage(error: { message?: string; code?: string; status?: number } | null | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.message || fallback;
}
