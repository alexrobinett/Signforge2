// `GET /api/blobs/:sha256`: the files a signed-in user's org can see, for the editor preview
// (M3-36). Org A's session never reaches org B's prefix, whatever hash it asks for.
import { seedBaseTemplate } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { FONTS } from '@signforge/compiler';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseBlobKey, orgBlobKey } from '../src/r2';
import { Client, email, testApp } from './client';

const t = testApp();
const alice = new Client(t);
const bob = new Client(t);
const sha = (c: string) => c.repeat(64);
const A_FILE = sha('1');
const B_FILE = sha('2');
const A_SVG = sha('4');
/** seedBaseTemplate's clock bundle. */
const BASE_HTML = sha('e');
/** Under the shared prefix but no base template's bundle. */
const STRAY = sha('3');
/** A catalogue brand font. */
const FONT = FONTS[0]!.files[0]!.file;

beforeAll(async () => {
  await alice.signIn(email('alice'));
  await bob.signIn(email('bob'));
  const orgA = (await alice.createOrg('Blobs A')).id;
  const orgB = (await bob.createOrg('Blobs B')).id;
  await seedBaseTemplate(env.DB);
  await env.BLOBS.put(orgBlobKey(orgA, A_FILE), 'org a file', { httpMetadata: { contentType: 'image/png' } });
  await env.BLOBS.put(orgBlobKey(orgA, A_SVG), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
    httpMetadata: { contentType: 'image/svg+xml' },
  });
  await env.BLOBS.put(orgBlobKey(orgB, B_FILE), 'org b secret', { httpMetadata: { contentType: 'image/png' } });
  await env.BLOBS.put(baseBlobKey(BASE_HTML), '<!doctype html>', { httpMetadata: { contentType: 'text/html' } });
  await env.BLOBS.put(baseBlobKey(STRAY), 'not a template');
  await env.BLOBS.put(baseBlobKey(FONT), 'wOF2 font', { httpMetadata: { contentType: 'font/woff2' } });
});

describe('GET /api/blobs/:sha256', () => {
  it("serves the org's own file, private to the browser", async () => {
    const res = await alice.get(`/api/blobs/${A_FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(await res.text()).toBe('org a file');
  });

  it("is a 404 for another org's file, which that org can fetch", async () => {
    const res = await alice.get(`/api/blobs/${B_FILE}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'file not found' });
    expect(await (await bob.get(`/api/blobs/${B_FILE}`)).text()).toBe('org b secret');
    expect((await bob.get(`/api/blobs/${A_FILE}`)).status).toBe(404);
  });

  it("serves a base template's HTML to every org, and nothing else under the shared prefix", async () => {
    expect(await (await alice.get(`/api/blobs/${BASE_HTML}`)).text()).toBe('<!doctype html>');
    expect(await (await bob.get(`/api/blobs/${BASE_HTML}`)).text()).toBe('<!doctype html>');
    expect((await alice.get(`/api/blobs/${STRAY}`)).status).toBe(404);
  });

  it('never lets a file run as a page on the CMS origin', async () => {
    const html = await alice.get(`/api/blobs/${BASE_HTML}`);
    expect(html.headers.get('content-type')).toBe('text/html');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(html.headers.get('content-disposition')).toBe('attachment');
    const svg = await alice.get(`/api/blobs/${A_SVG}`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(svg.headers.get('content-disposition')).toBe('attachment');
    const png = await alice.get(`/api/blobs/${A_FILE}`);
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(png.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect(png.headers.get('content-disposition')).toBeNull();
  });

  it('serves a catalogue brand font to every org', async () => {
    expect(await (await alice.get(`/api/blobs/${FONT}`)).text()).toBe('wOF2 font');
    expect(await (await bob.get(`/api/blobs/${FONT}`)).text()).toBe('wOF2 font');
  });

  it('refuses a request without a session, and a malformed hash', async () => {
    expect((await new Client(t).get(`/api/blobs/${A_FILE}`)).status).toBe(401);
    expect((await alice.get('/api/blobs/not-a-hash')).status).toBe(404);
  });
});
