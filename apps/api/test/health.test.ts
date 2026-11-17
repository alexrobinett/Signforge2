import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('health', () => {
  it('reports the environment and build', async () => {
    const res = await exports.default.fetch('https://api.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: 'dev', version: 'dev', manifestSchema: 1 });
  });

  it('returns 404 for unknown routes', async () => {
    expect((await exports.default.fetch('https://api.test/nope')).status).toBe(404);
  });
});
