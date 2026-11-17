/**
 * Bearer authentication for `/v1/device`. Mounted on the device tree only: no other tree reads
 * this header, and this middleware reads nothing else (a session cookie means nothing here).
 */
import { findDeviceScreen, type DeviceScreen } from '@signforge/db';
import { createMiddleware } from 'hono/factory';
import { hashSecret, parseCredential } from './credential';

export type DeviceEnv = { Bindings: Env; Variables: { screen: DeviceScreen } };

/** One response for every failure, so a caller cannot tell an unknown screen from a wrong secret. */
const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="device"' },
  });

const encoder = new TextEncoder();

/** Constant-time over equal-length hex hashes. */
function sameHash(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export const deviceAuth = createMiddleware<DeviceEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer[ ]+(\S+)$/i.exec(header);
  const parsed = match ? parseCredential(match[1]!) : undefined;
  if (!parsed) return unauthorized();

  const [hash, screen] = await Promise.all([hashSecret(parsed.secret), findDeviceScreen(c.env.DB, parsed.screenId)]);
  if (!screen) return unauthorized();
  // Check every live credential, so the time taken does not depend on which one matched.
  let ok = false;
  for (const stored of screen.secretHashes) ok = sameHash(hash, stored) || ok;
  if (!ok) return unauthorized();

  c.set('screen', screen);
  await next();
});
