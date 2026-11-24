/**
 * Publish requests (M4-09): an agent without `content:publish`, or a person who may not publish,
 * asks; a person who may publish approves or declines. Owner decisions on #114: a request pins its
 * drafts at the versions asked for, and approval publishes exactly those (`publish` with drafts,
 * M3-18), or nothing if one has changed since; an agent with `content:publish` granted at consent by
 * someone who may publish publishes without asking, capped on every call by that member's role and
 * `editorsPublish` (the dispatcher's effective scopes).
 *
 * Approving and declining are people's (`people`): the dispatcher refuses any agent, with
 * `content:publish` or without. An approval is the approver's publish, audited as them, its row
 * naming the request and the publish it made. A request waits 7 days, then is expired and can no
 * longer be decided.
 *
 * Asking queues a `publish.requested` alert in the same batch: to the channels the org's
 * `publish_requested` rule names, and by email to the members it names who may approve.
 */
import type { OrgScope, PublishRequestRow } from '@signforge/db';
import { z } from 'zod';
import { grantClient } from './agent-grants';
import { ALERT_RETRY_MS, type AlertEvent } from './alert-channels';
import { id, idempotencyKey } from './fields';
import { AUDIENCE_ROLES, draftPin, outputs, type PublishRequestView } from './outputs';
import { keysetPage, pageInput } from './paging';
import { runPublish } from './publish';
import type { DraftPin } from './publishing';
import { orgSettings } from './settings';
import { defineTool, notFound, ToolError, type ToolContext } from './tool';

/** How long a request waits for a decision. */
export const PUBLISH_REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;

/** Its status at `now`: a pending request past its expiry is expired. */
const statusOf = (row: PublishRequestRow, now: number) => (row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status);

// Written by `request_publish` from its parsed input.
const pinsOf = (row: PublishRequestRow): DraftPin[] => JSON.parse(row.draftsJson);

const view = (row: PublishRequestRow, now: number): PublishRequestView => ({
  id: row.id,
  status: statusOf(row, now),
  requestedBy: { kind: row.requestedByKind, id: row.requestedBy, clientId: row.clientId },
  drafts: pinsOf(row),
  reason: row.reason,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt,
  publishId: row.publishId,
  version: row.rowVersion,
});

/** Each pinned draft as it is now, refused `conflict` (details `{ id, version }`, 0 if gone) unless it is at the version pinned: as `publish` refuses one. */
async function checkPins(org: OrgScope, pins: readonly DraftPin[]) {
  const ids = (kind: DraftPin['kind']) => pins.filter((p) => p.kind === kind).map((p) => p.id);
  const [spots, playlists, entries] = await Promise.all([
    org.spots.getMany(ids('spot')),
    org.playlists.getMany(ids('playlist')),
    org.scheduleEntries.getMany(ids('schedule_entry')),
  ]);
  const rows = { spot: spots, playlist: playlists, schedule_entry: entries };
  for (const p of pins) {
    const now = rows[p.kind].find((r) => r.id === p.id)?.rowVersion ?? 0;
    if (now !== p.version) {
      throw new ToolError('conflict', `${p.kind.replace('_', ' ')} ${p.id} is not at version ${p.version}; it is now version ${now}`, {
        id: p.id,
        version: now,
      });
    }
  }
}

/**
 * Stages `publish.requested` for the org's channels and by email to the members its rule names who
 * may approve (not the asker), and returns the deliveries to send once committed. An email
 * delivery's event id names its member too, as one delivery per event and channel is kept: the
 * event itself has one id everywhere.
 */
