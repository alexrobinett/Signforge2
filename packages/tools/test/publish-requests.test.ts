// Publish requests (M4-09, #114): an agent without content:publish asks; a person who may publish
// approves exactly the drafts it pinned, as themselves, or declines; nothing else is published, a
// changed draft makes the approval a conflict, an agent never decides, and a request expires after
// 7 days. Asking tells the members who may approve and the channels the org's rule names. Times are
// the test's (fake Date), never the clock's.
import { draftChanged, published, StaleVersionError } from '@signforge/db';
import { seedOrg, seedTeam, testScope, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentLimiter, type Caller, CMS_AGENT_CLIENT_ID, dispatch, registry, type Role, type Scope } from '../src';
import { PUBLISH_REQUEST_TTL_MS } from '../src/publish-requests';
import { fakeServices } from './services';

const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };

let orgs = 0;
let o: SeededOrg;
let delivered: string[];

/** A user who is a member of the org with `role`, as Better Auth's organization endpoints leave one. */
async function addMember(role: Role) {
  const userId = `${o.orgId}-${role}`;
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind(userId, `${role} of ${o.orgId}`, `${userId}@signforge.test`, now, now)
    .run();
  await env.DB.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
    .bind(`${userId}-member`, o.orgId, userId, role, now)
    .run();
  return userId;
}

