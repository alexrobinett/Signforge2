// The isolate's manifest cache (src/device/manifests.ts): 1,000 screens must not push each other's manifests out, or every
// sync reads R2 again.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { MAX_CACHED, manifestSummary } from '../src/device/manifests';
import { manifestKey } from '../src/r2';

/** The test's R2 with every `get` counted. */
function countedBucket() {
  const seen = { gets: 0 };
  const bucket = new Proxy(env.BLOBS, {
    get(target, prop) {
      if (prop === 'get')
        return (key: string) => {
          seen.gets++;
          return target.get(key);
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { bucket, seen };
}

it('holds the manifests of at least 1,000 screens, so a second sync reads none from R2, and drops the oldest first when full', async () => {
  expect(MAX_CACHED).toBeGreaterThanOrEqual(1024);
  const { bucket, seen } = countedBucket();
  const ids = Array.from({ length: MAX_CACHED }, (_, i) => `screen-${i}`);
  await Promise.all(
    ids.map((screen) => env.BLOBS.put(manifestKey('cache-org', screen, 'man_c'), JSON.stringify({ files: {}, spots: {}, templates: {}, screen: {} }))),
  );
  for (const screen of ids) expect(await manifestSummary(bucket, 'cache-org', screen, 'man_c')).toMatchObject({ id: 'man_c' });
  expect(seen.gets).toBe(MAX_CACHED);
  for (const screen of ids) await manifestSummary(bucket, 'cache-org', screen, 'man_c');
  expect(seen.gets).toBe(MAX_CACHED);
  // One more than it holds: the oldest (screen-0) is read again, the newest is not.
  await env.BLOBS.put(manifestKey('cache-org', 'overflow', 'man_c'), JSON.stringify({ files: {}, spots: {}, templates: {}, screen: {} }));
  await manifestSummary(bucket, 'cache-org', 'overflow', 'man_c');
  expect(seen.gets).toBe(MAX_CACHED + 1);
  await manifestSummary(bucket, 'cache-org', 'overflow', 'man_c');
  expect(seen.gets).toBe(MAX_CACHED + 1);
  await manifestSummary(bucket, 'cache-org', 'screen-0', 'man_c');
  expect(seen.gets).toBe(MAX_CACHED + 2);
});