async function announce(ctx: Pick<ToolContext<unknown>, 'org' | 'write'>, row: PublishRequestRow, now: number): Promise<string[]> {
  const { org, write } = ctx;
  const [settings, members, channels, orgName] = await Promise.all([orgSettings(org), org.members.list(), org.alertChannels.list(), org.name()]);
  const rule = settings.alerts.publish_requested;
  const mayPublish = (role: string) => role === 'owner' || (role === 'editor' && settings.editorsPublish);
  const roles: readonly string[] = AUDIENCE_ROLES[rule.who];
  const to = rule.email ? members.filter((m) => roles.includes(m.role) && mayPublish(m.role) && m.userId !== row.requestedBy) : [];
  const sendTo = channels.map((c) => c.kind).filter((kind) => rule[kind]);
  if (!to.length && !sendTo.length) return [];
  let name: string | null;
  if (row.requestedByKind === 'agent') {
    const [connected] = await org.agentGrants.connected({ grantId: row.requestedBy });
    name = connected ? grantClient(connected).name : null;
  } else name = members.find((m) => m.userId === row.requestedBy)?.name || null;
  const event: AlertEvent = {
    type: 'publish.requested',
    id: `evt_publish_requested_${row.id}`,
    occurredAt: new Date(now).toISOString(),
    org: { id: org.orgId, name: orgName },
    data: {
      // No page shows a request yet: the approvals queue (#115) gives it one, and this its link.
      request: { id: row.id, url: null, drafts: pinsOf(row).length, expiresAt: new Date(row.expiresAt).toISOString() },
      by: { kind: row.requestedByKind, id: row.requestedBy, name },
    },
  };
  const json = JSON.stringify(event);
  const queued = (channel: 'email' | 'slack' | 'webhook', eventId: string, toUserId: string | null) =>
    write(
      org.alertDeliveries.stage.insert({
        channel,
        eventId,
        eventType: event.type,
        eventJson: json,
        toUserId,
        nextAttemptAt: now,
        giveUpAt: now + ALERT_RETRY_MS,
      }),
    ).id;
  return [...sendTo.map((kind) => queued(kind, event.id, null)), ...to.map((m) => queued('email', `${event.id}:${m.userId}`, m.userId))];
}

const requestPublish = defineTool({
  name: 'request_publish',
  description:
    'Ask a person who may publish to publish chosen drafts: what to use without content:publish. It pins each draft at the version you give (the version you read); a person approves or declines it, and approval publishes exactly those, or nothing if one has changed since. Refused with a conflict, details { id, version }, if one is not at that version now. reason is shown to approvers as your words. It waits 7 days, then expires. Follow it with get_publish_request. Pass an idempotencyKey so a retry cannot ask twice. Returns { request }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({
    drafts: z
      .array(draftPin)
      .min(1)
      .max(100)
      .refine((pins) => new Set(pins.map((p) => `${p.kind}:${p.id}`)).size === pins.length, 'each draft once')
      .describe('The drafts to publish, each at the version you read'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      // One paragraph of plain text: no control characters, so it cannot reshape the page or alert around it.
      .regex(/^[^\p{Cc}]*$/u, 'one line of text, with no control characters')
      .describe('What it is and why, for the person deciding: one line, 500 characters at most'),
    idempotencyKey,
  }),
  output: outputs.request_publish,
  example: { drafts: [{ kind: 'spot', id: 'spt_example', version: 1 }], reason: 'Weekend opening hours on the lobby screens' },
  target: (_input, output) => ({ kind: 'publish_request', id: output.request.id }),
  handler: async ({ org, actor, input, write, deliverNow }) => {
    await checkPins(org, input.drafts);
    const now = Date.now();
    const row = write(
      org.publishRequests.stage.insert({
        requestedByKind: actor.kind === 'agent' ? 'agent' : 'user',
        requestedBy: actor.id,
        clientId: actor.clientId ?? null,
        draftsJson: JSON.stringify(input.drafts.map(({ kind, id, version }) => ({ kind, id, version }))),
        reason: input.reason,
        expiresAt: now + PUBLISH_REQUEST_TTL_MS,
      }),
    );
    for (const delivery of await announce({ org, write }, row, now)) deliverNow(delivery);
    return { request: view(row, now) };
  },
});