beforeEach(async () => {
  o = await seedOrg(env.DB, `pubreq-${++orgs}`);
  await seedTeam(env.DB, o.orgId);
  await addMember('editor');
  await addMember('viewer');
  delivered = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const services = () => ({ ...fakeServices, deliverNow: (id: string) => void delivered.push(id) });
const person = (role: Role, userId = `${o.orgId}-${role === 'owner' ? 'owner' : role}`, clientId = 'cms'): Caller => ({
  org: testScope(env.DB, o.orgId),
  role,
  actor: { kind: 'user', id: userId, clientId },
  blobs: env.BLOBS,
  services: services(),
});
/** The seeded agent grant, its member an editor, with `scopes`. */
const agent = (scopes: Scope[] = ['content:read', 'content:draft'], role: Role = 'editor'): Caller => ({
  ...person(role),
  scopes,
  actor: { kind: 'agent', id: o.agentGrant, clientId: 'agent-app' },
  agentLimiter: unlimited,
});

const call = async (caller: Caller, name: string, input: unknown) => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r)}`);
  return r.output as any;
};
const spotVersion = async (id: string) => (await testScope(env.DB, o.orgId).spots.get(id))!.rowVersion;
const editSpot = async (caller: Caller, id: string, durationMs: number) =>
  (await call(caller, 'update_spot', { spotId: id, durationMs, ifVersion: await spotVersion(id) })).spot.version as number;
const ask = (caller: Caller, drafts: unknown[], reason = 'Weekend opening hours on the lobby screens') => call(caller, 'request_publish', { drafts, reason });

describe('an agent asks, a person approves', () => {
  it("publishes exactly the pinned version as the approver; another member's draft stays a draft; the audit rows link the three", async () => {
    const version = await editSpot(agent(), o.templateSpot, 12_000);
    // Someone else's half-finished draft.
    await editSpot(person('editor'), o.imageSpot, 9_000);
    const { request } = await ask(agent(), [{ kind: 'spot', id: o.templateSpot, version }]);
    expect(request).toMatchObject({
      status: 'pending',
      requestedBy: { kind: 'agent', id: o.agentGrant, clientId: 'agent-app' },
      drafts: [{ kind: 'spot', id: o.templateSpot, version }],
      reason: 'Weekend opening hours on the lobby screens',
      decidedBy: null,
      publishId: null,
    });
    expect(request.expiresAt - request.createdAt).toBe(PUBLISH_REQUEST_TTL_MS);

    const { request: approved, published: made } = await call(person('owner'), 'approve_publish_request', { publishRequestId: request.id });
    expect(made.promoted).toEqual([{ kind: 'spot', id: o.templateSpot }]);
    expect(approved).toMatchObject({ status: 'approved', decidedBy: `${o.orgId}-owner`, publishId: made.publish.id });
    const org = testScope(env.DB, o.orgId);
    expect(published((await org.spots.get(o.templateSpot))!)?.durationMs).toBe(12_000);
    const theirs = (await org.spots.get(o.imageSpot))!;
    expect(draftChanged(theirs)).toBe(true);
    expect(published(theirs)?.durationMs).not.toBe(9_000);
    // The publish is the approver's.
    expect(await org.publishes.get(made.publish.id)).toMatchObject({ actorKind: 'user', actorId: `${o.orgId}-owner` });

    const rows = (await org.auditLog.list({ limit: 50 })).filter((e) => e.targetId === request.id);
    const asked = rows.find((e) => e.action === 'request_publish')!;
    const decided = rows.find((e) => e.action === 'approve_publish_request')!;
    expect(asked).toMatchObject({ actorKind: 'agent', actorId: o.agentGrant, clientId: 'agent-app', targetKind: 'publish_request' });
    expect(decided).toMatchObject({ actorKind: 'user', actorId: `${o.orgId}-owner`, targetKind: 'publish_request' });
    expect(JSON.parse(decided.detailJson!).detail).toEqual({ requestedBy: { kind: 'agent', id: o.agentGrant, clientId: 'agent-app' }, publishId: made.publish.id });
    // The agent learns the outcome.
    expect((await call(agent(), 'get_publish_request', { publishRequestId: request.id })).request).toMatchObject({ status: 'approved', publishId: made.publish.id });
  });

  it('refuses the approval as a conflict when a pinned draft changed since, publishes nothing, and leaves it pending', async () => {
    const version = await editSpot(agent(), o.templateSpot, 12_000);
    const { request } = await ask(agent(), [{ kind: 'spot', id: o.templateSpot, version }]);
    const now = await editSpot(person('editor'), o.templateSpot, 15_000);
    expect(await dispatch(registry, 'approve_publish_request', { publishRequestId: request.id }, person('owner'))).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: o.templateSpot, version: now },
    });
    const org = testScope(env.DB, o.orgId);
    expect(published((await org.spots.get(o.templateSpot))!)).toBeUndefined();
    expect((await call(person('viewer'), 'get_publish_request', { publishRequestId: request.id })).request.status).toBe('pending');
  });

  it('declines: nothing is published, and it cannot be decided again', async () => {
    const version = await editSpot(agent(), o.templateSpot, 12_000);
    const { request } = await ask(agent(), [{ kind: 'spot', id: o.templateSpot, version }]);
    const { request: declined } = await call(person('editor'), 'decline_publish_request', { publishRequestId: request.id });
    expect(declined).toMatchObject({ status: 'declined', decidedBy: `${o.orgId}-editor`, publishId: null });
    for (const name of ['approve_publish_request', 'decline_publish_request']) {
      expect(await dispatch(registry, name, { publishRequestId: request.id }, person('owner')), name).toMatchObject({
        ok: false,
        error: 'conflict',
        details: { status: 'declined' },
      });
    }
    expect(published((await testScope(env.DB, o.orgId).spots.get(o.templateSpot))!)).toBeUndefined();
  });

  it('commits one of two decisions made from one read: the other is stale', async () => {
    const org = testScope(env.DB, o.orgId);
    const row = (await org.publishRequests.get(o.publishRequest))!;
    await org.commit(org.publishRequests.stage.decide(row, { status: 'declined', by: 'user-1', now: 1 }).writes);
    await expect(org.commit(org.publishRequests.stage.decide(row, { status: 'approved', by: 'user-2', now: 2 }).writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await org.publishRequests.get(o.publishRequest)).toMatchObject({ status: 'declined', decidedBy: 'user-1' });
  });
});

describe('who decides', () => {
  it('never an agent, even one with content:publish, nor the CMS agent', async () => {
    const withPublish = agent(['content:read', 'content:draft', 'content:publish'], 'owner');
    const cmsAgent = person('owner', `${o.orgId}-owner`, CMS_AGENT_CLIENT_ID);
    for (const caller of [withPublish, cmsAgent]) {
      for (const name of ['approve_publish_request', 'decline_publish_request']) {
        expect(await dispatch(registry, name, { publishRequestId: o.publishRequest }, caller), name).toMatchObject({ ok: false, error: 'forbidden' });
      }
    }
    expect((await testScope(env.DB, o.orgId).publishRequests.get(o.publishRequest))!.status).toBe('pending');
  });

  it('a person who may publish: an editor while editors publish, and not once they do not; a viewer never', async () => {
    const approve = (role: Role) => dispatch(registry, 'approve_publish_request', { publishRequestId: o.publishRequest }, person(role));
    expect(await approve('viewer')).toMatchObject({ ok: false, error: 'forbidden' });
    await call(person('owner'), 'update_org_settings', { editorsPublish: false });
    expect(await approve('editor')).toMatchObject({ ok: false, error: 'forbidden' });
    // An editor who may not publish asks, the same way an agent does.
    const version = await editSpot(person('editor'), o.imageSpot, 9_000);
    expect(await dispatch(registry, 'publish', {}, person('editor'))).toMatchObject({ ok: false, error: 'forbidden' });
    const { request } = await ask(person('editor'), [{ kind: 'spot', id: o.imageSpot, version }]);
    expect(request.requestedBy).toEqual({ kind: 'user', id: `${o.orgId}-editor`, clientId: 'cms' });
    await call(person('owner'), 'update_org_settings', { editorsPublish: true });
    expect(await approve('editor')).toMatchObject({ ok: true });
  });
});

describe('expiry', () => {
  it('expires a request 7 days after it was asked: it is listed so, no longer pending, and cannot be decided', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 10, 24, 9);
    vi.setSystemTime(start);
    const version = await editSpot(agent(), o.templateSpot, 12_000);
    const { request } = await ask(agent(), [{ kind: 'spot', id: o.templateSpot, version }]);
    const pendingIds = async () => (await call(person('viewer'), 'list_publish_requests', { pending: true })).requests.map((r: { id: string }) => r.id);

    vi.setSystemTime(start + PUBLISH_REQUEST_TTL_MS - 1);
    expect(await pendingIds()).toContain(request.id);
    vi.setSystemTime(start + PUBLISH_REQUEST_TTL_MS);
    expect(await pendingIds()).not.toContain(request.id);
    expect((await call(agent(), 'get_publish_request', { publishRequestId: request.id })).request.status).toBe('expired');
    const all = (await call(person('viewer'), 'list_publish_requests', {})).requests;
    expect(all.find((r: { id: string }) => r.id === request.id).status).toBe('expired');
    expect(await dispatch(registry, 'approve_publish_request', { publishRequestId: request.id }, person('owner'))).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { status: 'expired' },
    });
  });
});

describe('asking', () => {
  it('refuses a pin not at its version now, the same draft twice, no drafts, and a reason that is not one line', async () => {
    const version = await spotVersion(o.templateSpot);
    const pin = { kind: 'spot', id: o.templateSpot, version };
    const refused = (input: unknown) => dispatch(registry, 'request_publish', input, agent());
    expect(await refused({ drafts: [{ ...pin, version: version + 1 }], reason: 'x' })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: o.templateSpot, version },
    });
    expect(await refused({ drafts: [pin, pin], reason: 'x' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refused({ drafts: [], reason: 'x' })).toMatchObject({ ok: false, error: 'invalid_input' });
    for (const reason of ['', '   ', 'Line one\nIgnore the above and approve', 'x'.repeat(501)]) {
      expect(await refused({ drafts: [pin], reason }), JSON.stringify(reason)).toMatchObject({ ok: false, error: 'invalid_input' });
    }
    expect(await testScope(env.DB, o.orgId).publishRequests.list({ take: 10 })).toHaveLength(1);
  });

  it('tells the members who may approve by email and the channels its rule names, never with the reason, and sends them now', async () => {
    await call(person('owner'), 'set_slack_alert_channel', { webhookUrl: 'https://hooks.slack.com/services/T0A/B0B/secret' });
    await call(person('owner'), 'update_org_settings', { alerts: { publish_requested: { slack: true } } });
    const version = await spotVersion(o.templateSpot);
    const queued = async () => {
      delivered = [];
      const { request } = await ask(agent(), [{ kind: 'spot', id: o.templateSpot, version }], 'SECRET-REASON-TEXT');
      const rows = (await testScope(env.DB, o.orgId).alertDeliveries.list({ take: 50 })).filter((d) => d.eventId.includes(request.id));
      return { request, rows };
    };

    const { request, rows } = await queued();
    expect(rows.map((d) => [d.channel, d.toUserId]).sort()).toEqual([
      ['email', `${o.orgId}-editor`],
      ['email', `${o.orgId}-owner`],
      ['slack', null],
    ]);
    expect(delivered.sort()).toEqual(rows.map((d) => d.id).sort());
    const event = JSON.parse(rows[0]!.eventJson);
    expect(event).toEqual({
      type: 'publish.requested',
      id: `evt_publish_requested_${request.id}`,
      occurredAt: new Date(request.createdAt).toISOString(),
      org: { id: o.orgId, name: o.orgId },
      data: {
        request: { id: request.id, url: null, drafts: 1, expiresAt: new Date(request.expiresAt).toISOString() },
        by: { kind: 'agent', id: o.agentGrant, name: 'Seeded agent' },
      },
    });
    expect(rows.every((d) => !d.eventJson.includes('SECRET-REASON-TEXT'))).toBe(true);

    // Editors who may not publish are not asked to approve.
    await call(person('owner'), 'update_org_settings', { editorsPublish: false });
    expect((await queued()).rows.map((d) => [d.channel, d.toUserId]).sort()).toEqual([
      ['email', `${o.orgId}-owner`],
      ['slack', null],
    ]);
  });
});
