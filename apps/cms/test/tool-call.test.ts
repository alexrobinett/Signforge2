// A tool call from a server function, through the API binding (faked here): its refusal keeps the
// code it was refused with, as the browser's does, and keeps it on the way to the browser.
import type { ToolOutput } from '@signforge/tools/outputs';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { inOrg, tool } from '~/server/tools.server';
import { isOrgChanged, isStale, Refusal, refusalAdapter } from '~/lib/tools';

const api = vi.hoisted(() => ({ answer: new Response() }));
vi.mock('cloudflare:workers', () => ({ env: { API: { fetch: async () => api.answer } } }));
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => new Request('https://cms.test/spots/spt_1'), appendResponseHeader: () => {} }));

const refused = (status: number, body: unknown) => {
  api.answer = Response.json(body, { status });
};

const caught = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable('the call was answered'),
    (err: unknown) => err,
  );

describe('a tool called from a server function', () => {
  beforeEach(() => refused(500, {}));

  it('answers with the tool’s output', async () => {
    api.answer = Response.json({ spot: { id: 'spt_1', version: 3 } });
    expect((await tool('get_spot', { spotId: 'spt_1' })).spot.version).toBe(3);
  });

  it('throws a stale refusal with its code and details, so a loader can tell it is stale', async () => {
    refused(409, { error: 'conflict', message: 'spot spt_1 has changed', details: { id: 'spt_1', version: 4 } });
    const err = await caught(tool('update_spot', { spotId: 'spt_1', ifVersion: 3 }));
    expect(err).toBeInstanceOf(Refusal);
    expect(err).toMatchObject({ code: 'conflict', message: 'spot spt_1 has changed', details: { id: 'spt_1', version: 4 } });
    expect(isStale(err)).toBe(true);
  });

  it('throws a gone row as not_found, with the tool’s words', async () => {
    refused(404, { error: 'not_found', message: 'spot spt_1 not found' });
    expect(await caught(tool('get_spot', { spotId: 'spt_1' }))).toMatchObject({ code: 'not_found', message: 'spot spt_1 not found' });
  });

  it('throws the refusal of a tab left on another org as org_changed', async () => {
    refused(409, { error: 'org_changed', message: 'This tab is on Northside; you switched to Southside in another tab. Reload.' });
    expect(isOrgChanged(await caught(tool('list_spots', {})))).toBe(true);
  });

  it('gives a loader its empty result while there is no active org', async () => {
    refused(403, { error: 'no_active_organization', message: 'no active organization' });
    expect(await inOrg(() => tool('list_spots', {}), null)).toBeNull();
  });

  it('words an answer with no refusal in it by the tool and the status', async () => {
    api.answer = new Response('<html>Bad gateway</html>', { status: 502 });
    expect(await caught(tool('list_spots', {}))).toMatchObject({ code: 'error', message: 'list_spots failed: 502' });
  });
});

describe('a server function’s refusal, on its way to the browser', () => {
  it('keeps its code, words and details', () => {
    const sent = new Refusal('conflict', 'spot spt_1 has changed', { id: 'spt_1', version: 4 });
    const got = refusalAdapter.fromSerializable(refusalAdapter.toSerializable(sent));
    expect(got).toBeInstanceOf(Refusal);
    expect(got).toMatchObject({ code: 'conflict', message: 'spot spt_1 has changed', details: { id: 'spt_1', version: 4 } });
  });
});

describe('a tool’s output', () => {
  it('is typed by the tool’s own output schema, so reading what it does not return fails the typecheck', () => {
    expectTypeOf<ToolOutput<'update_spot'>>().toHaveProperty('spot');
    expectTypeOf<ToolOutput<'update_spot'>>().not.toHaveProperty('playlist');
    expectTypeOf<ToolOutput<'update_spot'>['spot']['kind']>().toEqualTypeOf<'template' | 'image' | 'video' | 'url'>();
    expectTypeOf<ToolOutput<'list_audit_log'>['next']>().toEqualTypeOf<string | null>();
  });
});
