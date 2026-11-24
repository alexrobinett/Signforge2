// Publish requests through the API (M4-09, #114): an agent connected over OAuth with content:draft
// edits a spot over /mcp and asks to publish it; an owner approves in the CMS's API, and exactly the
// pinned version goes live, as the owner, while another member's draft stays a draft. Editing the
// draft after the request makes the approval a conflict. An agent never decides, even with
// content:publish; with it, granted by someone who may publish, it publishes without asking, capped
// on every call by that member's role and the editors-publish setting (owner decision on Q7). And
// each path's cost: D1 statements and Durable Object requests.
import { draftChanged, published, scoped } from '@signforge/db';
import { testScope } from '@signforge/db/testing';
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

/** What `run` costs on bindings that count it (`counted`). */
async function measure(run: (bindings: Env) => Promise<unknown>) {
  const { result, bindings } = counted();
  await run(bindings);
  return result();
}

/** `who`, signed in as they are, calling through `bindings`. */
function as(who: Client, bindings: Env) {
  const c = new Client(who.t, who.ip, bindings);
  for (const [k, v] of who.jar) c.jar.set(k, v);
  return c;
}

/**
 * The API's bindings, counting D1's work and each Durable Object RPC. `statements` is every statement
 * prepared; `queries` what D1 counts against an invocation's 50: each statement run alone, and each
 * batch once. `rpcs` names each method called on an object's stub (`acquire`, `release`, `write`).
 */
function counted(beforeBatch?: () => Promise<unknown>) {
  const seen = { statements: 0, queries: 0, rpcs: [] as string[] };
  let batched = 0;
  let batches = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') seen.statements++;
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          batched += statements.length;
          batches++;
          // A change that lands between a call's reads and its batch, once.
          const before = beforeBatch;
          beforeBatch = undefined;
          await before?.();
          return target.batch(statements);
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const objects = (ns: DurableObjectNamespace): DurableObjectNamespace =>
    new Proxy(ns, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (key !== 'get') return typeof v === 'function' ? v.bind(target) : v;
        return (id: DurableObjectId) =>
          new Proxy(target.get(id), {
            get(stub, method) {
              const real = Reflect.get(stub, method);
              if (typeof method !== 'string' || typeof real !== 'function') return real;
              return (...args: unknown[]) => (seen.rpcs.push(method), Reflect.apply(real, stub, args));
            },
          });
      },
    });
  const bindings: Env = { ...env, DB: db, AGENT_GRANTS: objects(env.AGENT_GRANTS) as Env['AGENT_GRANTS'], ORGS: objects(env.ORGS) as Env['ORGS'] };
  // Every statement run alone is a query, and every batch one more, however many it holds.
  const result = () => ({ statements: seen.statements, queries: seen.statements - batched + batches, rpcs: seen.rpcs });
  return { result, bindings };
}

/** Members added as Better Auth leaves them: `n` editors, each one who may approve. */
async function editors(orgId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const userId = `${orgId}-editor-${i}`;
    await env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, '2026-11-24', '2026-11-24')")
      .bind(userId, `Editor ${i}`, `${userId}@signforge.test`)
      .run();
    await env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'editor', '2026-11-24')")
      .bind(`${userId}-m`, orgId, userId)
      .run();
  }
}

/**
 * The most a refused approval of 40 pins may take: its reads, the failed batch, the guards read 15 to a
 * query, and the retry's reads, which find the pin changed. Measured at 37 or 38 (the session's cache read varies).
 */
const STALE_PINS_QUERIES = 40;

