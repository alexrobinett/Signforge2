/**
 * Better Auth's browser client, against the API's `/api/auth` on this same origin. The browser
 * keeps every cookie a response sets, including the cache cookie `setActive` reissues, so the
 * next request sees the new active org.
 */
import { ac, roles } from '@signforge/api/roles';
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  // The API's roles (owner, editor, viewer), so member and invitation calls take them by name.
  plugins: [emailOTPClient(), organizationClient({ ac, roles })],
});

/** Better Auth's error, as a sentence for the page. */
export function authErrorMessage(error: { message?: string; code?: string; status?: number } | null | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.message || fallback;
}
