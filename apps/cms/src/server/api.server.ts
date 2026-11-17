/**
 * The API Worker, reached over the `API` service binding. The request keeps this site's origin,
 * which is also the API's (two Workers, one hostname), so Better Auth sees a same-origin call.
 */
import { env } from 'cloudflare:workers';
import { appendResponseHeader, getRequest } from '@tanstack/react-start/server';

/** Headers from the browser that the API reads: the session cookies and the client address for rate limits. */
const FORWARDED = ['cookie', 'cf-connecting-ip', 'user-agent', 'accept-language'];

/**
 * Call the API as the signed-in browser, from server code. Any cookie the API sets (Better Auth
 * refreshing its cache cookie) goes back to the browser, which must keep every one of them.
 */
export async function callApi(path: `/api/${string}`): Promise<Response> {
  const incoming = getRequest();
  const headers = new Headers({ accept: 'application/json' });
  for (const name of FORWARDED) {
    const value = incoming.headers.get(name);
    if (value) headers.set(name, value);
  }
  const res = await env.API.fetch(new Request(new URL(path, incoming.url), { headers }));
  for (const cookie of res.headers.getSetCookie()) appendResponseHeader('set-cookie', cookie);
  return res;
}

/** Hand a browser request for `/api/*` to the API Worker unchanged. */
export function forwardToApi(request: Request): Promise<Response> {
  return env.API.fetch(request);
}
