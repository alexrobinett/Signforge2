/** The consent page's read (M4-05): the API checks the provider's signed query and says what to show. */
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { ConnectRequest } from '~/lib/connect';
import { callApi } from './api.server';

/** What to show for a signed query, or why it cannot be shown: signed out, or a query the API refuses. */
export const getConnectRequest = createServerFn({ method: 'GET' })
  .validator((oauthQuery: string) => oauthQuery)
  .handler(async ({ data: oauthQuery }): Promise<{ ok: true; request: ConnectRequest } | { ok: false; signedOut: boolean; message: string }> => {
    const res = await callApi(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`);
    if (res.ok) return { ok: true, request: await res.json() };
    const body: { message?: string } = await res.json();
    return { ok: false, signedOut: res.status === 401, message: body.message ?? 'This request cannot be shown.' };
  });

/**
 * The page request's own query string, as the provider signed it. The router re-serializes the
 * search it parses (repeated keys, encodings), so the page reads the signed query here, once, on
 * the provider's redirect, which is always a full page load.
 */
export const getSignedQuery = createServerFn({ method: 'GET' }).handler(() => new URL(getRequest().url).search.slice(1));
