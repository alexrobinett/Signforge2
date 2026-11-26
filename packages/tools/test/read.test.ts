// read and describe (#345): one read for every type, through each type's own read tool, so it reads exactly what that
// tool reads, as the caller, in its org, for one count against an agent's limits; and a description of each type.
import { scoped } from '@signforge/db';
import { seedOrg, seedOrganization } from '@signforge/db/testing';
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

  it('keeps what a get adds off the fields of its rows: a row read by id has each listed field as its list has it', async () => {
    const kind = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    for (const type of LISTED.map((l) => l.type)) {
      const def = READ_TYPES[type];
      if (!('get' in def)) continue;
      const [listed] = (await call(as('owner'), 'read', { type, detail: 'full', limit: 1 })).items;
      if (!listed) continue;
      const [byId] = (await call(as('owner'), 'read', { type, ids: [listed.id], detail: 'full' })).items;
      for (const key of Object.keys(listed).filter((k) => k in byId && listed[k] !== null && byId[k] !== null))
        expect(kind(byId[key]), `${type}.${key}`).toBe(kind(listed[key]));
    }
    const [publish] = (await call(as('owner'), 'read', { type: 'publish', ids: [o.publish], detail: 'full' })).items;
    expect(publish.rollout).toEqual(expect.any(Array));
    expect(typeof publish.screens).toBe('number');
  });

  it("reads what each get reads: the newest publish by 'latest', and a spot as screens have it", async () => {
    const latest = await call(as('viewer'), 'get_publish', {});
    const [read] = (await call(as('viewer'), 'read', { type: 'publish', ids: ['latest'], detail: 'full' })).items;
    expect(read).toMatchObject({ id: latest.publish.id, rollout: latest.screens });
    // Its version on screens: published, then drafted again, so the two differ.
    const mine = await seedOrg(env.DB, 'read-tool-published');
    const owner = member(mine.orgId, 'owner');
    await call(owner, 'publish', {});
    await call(owner, 'save_spot', { spotId: mine.imageSpot, durationMs: 9_000 });
    const own = await call(owner, 'get_spot', { spotId: mine.imageSpot, published: true });
    const [onScreens] = (await call(owner, 'read', { type: 'spot', ids: [mine.imageSpot], filter: { published: true }, detail: 'full' })).items;
    expect(onScreens).toEqual(own.spot);
    expect(onScreens.durationMs).not.toBe(9_000);
  });

  it("reads no newest publish for an org that has never published, as get_publish's null", async () => {
    await seedOrganization(env.DB, 'read-tool-unpublished');
    const viewer = member('read-tool-unpublished', 'viewer');
    expect(await call(viewer, 'get_publish', {})).toMatchObject({ publish: null });
    expect(await call(viewer, 'read', { type: 'publish', ids: ['latest'] })).toEqual({ type: 'publish', items: [], next: null });
  });

  it('refuses a filter at the top, a list filter with ids, a field only ids give, and more ids than a call takes', async () => {
    const refused = async (input: Record<string, unknown>) => {
      const r = await dispatch(registry, 'read', input, as('viewer'));
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, error: 'invalid_input' });
      return r.ok ? '' : r.message;
    };
    expect(await refused({ type: 'playlist', isDefault: true })).toMatch(/read takes no isDefault: put a type's filters under filter/);
    expect(await refused({ type: 'spot', ids: [o.imageSpot], filter: { kind: 'url' } })).toMatch(/read by ids has no filter kind: it takes published/);
    expect(await refused({ type: 'screen', fields: ['credentials'] })).toMatch(/listed has no field credentials/);
    expect(await refused({ type: 'screen', ids: Array(5).fill(o.screen) })).toMatch(/at most 4 screen ids a call/);
    expect(await refused({ type: 'spot', ids: [o.imageSpot], limit: 5 })).toMatch(/limit and cursor page a list/);
    expect(await refused({ type: 'spot', ids: [o.imageSpot], cursor: 'x' })).toMatch(/limit and cursor page a list/);
  });

  it("keeps what a type's list says besides its rows: a connection's providers", async () => {
    const own = await call(as('owner'), 'list_connections', {});
    const read = await call(as('owner'), 'read', { type: 'connection', detail: 'full' });
    expect(read.items).toEqual(own.connections);
    expect(read.extra).toEqual({ providers: own.providers });
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
    expect(await refused({ type: 'spot', filter: { colour: 'red' } })).toMatch(/it takes .*unpublished.*describe\(\{ type: 'spot' \}\)/);
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
    const spot = await call(as('editor'), 'describe', { type: 'spot' });
    expect(spot).toMatchObject({ type: 'spot', ids: true, query: false, summary: READ_TYPES.spot.summary });
    expect(Object.keys(spot.filters)).toEqual(['kind', 'unpublished']);
    expect(spot.fields).toHaveProperty('data');
    expect(spot.changedBy).toEqual(expect.arrayContaining(['save_spot', 'save_spot']));
    expect(await call(as('viewer'), 'describe', { type: 'asset' })).toMatchObject({ query: true });
  });

  it('names the tools that change a type, only those the caller may use', async () => {
    const changers = async (role: 'editor' | 'owner', type: string) => (await call(as(role), 'describe', { type })).changedBy;
    expect(await changers('owner', 'screen')).toContain('revoke_screen_credential');
    expect(await changers('editor', 'screen')).not.toContain('revoke_screen_credential');
    expect(await changers('owner', 'screen')).not.toContain('publish_manifest_to_screen');
    expect(await changers('owner', 'member')).toEqual([]);
    expect(await changers('owner', 'publish_request')).toEqual(['request_publish']);
    for (const type of readTypes(registry, { role: 'owner', editorsPublish: true }))
      for (const name of await changers('owner', type)) expect(registry.get(name)?.mutates, `${type}: ${name}`).toBe(true);
  });

  it("keeps each fact a listed description no longer carries in its type's rules (#345's description pass)", async () => {
    const rules = async (type: string) => {
      const r = await dispatch(registry, 'describe', { type }, as('owner'));
      return r.ok ? ((r.output as { rules: string | null }).rules ?? '') : '';
    };
    for (const [type, tool, fact] of [
      ['publish', 'publish', 'set_default_playlist first'],
      ['publish', 'publish', 'before any screen is compiled'],
      ['spot', 'save_spot', 'fallback'],
      ['brand_kit', 'save_brand_kit', 'none from its groups'],
      ['schedule_entry', 'start_takeover', 'network down'],
      ['schedule_entry', 'save_schedule_entry', 'end of the spot on screen'],
      ['publish', 'publish', 'cannot compile keeps what it plays'],
      ['asset', 'start_upload', 'smallest that covers its screen box'],
    ] as const) {
      expect(await rules(type), `${type}: ${fact}`).toContain(fact);
      // The tool as it is listed: its description and its input's field descriptions.
      const listed = JSON.stringify(describeTools(registry, { role: 'owner', editorsPublish: true }).find((t) => t.name === tool));
      expect(listed, `${tool}: ${fact}`).not.toContain(fact);
      expect(listed, tool).toContain(`describe(${type})`);
    }
  });

  it("describes a type's times as an agent reads them, ISO 8601 (#345)", async () => {
    const r = await dispatch(registry, 'describe', { type: 'spot' }, as('owner'));
    if (!r.ok) throw new Error(JSON.stringify(r));
    const { fields } = r.output as { fields: Record<string, { type?: unknown; format?: string }> };
    expect(fields.createdAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(fields.publishedAt).toMatchObject({ type: ['string', 'null'], format: 'date-time' });
    expect(fields.durationMs).toMatchObject({ type: 'number' });
    // As read gives them (review of #538): an org's settings' time, and an audit entry's, its description too.
    const fieldsOf = async (type: string) => {
      const d = await dispatch(registry, 'describe', { type }, as('owner'));
      if (!d.ok) throw new Error(JSON.stringify(d));
      return (d.output as { fields: Record<string, { type?: unknown; format?: string; description?: string; properties?: Record<string, unknown> }> }).fields;
    };
    expect((await fieldsOf('org')).settings?.properties?.updatedAt).toMatchObject({ format: 'date-time' });
    const at = (await fieldsOf('audit_entry')).at;
    expect(at).toMatchObject({ type: 'string', format: 'date-time' });
    expect(at?.description).not.toContain('ms');
  });

  it('describes every type a caller may read, its tools all in the registry', async () => {
    for (const type of TYPES) {
      for (const name of toolsOf(type)) expect(registry.get(name), `${type}: ${name}`).toBeDefined();
      if (!readTypes(registry, { role: 'owner', editorsPublish: true }).includes(type)) continue;
      expect(await dispatch(registry, 'describe', { type }, as('owner')), type).toMatchObject({ ok: true });
    }
  });

  it("gives a type's rules, the reference text no tool's description carries (#345): rollout states, which entry wins, the video spec", async () => {
    const rules = async (type: string) => {
      const r = await dispatch(registry, 'describe', { type }, as('owner'));
      return r.ok ? (r.output as { rules: string | null }).rules : undefined;
    };
    expect(await rules('publish')).toContain('fell_back');
    expect(await rules('schedule_entry')).toContain('the highest priority wins');
    expect(await rules('asset')).toContain('H.264');
    expect(await rules('screen')).toBeNull();
    for (const [name, text] of [
      ['get_publish', 'fell_back'],
      ['save_schedule_entry', 'highest priority'],
      ['start_takeover', 'starts later'],
      ['start_upload', 'H.264'],
    ] as const)
      expect(registry.get(name)?.description, name).not.toContain(text);
  });
});
