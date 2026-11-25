// read and describe (#345): one read for every type, through each type's own read tool, so it reads exactly what that
// tool reads, as the caller, in its org, for one count against an agent's limits; and a description of each type.
import { scoped } from '@signforge/db';
import { seedOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { describeTools, dispatch, READ_TYPES, type ReadType, readTypes, registry, toolsOf } from '../src';
import { call } from './calls';
import { member, seededMembers } from './member';

const { o, as } = seededMembers('read-tool');

const TYPES = Object.keys(READ_TYPES).filter((t): t is ReadType => t in READ_TYPES);
/** Types whose own list the owner reads with no service the tests lack, each with its rows' key. */
const LISTED = TYPES.flatMap((type) => {
  const def = READ_TYPES[type];
  return 'list' in def && type !== 'connection' ? [{ type, ...def.list }] : [];
});

describe('read', () => {
  it.for(LISTED.map((l) => [l.type, l] as const))('%s: the rows its own list gives, in its order, a page at a time', async ([type, l]) => {
    const own = await call(as('owner'), l.tool, { limit: 2 });
    const read = await call(as('owner'), 'read', { type, limit: 2, detail: 'full' });
    expect(read.items).toEqual(own[l.items]);
    expect(read.next).toBe(own.next ?? null);
  });

  it('reads by ids, each in full as its get tool gives it, with what the get adds', async () => {
    const screen = await call(as('viewer'), 'get_screen', { screenId: o.screen });
    const [full] = (await call(as('viewer'), 'read', { type: 'screen', ids: [o.screen], detail: 'full' })).items;
    const { screen: row, ...extras } = screen;
    expect(full).toEqual({ ...row, ...extras });
    expect(full).toHaveProperty('credentials');
    const spots = await call(as('viewer'), 'read', { type: 'spot', ids: [o.imageSpot, o.templateSpot] });
    expect(spots.items.map((s: { id: string }) => s.id)).toEqual([o.imageSpot, o.templateSpot]);
  });

  it('summarizes by default with the fields its type keeps, and picks fields when asked', async () => {
    const [screen] = (await call(as('viewer'), 'read', { type: 'screen' })).items;
    expect(Object.keys(screen).every((k) => (READ_TYPES.screen.summary as readonly string[]).includes(k))).toBe(true);
    expect(screen).toMatchObject({ id: o.screen, name: expect.any(String), state: { kind: expect.any(String) } });
    const [picked] = (await call(as('viewer'), 'read', { type: 'screen', fields: ['name'] })).items;
    expect(picked).toEqual({ name: screen.name });
    const [template] = (await call(as('viewer'), 'read', { type: 'template' })).items;
    expect(Object.keys(template)).toEqual(['id', 'key', 'name', 'latestApproved']);
  });

  it('reads the org: who is asking, its settings and AI provider', async () => {
    const [org] = (await call(as('editor'), 'read', { type: 'org' })).items;
    expect(org).toMatchObject({ id: o.orgId, name: expect.any(String), role: 'editor', scopes: expect.arrayContaining(['content:read', 'content:draft']) });
    expect(org).toHaveProperty('settings');
    expect(org).toHaveProperty('aiProvider');
  });

  it('refuses a wrong filter, field, query or ids with what to send instead', async () => {
    const refused = async (input: Record<string, unknown>) => {
      const r = await dispatch(registry, 'read', input, as('viewer'));
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, error: 'invalid_input' });
      return r.ok ? '' : r.message;
    };
    expect(await refused({ type: 'spot', filter: { colour: 'red' } })).toMatch(/its filters are .*unpublished.*describe\(\{ type: 'spot' \}\)/);
    expect(await refused({ type: 'spot', fields: ['colour'] })).toMatch(/its fields are .*durationMs/);
    expect(await refused({ type: 'spot', query: 'menu' })).toMatch(/asset and audit_entry can/);
    expect(await refused({ type: 'schedule_entry', ids: ['x'] })).toMatch(/list it, with a filter/);
    expect(await refused({ type: 'spot', filter: { kind: 'poster' } })).toMatch(/describe/);
  });

  it("refuses a type the caller's role may not read, and lists only those it may", async () => {
    expect(await dispatch(registry, 'read', { type: 'invitation' }, as('editor'))).toMatchObject({ ok: false, error: 'forbidden' });
    const listed = (role: 'viewer' | 'owner') => {
      const read = describeTools(registry, { role, editorsPublish: true }).find((t) => t.name === 'read');
      return JSON.stringify(read?.inputSchema);
    };
    expect(listed('viewer')).not.toContain('"invitation"');
    expect(listed('owner')).toContain('"invitation"');
    expect(readTypes(registry, { role: 'viewer', editorsPublish: true })).not.toContain('invitation');
  });

  it("finds nothing of another org's, by ids", async () => {
    const other = await seedOrg(env.DB, 'read-tool-other');
    const there = member(other.orgId, 'owner');
    expect(await dispatch(registry, 'read', { type: 'spot', ids: [o.imageSpot] }, there)).toMatchObject({ ok: false, error: 'not_found' });
    expect(await dispatch(registry, 'read', { type: 'screen', ids: [o.screen] }, there)).toMatchObject({ ok: false, error: 'not_found' });
  });

  it("counts once against an agent's limits, however many ids it reads", async () => {
    const taken: string[] = [];
    const agent = {
      ...as('owner'),
      org: scoped(env.DB, o.orgId),
      actor: { kind: 'agent' as const, id: 'grant-read', clientId: 'client-read' },
      agentLimiter: {
        take: async (grantId: string) => {
          taken.push(grantId);
          return { ok: true as const };
        },
        audited: async () => {},
      },
    };
    expect(await dispatch(registry, 'read', { type: 'spot', ids: [o.imageSpot, o.templateSpot] }, agent)).toMatchObject({ ok: true });
    expect(taken).toEqual(['grant-read']);
  });
});

describe('describe', () => {
  it('says what read gives for a type: filters, ids, query, summary and every field, and the tools that change it', async () => {
    const spot = await call(as('viewer'), 'describe', { type: 'spot' });
    expect(spot).toMatchObject({ type: 'spot', ids: true, query: false, summary: READ_TYPES.spot.summary });
    expect(Object.keys(spot.filters)).toEqual(['kind', 'unpublished']);
    expect(spot.fields).toHaveProperty('data');
    expect(spot.changedBy).toEqual(expect.arrayContaining(['create_spot', 'update_spot']));
    expect(await call(as('viewer'), 'describe', { type: 'asset' })).toMatchObject({ query: true });
  });

  it('describes every type a caller may read, its tools all in the registry', async () => {
    for (const type of TYPES) {
      for (const name of toolsOf(type)) expect(registry.get(name), `${type}: ${name}`).toBeDefined();
      if (!readTypes(registry, { role: 'owner', editorsPublish: true }).includes(type)) continue;
      expect(await dispatch(registry, 'describe', { type }, as('owner')), type).toMatchObject({ ok: true });
    }
  });
});