const listPublishRequests = defineTool({
  name: 'list_publish_requests',
  description:
    "List the organization's publish requests, newest first, a page at a time: each with its drafts, who asked and why, and how it was decided. pending: true keeps those still waiting for a decision. Returns { requests, next }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ pending: z.boolean().optional().describe('Only those still waiting: not decided, and not expired'), ...pageInput }),
  output: outputs.list_publish_requests,
  example: { pending: true },
  handler: async ({ org, input }) => {
    const now = Date.now();
    const { rows, next } = await keysetPage(
      input,
      (after, take) => org.publishRequests.list({ after, take, pendingAt: input.pending ? now : undefined }),
      (r) => [r.createdAt, r.id],
    );
    return { requests: rows.map((r) => view(r, now)), next };
  },
});

const getPublishRequest = defineTool({
  name: 'get_publish_request',
  description:
    'Get one publish request: its drafts, who asked and why, and its status: pending, approved (with the publish it made), declined, or expired. Returns { request }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ publishRequestId: id('publish request') }),
  output: outputs.get_publish_request,
  example: { publishRequestId: 'prq_example' },
  handler: async ({ org, input }) => {
    const row = await org.publishRequests.get(input.publishRequestId);
    if (!row) throw notFound('publish request', input.publishRequestId);
    return { request: view(row, Date.now()) };
  },
});

/** The request, pending at `now`, or refused: one already decided or expired cannot be decided again. */
async function pending(org: OrgScope, requestId: string, now: number): Promise<PublishRequestRow> {
  const row = await org.publishRequests.get(requestId);
  if (!row) throw notFound('publish request', requestId);
  const status = statusOf(row, now);
  if (status !== 'pending') throw new ToolError('conflict', `publish request ${row.id} is ${status}`, { status });
  return row;
}

const approvePublishRequest = defineTool({
  name: 'approve_publish_request',
  description:
    'Approve a publish request: publish exactly the drafts it pins, at the versions it pins, as you. Refused with a conflict, details { id, version }, if one has changed since it was asked for (nothing is published: look at it and ask again), and if the request is no longer pending. Other drafts are not published. People only. Returns { request, published }, published as publish returns it.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  publishes: true,
  people: true,
  input: z.object({ publishRequestId: id('publish request') }),
  output: outputs.approve_publish_request,
  example: { publishRequestId: 'prq_example' },
  target: (input) => ({ kind: 'publish_request', id: input.publishRequestId }),
  // The row is the approver's; it names who asked and the publish it made, which links the three.
  auditDetail: (output) => ({
    requestedBy: output.request.requestedBy,
    publishId: output.request.publishId,
    ...(output.published.madeDefault ? { madeDefault: output.published.madeDefault } : {}),
  }),
  handler: async (ctx) => {
    const { org, actor, input, write } = ctx;
    const now = Date.now();
    const row = await pending(org, input.publishRequestId, now);
    const published = await runPublish(ctx, pinsOf(row));
    const decided = write(org.publishRequests.stage.decide(row, { status: 'approved', by: actor.id, now, publishId: published.publish?.id ?? null }));
    return { request: view(decided, now), published };
  },
});

const declinePublishRequest = defineTool({
  name: 'decline_publish_request',
  description:
    'Decline a publish request: nothing is published, and the asker sees it declined. Refused with a conflict if it is no longer pending. People only. Returns { request }.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  people: true,
  input: z.object({ publishRequestId: id('publish request') }),
  output: outputs.decline_publish_request,
  example: { publishRequestId: 'prq_example' },
  target: (input) => ({ kind: 'publish_request', id: input.publishRequestId }),
  auditDetail: (output) => ({ requestedBy: output.request.requestedBy }),
  handler: async ({ org, actor, input, write }) => {
    const now = Date.now();
    const row = await pending(org, input.publishRequestId, now);
    return { request: view(write(org.publishRequests.stage.decide(row, { status: 'declined', by: actor.id, now })), now) };
  },
});

export const publishRequestTools = [requestPublish, listPublishRequests, getPublishRequest, approvePublishRequest, declinePublishRequest];