describe('the cost of each path (the Free plan: 50 D1 queries an invocation)', () => {
  it('on its costliest case, 30 approvers, Slack and a webhook, and screens to compile: asking, reading and deciding stay within it', async () => {
    const t = await team();
    const { token, spotId, version } = await agentEdited(t);
    await editors(t.org.id, 30);
    await t.owner.ok('/api/tools/set_slack_alert_channel', { webhookUrl: 'https://hooks.slack.com/services/T0COST/B0COST/secretpart' });
    await t.owner.ok('/api/tools/set_webhook_alert_channel', {
      webhookUrl: 'https://ops.example.com/hooks/sf',
      signingSecret: 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD',
    });
    await t.owner.ok('/api/tools/update_org_settings', { alerts: { publish_requested: { slack: true, webhook: true } } });
    const org = scoped(env.DB, t.org.id);
    for (const name of ['Door', 'Till', 'Lobby', 'Hall', 'Yard'])
      await testScope(env.DB, t.org.id).screens.insert({ name, timezone: 'UTC', orientation: 'landscape' });
    const other = await urlSpot(t.owner, 'other');
    const asking = await measure((b) => mcpTool(token, 'request_publish', { drafts: [{ kind: 'spot', id: spotId, version }], reason: 'Weekend hours' }, b));
    const [first] = await org.publishRequests.list({ take: 1 });
    const reading = await measure((b) => mcpTool(token, 'get_publish_request', { publishRequestId: first!.id }, b));
    const listing = await measure((b) => mcpTool(token, 'list_publish_requests', { pending: true }, b));
    const owner = (b: Env) => as(t.owner, b);
    const second: string = (await ask(token, other.id, other.version)).structuredContent.request.id;
    const declining = await measure((b) => owner(b).ok('/api/tools/decline_publish_request', { publishRequestId: second }));
    const approving = await measure((b) => owner(b).ok('/api/tools/approve_publish_request', { publishRequestId: first!.id }));
    // Its deliveries as asked: Slack, the webhook, and one email to all 31 who may approve, whatever their number (fanned out when sent).
    expect(
      (await org.alertDeliveries.list({ take: 200 }))
        .filter((d) => d.eventId === `evt_publish_requested_${first!.id}`)
        .map((d) => d.channel)
        .sort(),
    ).toEqual(['email', 'slack', 'webhook']);
    // Measured, as the most each may take. A new statement fails this on purpose: look at the budget, then raise it.
    // Asking reads the token, the pins (three reads, however many), the asker's waiting requests, the brand
    // state, the settings, members, channels and the agent's client, then writes the request, its three
    // deliveries and the audit row in one batch; then, sent at once, the email's fan-out to the 31 is one
    // batch more (its 31 statements count once). Its one RPC is the agent's write limit (#107).
    expect(asking).toEqual({ statements: 60, queries: 24, rpcs: ['write'] });
    // Reading, listing and deciding also read who asked by name (#115): the members, and the connected agents, two queries.
    expect(reading).toEqual({ statements: 5, queries: 5, rpcs: [] });
    expect(listing).toEqual({ statements: 5, queries: 5, rpcs: [] });
    expect(declining).toEqual({ statements: 9, queries: 6, rpcs: [] });
    // A person's approval is a publish, under the org's lock: acquire and release are its two RPCs.
    // A publish clears each promoted spot's or playlist's kept draft (#116): one statement in its batch.
    expect(approving).toEqual({ statements: 32, queries: 22, rpcs: ['acquire', 'release'] });
    for (const path of [asking, reading, listing, declining, approving]) expect(path.queries).toBeLessThan(50);
  });

  it('checks a request of 16 playlists and a spot still holding sample text, and puts a declined one back, within it (review of #409)', async () => {
    const t = await team();
    const { token, spotId, version } = await agentEdited(t);
    await env.DB.prepare('UPDATE spots SET sample_fields_json = ? WHERE id = ?')
      .bind(JSON.stringify({ texts: ['headline'], lists: {} }), spotId)
      .run();
    const scope = testScope(env.DB, t.org.id);
    for (const name of ['Door', 'Till', 'Lobby']) await scope.screens.insert({ name, timezone: 'UTC', orientation: 'landscape' });
    const pins = [{ kind: 'spot', id: spotId, version }];
    for (let i = 0; i < 16; i++) {
      const p = await scope.playlists.insert({ name: `P${i}`, transitionJson: JSON.stringify({ type: 'cut' }) });
      await scope.playlists.setItems(p.id, [spotId]);
      pins.push({ kind: 'playlist', id: p.id, version: (await scope.playlists.get(p.id))!.rowVersion });
    }
    const requestId: string = (await mcpTool(token, 'request_publish', { drafts: pins, reason: 'Sixteen menus' })).structuredContent.request.id;
    const owner = (b: Env) => as(t.owner, b);
    let seen: { samples: unknown[]; refused: unknown } | undefined;
    const checking = await measure(async (b) => {
      seen = await owner(b).ok('/api/tools/check_publish_request', { publishRequestId: requestId });
    });
    expect(seen).toMatchObject({ refused: null, samples: [{ spotId, version, fields: ['headline'] }] });
    await t.owner.ok('/api/tools/decline_publish_request', { publishRequestId: requestId });
    const reopening = await measure((b) => owner(b).ok('/api/tools/reopen_publish_request', { publishRequestId: requestId }));
    // The org read once for the check and both of its dry runs, the second acknowledging the sample text; every
    // playlist's items in that one read, however many are pinned. Reopening reads the request, the asker's waiting
    // ones and the names, and writes the request and its audit row with their guards in one batch.
    expect(checking).toEqual({ statements: 18, queries: 18, rpcs: [] });
    expect(reopening).toEqual({ statements: 9, queries: 7, rpcs: [] });
    for (const path of [checking, reopening]) expect(path.queries).toBeLessThan(50);
  });

  it('refuses an approval of 40 pins, one edited just before its batch, within the budget', async () => {
    const t = await team();
    const org = testScope(env.DB, t.org.id);
    const spots: { id: string; rowVersion: number }[] = [];
    for (let i = 0; i < 40; i++) spots.push(await org.spots.insert({ name: `s${i}`, kind: 'url', durationMs: 10_000, url: `https://example.com/${i}` }));
    const asked = await t.owner.ok<{ request: { id: string } }>('/api/tools/request_publish', {
      drafts: spots.map((s) => ({ kind: 'spot', id: s.id, version: s.rowVersion })),
      reason: 'Forty at once',
    });
    // The 21st pin edited between the approval's reads and its batch: the batch fails, and the retry finds it.
    const { result, bindings } = counted(() =>
      env.DB.prepare('UPDATE spots SET duration_ms = 9000, row_version = row_version + 1 WHERE id = ?').bind(spots[20]!.id).run(),
    );
    const c = new Client(t.owner.t, t.owner.ip, bindings);
    for (const [k, v] of t.owner.jar) c.jar.set(k, v);
    const res = await c.post('/api/tools/approve_publish_request', { publishRequestId: asked.request.id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict', details: { id: spots[20]!.id } });
    expect(result().rpcs).toEqual(['acquire', 'release']);
    expect(result().queries).toBeLessThanOrEqual(STALE_PINS_QUERIES);
  });
});
