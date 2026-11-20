/**
 * The API Worker, reached over the `API` service binding. The request keeps this site's origin,
 * which is also the API's (two Workers, one hostname), so Better Auth sees a same-origin call.
 */
import { env } from 'cloudflare:workers';
import { appendResponseHeader, getRequest } from '@tanstack/react-start/server';
import { ORG_CHANGED, TAB_ORG_HEADER } from '@signforge/api/tab-org';

/** Headers from the browser that the API reads: the session cookies, the client address for rate limits and the tab's org (src/lib/tab-org.ts). */
const FORWARDED = ['cookie', 'cf-connecting-ip', 'user-agent', 'accept-language', TAB_ORG_HEADER];

/**
 * Call the API as the signed-in browser, from server code: a GET, or a JSON POST with `body` (a tool's input). Any cookie the API sets (Better Auth
 * refreshing its cache cookie) goes back to the browser, which must keep every one of them. A call
 * from a tab whose org is no longer the session's throws the API's sentence, telling the member to reload.
 */
export async function callApi(path: `/api/${string}`, body?: unknown): Promise<Response> {
  const incoming = getRequest();
  const headers = new Headers({ accept: 'application/json' });
  for (const name of FORWARDED) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init: RequestInit = { headers };
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    init.method = 'POST';
    init.body = JSON.stringify(body);
  }
  const res = await env.API.fetch(new Request(new URL(path, incoming.url), init));
  for (const cookie of res.headers.getSetCookie()) appendResponseHeader('set-cookie', cookie);
  if (res.status === 409) {
    const refusal: { error?: string; message?: string } | null = await res
      .clone()
      .json()
      .catch(() => null);
    if (refusal?.error === ORG_CHANGED) throw new Error(refusal.message);
  }
  return res;
}

/** Hand a browser request for `/api/*` to the API Worker unchanged. */
export function forwardToApi(request: Request): Promise<Response> {
  return env.API.fetch(request);
}
