import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Client, testApp } from './client';

describe('/api/sign-in-options', () => {
  it('is public and offers GitHub only when both secrets are set', async () => {
    const t = testApp();
    const without = await new Client(t, undefined, { ...env, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined }).get('/api/sign-in-options');
    expect(without.status).toBe(200);
    expect(await without.json()).toEqual({ emailCode: true, github: false, codesInTerminal: true });

    const half = await new Client(t, undefined, { ...env, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: undefined }).get('/api/sign-in-options');
    expect((await half.json<{ github: boolean; codesInTerminal: boolean }>()).github).toBe(false);

    const both = await new Client(t, undefined, { ...env, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }).get('/api/sign-in-options');
    expect((await both.json<{ github: boolean; codesInTerminal: boolean }>()).github).toBe(true);
  });

  it('does not say codes go to the terminal outside dev', async () => {
    const res = await new Client(testApp(), undefined, { ...env, ENVIRONMENT: 'prod', AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-bytes' }).get(
      '/api/sign-in-options',
    );
    expect((await res.json<{ github: boolean; codesInTerminal: boolean }>()).codesInTerminal).toBe(false);
  });
});
