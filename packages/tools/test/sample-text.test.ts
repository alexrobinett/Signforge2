// Sample text on the server (#360): a spot New spot starts with its template's sample copy records
// those fields; a saved edit takes a field out; a publish, or a publish request's approval, that
// would put a spot with any live is refused (sample_text) unless a person allows it, and an agent
// cannot allow it. Spots made before, or another way, have none.
import { published } from '@signforge/db';
import { seedOrg, seedTeam, testScope, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AgentLimiter, type Caller, dispatch, registry, type Role, type Scope } from '../src';
import { fakeServices } from './services';

let orgs = 0;
let o: SeededOrg;

beforeEach(async () => {
  o = await seedOrg(env.DB, `sample-${++orgs}`);
  await seedTeam(env.DB, o.orgId);
});

const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
const person = (role: Role = 'owner'): Caller => ({
  org: testScope(env.DB, o.orgId),
  role,
  actor: { kind: 'user', id: `${o.orgId}-owner`, clientId: 'cms' },
  blobs: env.BLOBS,
  services: fakeServices,
});
const agent = (scopes: Scope[]): Caller => ({
  ...person('editor'),
  scopes,
  actor: { kind: 'agent', id: o.agentGrant, clientId: 'agent-app' },
  agentLimiter: unlimited,
});
const call = async (caller: Caller, name: string, input: unknown) => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r)}`);
  return r.output as any;
};

/** A spot New spot would make: started with its template's sample copy. The seeded template's one text has no default: its label stands in. */
async function sampleSpot() {
  const templateVersionId = (await testScope(env.DB, o.orgId).spots.get(o.templateSpot))?.templateVersionId;
  return (await call(person(), 'create_spot', { name: 'Fresh', kind: 'template', templateVersionId, sample: true })).spot;
}
const pin = (spot: { id: string; version: number }) => ({ drafts: [{ kind: 'spot', id: spot.id, version: spot.version }] });

describe('sample text on the server', () => {
  it('records what New spot started with; spots made another way have none', async () => {
    const spot = await sampleSpot();
    expect(spot).toMatchObject({ data: { title: 'Title' }, sampleFields: { texts: ['title'], lists: {} } });
    expect((await call(person(), 'get_spot', { spotId: o.templateSpot })).spot.sampleFields).toBeNull();
    expect(
      await dispatch(registry, 'create_spot', { name: 'x', kind: 'template', templateVersionId: spot.templateVersionId, sample: true, data: {} }, person()),
    ).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('refuses a publish that would put it live, naming the spot and its fields, and writes nothing', async () => {
    const spot = await sampleSpot();
    expect(await dispatch(registry, 'publish', pin(spot), person())).toMatchObject({
      ok: false,
      error: 'sample_text',
      details: { spots: [{ id: spot.id, name: 'Fresh', fields: ['title'] }] },
    });
    // Every changed draft, as ⌘K's publish with no drafts sends it: refused the same way.
    expect(await dispatch(registry, 'publish', {}, person())).toMatchObject({ ok: false, error: 'sample_text' });
    expect(published((await testScope(env.DB, o.orgId).spots.get(spot.id))!)).toBeUndefined();
  });

  it('publishes it when a person allows it; an agent may not, even with the right to publish', async () => {
    const spot = await sampleSpot();
    expect(await dispatch(registry, 'publish', { ...pin(spot), allowSample: true }, agent(['content:read', 'content:publish']))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    const made = await call(person(), 'publish', { ...pin(spot), allowSample: true });
    expect(made.promoted).toContainEqual({ kind: 'spot', id: spot.id });
  });

  it('lets a field go once a saved edit changes it, and then publishes without asking', async () => {
    const spot = await sampleSpot();
    const same = (await call(person(), 'update_spot', { spotId: spot.id, data: { title: 'Title' }, ifVersion: spot.version })).spot;
    expect(same.sampleFields).toEqual({ texts: ['title'], lists: {} });
    const edited = (await call(person(), 'update_spot', { spotId: spot.id, data: { title: 'Fresh picked' }, ifVersion: same.version })).spot;
    expect(edited.sampleFields).toBeNull();
    expect((await call(person(), 'publish', pin(edited))).promoted).toContainEqual({ kind: 'spot', id: spot.id });
  });

  it('refuses an approval the same way, unless the approving person allows it', async () => {
    const spot = await sampleSpot();
    const { request } = await call(agent(['content:read', 'content:draft']), 'request_publish', { ...pin(spot), reason: 'The new menu' });
    expect(await dispatch(registry, 'approve_publish_request', { publishRequestId: request.id }, person())).toMatchObject({
      ok: false,
      error: 'sample_text',
      details: { spots: [{ id: spot.id, fields: ['title'] }] },
    });
    const { request: approved } = await call(person(), 'approve_publish_request', { publishRequestId: request.id, allowSample: true });
    expect(approved.status).toBe('approved');
  });
});
