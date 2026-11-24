// Publish requests through the API (M4-09, #114): an agent connected over OAuth with content:draft
// edits a spot over /mcp and asks to publish it; an owner approves in the CMS's API, and exactly the
// pinned version goes live, as the owner, while another member's draft stays a draft. Editing the
// draft after the request makes the approval a conflict. An agent never decides, even with
// content:publish; with it, granted by someone who may publish, it publishes without asking, capped
// on every call by that member's role and the editors-publish setting (owner decision on Q7). And
// each path's cost: D1 statements and Durable Object requests.
import { draftChanged, published, scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Client } from './client';
import { agentToken, check, mcpTool, team } from './oauth';

type Team = Awaited<ReturnType<typeof team>>;

/** A URL spot made in the CMS by `by`: a draft, never published. */
async function urlSpot(by: Client, name: string) {
  const { spot } = await by.ok<{ spot: { id: string; version: number } }>('/api/tools/create_spot', { name, kind: 'url', url: `https://example.com/${name}` });
  return spot;
}

/** An agent of the editor's with content:draft, and the owner's spot it edits over /mcp: the version it asks to publish. */
async function agentEdited(t: Team) {
  const { access_token } = await agentToken(t.t, t.editor, t.org.id, ['content:read', 'content:draft']);
  const spot = await urlSpot(t.owner, 'menu');
  const edited = await mcpTool(access_token, 'update_spot', { spotId: spot.id, durationMs: 12_000, ifVersion: spot.version });
  expect(edited.isError, JSON.stringify(edited)).toBeUndefined();
  return { token: access_token, spotId: spot.id, version: edited.structuredContent.spot.version as number };
}

const ask = (token: string, spotId: string, version: number) =>
  mcpTool(token, 'request_publish', { drafts: [{ kind: 'spot', id: spotId, version }], reason: 'Weekend opening hours on the lobby screens' });

describe('an agent asks over /mcp, a person approves', () => {
  it("publishes exactly the pinned version as the owner, leaves another member's draft a draft, and links the audit rows", async () => {
    const t = await team();
    const { token, spotId, version } = await agentEdited(t);
    const { grantId } = (await check(token))!;
    const theirs = await urlSpot(t.editor, 'half-done');
    const asked = await ask(token, spotId, version);
    expect(asked.isError, JSON.stringify(asked)).toBeUndefined();
    const requestId: string = asked.structuredContent.request.id;
    expect(asked.structuredContent.request).toMatchObject({ status: 'pending', requestedBy: { kind: 'agent', id: grantId } });

    const { request, published: made } = await t.owner.ok<{
      request: { status: string; publishId: string };
      published: { promoted: unknown[]; publish: { id: string } };
    }>('/api/tools/approve_publish_request', { publishRequestId: requestId });
    expect(made.promoted).toEqual([{ kind: 'spot', id: spotId }]);
    expect(request).toMatchObject({ status: 'approved', publishId: made.publish.id });
    const org = scoped(env.DB, t.org.id);
    expect(published((await org.spots.get(spotId))!)?.durationMs).toBe(12_000);
    const left = (await org.spots.get(theirs.id))!;
    expect(published(left)).toBeUndefined();
    expect(draftChanged(left)).toBe(true);

    // The agent learns the outcome; the audit log has its request, the owner's approval and the publish it made.
    expect((await mcpTool(token, 'get_publish_request', { publishRequestId: requestId })).structuredContent.request).toMatchObject({
      status: 'approved',
      publishId: made.publish.id,
    });
    const rows = (await org.auditLog.list({ limit: 50 })).filter((e) => e.targetId === requestId);
    expect(rows.map((e) => [e.action, e.actorKind, e.actorId])).toEqual([
      ['approve_publish_request', 'user', t.ownerId],
      ['request_publish', 'agent', grantId],
    ]);
    expect(JSON.parse(rows[0]!.detailJson!).detail).toMatchObject({ publishId: made.publish.id, requestedBy: { kind: 'agent', id: grantId } });
    expect(await org.publishes.get(made.publish.id)).toMatchObject({ actorKind: 'user', actorId: t.ownerId });
  });

  it('refuses the approval as a conflict when the draft is edited after the request, and publishes nothing', async () => {
    const t = await team();
    const { token, spotId, version } = await agentEdited(t);
    const requestId: string = (await ask(token, spotId, version)).structuredContent.request.id;
    const edited = await mcpTool(token, 'update_spot', { spotId, durationMs: 20_000, ifVersion: version });
    expect(edited.isError).toBeUndefined();
    const res = await t.owner.post('/api/tools/approve_publish_request', { publishRequestId: requestId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict', details: { id: spotId, version: version + 1 } });
    expect(published((await scoped(env.DB, t.org.id).spots.get(spotId))!)).toBeUndefined();
  });
});

describe('who publishes', () => {
  it('never an agent deciding a request, even with content:publish', async () => {
    const t = await team();
    const { token, spotId, version } = await agentEdited(t);
    const requestId: string = (await ask(token, spotId, version)).structuredContent.request.id;
    const { access_token } = await agentToken(t.t, t.owner, t.org.id, ['content:read', 'content:draft', 'content:publish']);
    for (const name of ['approve_publish_request', 'decline_publish_request']) {
      expect(await mcpTool(access_token, name, { publishRequestId: requestId }), name).toMatchObject({
        isError: true,
        structuredContent: { error: 'forbidden' },
      });
    }
    expect((await scoped(env.DB, t.org.id).publishRequests.get(requestId))!.status).toBe('pending');
  });

  it('an agent with content:publish, granted by someone who may publish, publishes without asking; its editor losing publish takes it away on the next call', async () => {
    const t = await team();
    const { access_token } = await agentToken(t.t, t.editor, t.org.id, ['content:read', 'content:draft', 'content:publish']);
    const spot = await urlSpot(t.editor, 'direct');
    const pins = { drafts: [{ kind: 'spot', id: spot.id, version: spot.version }] };
    await t.owner.ok('/api/tools/update_org_settings', { editorsPublish: false });
    expect(await mcpTool(access_token, 'publish', pins)).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
    await t.owner.ok('/api/tools/update_org_settings', { editorsPublish: true });
    const made = await mcpTool(access_token, 'publish', pins);
    expect(made.structuredContent.promoted).toEqual([{ kind: 'spot', id: spot.id }]);
  });
});

/** The API's bindings, counting each D1 statement prepared and each Durable Object request. */
function counted() {
  const seen = { statements: 0, objects: 0 };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') seen.statements++;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const objects = (ns: DurableObjectNamespace): DurableObjectNamespace =>
    new Proxy(ns, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (key !== 'get') return typeof v === 'function' ? v.bind(target) : v;
        return (id: DurableObjectId) => {
          seen.objects++;
          return target.get(id);
        };
      },
    });
  const bindings: Env = { ...env, DB: db, AGENT_GRANTS: objects(env.AGENT_GRANTS) as Env['AGENT_GRANTS'], ORGS: objects(env.ORGS) as Env['ORGS'] };
  return { seen, bindings };
}

