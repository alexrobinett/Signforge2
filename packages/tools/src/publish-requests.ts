/**
 * Publish requests (M4-09): an agent without `content:publish`, or a person who may not publish,
 * asks; a person who may publish approves or declines. Owner decisions on #114: a request pins its
 * drafts at the versions asked for, and approval publishes all of them at those versions (`publish`
 * with drafts, M3-18), or nothing: not if one has changed since, not if one fails its checks, and
 * not if the org's brand kits, which have no draft and go live with any publish, have changed since
 * it was asked. An agent with `content:publish` granted at consent by someone who may publish
 * publishes without asking, capped on every call by that member's role and `editorsPublish`.
 *
 * Approving and declining are people's (`people`): the dispatcher refuses any agent, with
 * `content:publish` or without. An approval is the approver's publish, audited as them, its row
 * naming the request and the publish it made. A request waits 7 days, then is expired and can no
 * longer be decided; the batch checks that again, as it does the pins and the brand kits.
 *
 * Asking queues a `publish.requested` alert in the same batch: to the channels the org's
 * `publish_requested` rule names, and one email delivery, which the delivery run sends to the
 * members the rule names who may approve then (apps/api src/deliveries.ts), so asking costs the
 * same however many members there are. The same pins asked again while the first waits get the
 * first request; an asker has at most `MAX_PENDING` waiting.
 */
import type { OrgScope, PublishRequestRow } from '@signforge/db';
import { z } from 'zod';
import { grantClient } from './agent-grants';
import { ALERT_RETRY_MS, type AlertEvent } from './alert-channels';
import { id, idempotencyKey } from './fields';
import { AUDIENCE_ROLES, draftPin, outputs, type PublishRequestView } from './outputs';
import { keysetPage, pageInput } from './paging';
import { peopleAllowSample, runPublish, sampleAcks } from './publish';
import type { DraftPin } from './publishing';
import { orgSettings } from './settings';
import { defineTool, notFound, ToolError, type ToolContext } from './tool';

/** How long a request waits for a decision. */
export const PUBLISH_REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;
/** The most requests one asker has waiting at once. */
export const MAX_PENDING = 10;
/** Controls, format and bidi characters, line and paragraph breaks, and invisible code points: as a client's name refuses them. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

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

/**
 * Each pinned draft as it is now, refused `conflict` (details `{ id, version }`, 0 if gone) unless it
 * is at the version pinned: as `publish` refuses one. Three reads, however many pins.
 */
async function checkPins(org: OrgScope, pins: readonly DraftPin[]) {
  const [spots, playlists, entries] = await Promise.all([org.spots.list(), org.playlists.list(), org.scheduleEntries.list()]);
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

/** Whether `role` may approve while the org has `editorsPublish`. */
export const approves = (role: string, editorsPublish: boolean) => role === 'owner' || (role === 'editor' && editorsPublish);

/**
 * Stages `publish.requested` for the org's channels, and one email delivery when its rule sends email
 * and some member it names may approve (not the asker): the delivery run sends it to each of them
 * (apps/api src/deliveries.ts). Returns the deliveries to send once committed.
 */
async function announce(ctx: Pick<ToolContext<unknown>, 'org' | 'write'>, row: PublishRequestRow, now: number): Promise<string[]> {
  const { org, write } = ctx;
  const [settings, members, channels, orgName] = await Promise.all([orgSettings(org), org.members.list(), org.alertChannels.list(), org.name()]);
  const rule = settings.alerts.publish_requested;
  const roles: readonly string[] = AUDIENCE_ROLES[rule.who];
  const email = rule.email && members.some((m) => roles.includes(m.role) && approves(m.role, settings.editorsPublish) && m.userId !== row.requestedBy);
  const sendTo = [...channels.map((c) => c.kind).filter((kind) => rule[kind]), ...(email ? (['email'] as const) : [])];
  if (!sendTo.length) return [];
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
  return sendTo.map(
    (channel) =>
      write(
        org.alertDeliveries.stage.insert({
          channel,
          eventId: event.id,
          eventType: event.type,
          eventJson: json,
          // Email to no one member: to those who may approve when it is sent.
          toUserId: null,
          nextAttemptAt: now,
          giveUpAt: now + ALERT_RETRY_MS,
        }),
      ).id,
  );
}

const tooMany = `${MAX_PENDING} of your publish requests are waiting: wait for one to be decided or to expire`;

/** Pins in one order, so the same drafts asked for are the same text (`drafts_json`). */
const sortedPins = (pins: readonly DraftPin[]): DraftPin[] =>
  pins.map(({ kind, id, version }) => ({ kind, id, version })).toSorted((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));

const requestPublish = defineTool({
  name: 'request_publish',
  description: `Ask a person who may publish to publish chosen drafts: what to use without content:publish. It pins each draft at the version you give (the version you read); a person approves or declines it, and approval publishes all of them, or nothing if one has changed since, fails its checks, or the brand kits have changed since you asked. Refused with a conflict, details { id, version }, if one is not at that version now. The same drafts asked for again while the first request waits return it. At most ${MAX_PENDING} of yours wait at once. reason is shown to approvers as your words. It waits 7 days, then expires. Follow it with get_publish_request. Pass an idempotencyKey so a retry cannot ask twice. Returns { request }.`,
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
      // One line of plain text: nothing that breaks it, hides text or reorders it on the page or alert around it.
      .refine((v) => !HIDDEN.test(v), 'one line of text, with no control, format, bidirectional or invisible characters')
      .describe('What it is and why, for the person deciding: one line, 500 characters at most'),
    idempotencyKey,
  }),
  output: outputs.request_publish,
  example: { drafts: [{ kind: 'spot', id: 'spt_example', version: 1 }], reason: 'Weekend opening hours on the lobby screens' },
  target: (_input, output) => ({ kind: 'publish_request', id: output.request.id }),
  // Its batch refused as it ran: another call of the asker's, made at the same moment, got there first.
  refuseFailedCommit: async ({ org, input, actor }) => {
    const waiting = await org.publishRequests.pendingBy(actor.id, Date.now());
    const same = waiting.find((r) => r.draftsJson === JSON.stringify(sortedPins(input.drafts)));
    if (same) return new ToolError('conflict', `the same drafts were asked for at the same moment: request ${same.id} is waiting`, { requestId: same.id });
    return waiting.length >= MAX_PENDING ? new ToolError('conflict', tooMany, { pending: waiting.length }) : undefined;
  },
  handler: async ({ org, actor, input, write, deliverNow }) => {
    await checkPins(org, input.drafts);
    const now = Date.now();
    const draftsJson = JSON.stringify(sortedPins(input.drafts));
    const waiting = await org.publishRequests.pendingBy(actor.id, now);
    // Asked again while it waits: the same request, and no second alert.
    const same = waiting.find((r) => r.draftsJson === draftsJson);
    if (same) return { request: view(same, now) };
    if (waiting.length >= MAX_PENDING) throw new ToolError('conflict', tooMany, { pending: waiting.length });
    const row = write(
      org.publishRequests.stage.insert(
        {
          requestedByKind: actor.kind === 'agent' ? 'agent' : 'user',
          requestedBy: actor.id,
          clientId: actor.clientId ?? null,
          draftsJson,
          reason: input.reason,
          brandState: await org.brandKits.state(),
          expiresAt: now + PUBLISH_REQUEST_TTL_MS,
        },
        now,
        // Checked again as the batch runs, so two asked at once cannot both get past the same pins or the cap.
        MAX_PENDING,
      ),
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
    'Approve a publish request: publish all the drafts it pins, at the versions it pins, as you, or nothing. Refused with a conflict, publishing nothing: details { id, version } if one has changed since it was asked for; { held } if one fails its checks (with why); { brand: true } if the brand kits, which go live with any publish, have changed since; { status } if the request is no longer pending; sample_text, details { spots }, if a spot it would promote still holds the sample text of its template, unless allowSample names it as refused. Other drafts are not published. People only. Returns { request, published }, published as publish returns it.',
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  publishes: true,
  people: true,
  input: z.object({
    publishRequestId: id('publish request'),
    allowSample: sampleAcks
      .optional()
      .describe(
        "The spots a sample_text refusal named, { spotId, version, fields } as named: publish them with their template's sample text anyway, once you have seen them",
      ),
  }),
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
    const row = await pending(org, input.publishRequestId, Date.now());
    const pins = pinsOf(row);
    const published = await runPublish(ctx, pins, [], { exact: true, brand: row.brandState }, peopleAllowSample(ctx));
    // All or nothing: a pin held by its checks publishes none of them (the batch is not committed).
    const pinned = new Set(pins.map((p) => `${p.kind}:${p.id}`));
    const held = published.held.filter((h) => pinned.has(`${h.kind}:${h.id}`));
    if (held.length)
      throw new ToolError(
        'conflict',
        `not every draft it asks for can be published: ${held.map((h) => `${h.kind.replace('_', ' ')} ${h.id}: ${h.problems.join('; ')}`).join(' / ')}`,
        {
          held,
        },
      );
    // Its time is taken last, nearest the batch, whose guard refuses it past the request's expiry.
    const now = Date.now();
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