describe('the cost of each path (the Free plan: 50 D1 queries an invocation)', () => {
  it('asking, reading and deciding stay a handful of D1 statements and at most one Durable Object request', async () => {
    const t = await team();
    const { token, spotId, version } = await agentEdited(t);
    const measure = async (run: (bindings: Env) => Promise<unknown>) => {
      const { seen, bindings } = counted();
      await run(bindings);
      return { ...seen };
    };
    const asking = await measure((b) => mcpTool(token, 'request_publish', { drafts: [{ kind: 'spot', id: spotId, version }], reason: 'Weekend hours' }, b));
    const [first] = await scoped(env.DB, t.org.id).publishRequests.list({ take: 1 });
    const reading = await measure((b) => mcpTool(token, 'get_publish_request', { publishRequestId: first!.id }, b));
    const listing = await measure((b) => mcpTool(token, 'list_publish_requests', { pending: true }, b));
    const owner = (b: Env) => {
      const c = new Client(t.owner.t, t.owner.ip, b);
      for (const [k, v] of t.owner.jar) c.jar.set(k, v);
      return c;
    };
    const second: string = (await ask(token, spotId, version)).structuredContent.request.id;
    const declining = await measure((b) => owner(b).ok('/api/tools/decline_publish_request', { publishRequestId: second }));
    const approving = await measure((b) => owner(b).ok('/api/tools/approve_publish_request', { publishRequestId: first!.id }));
    // Measured, as the most each may take: asking reads the token, the pins, the settings, members,
    // channels and the agent's client, then writes the request, its deliveries and the audit row in one
    // batch; its one object request is the agent's write limit (#107). A new statement fails this on purpose.
    expect(asking).toEqual({ statements: 18, objects: 1 });
    expect(reading).toEqual({ statements: 3, objects: 0 });
    expect(listing).toEqual({ statements: 3, objects: 0 });
    expect(declining).toEqual({ statements: 6, objects: 0 });
    // A person's approval is a publish: the org's publish lock is its one object request.
    expect(approving).toEqual({ statements: 26, objects: 1 });
  });
});
