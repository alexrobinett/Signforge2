/**
 * Alert channels (#88): besides email, an org's alerts can go to one Slack channel, through an
 * incoming-webhook URL an owner pastes, and to one outgoing webhook, POSTed as signed JSON. Both
 * URLs and the signing secret are sealed before they are stored and never shown again; the caller
 * makes the signing secret, so it is in no tool's output and the audit log redacts it from the input.
 *
 * Each alert is queued as one delivery per channel (`alert_deliveries`) and sent by the API's
 * delivery run, which retries it with backoff for up to `ALERT_RETRY_MS`. The delivery log keeps
 * 7 days. Which alerts go to which channel is each alert rule's (./settings.ts).
 */
import { type AlertChannelRow, type AlertDeliveryRow, newId } from '@signforge/db';
import { feedUrlProblem, type FeedUrlProblem } from '@signforge/feeds';
import { z } from 'zod';
import { id, ifVersion } from './fields';
import { keysetPage, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';
import { ALERT_CHANNEL_KINDS, ALERT_CHANNELS, type channelView, type deliveryView, outputs } from './outputs';

/** How long an alert is retried before it is given up on. */
export const ALERT_RETRY_MS = 24 * 60 * 60_000;

/** A screen as an alert names it; `url` is its page in the CMS, null where the API does not know the CMS's address. */
interface AlertScreen {
  id: string;
  name: string;
  url: string | null;
}

/**
 * An alert as a webhook receives it, the JSON body of the POST. `id` is the same for every channel
 * an alert goes to, and for every retry, so a receiver can drop one it has seen.
 */
export type AlertEvent = { id: string; occurredAt: string; org: { id: string; name: string } } & (
  | { type: 'screen.offline'; data: { screen: AlertScreen; lastSeenAt: string } }
  | { type: 'screen.back'; data: { screen: AlertScreen; lastSeenAt: string; offlineSince: string } }
  | {
      type: 'publish.finished';
      /**
       * `url` is the publish's rollout in the CMS; `publishedAt` when it was made. Of the `screens`
       * it switched, `playing` say they play it and `replaced` a later publish switched before it
       * got there; any other was revoked. Sent only when at least one played it.
       */
      data: { publish: { id: string; revision: number; url: string | null; publishedAt: string }; screens: number; playing: number; replaced: number };
    }
  | {
      type: 'agent.refused';
      /**
       * An agent refused `forbidden` again and again within the hour (M4-08): sent at most once per
       * grant an hour. `client.name` is null when a page may not show it (`shownClient`). `tool` and
       * `needs` are its latest refused call's; `url` is the agent's page in the CMS.
       */
      data: {
        grant: { id: string; url: string | null; client: { id: string; name: string | null } };
        refusals: number;
        tool: string;
        needs: string | null;
      };
    }
  | {
      type: 'publish.requested';
      /**
       * Someone asked to publish chosen drafts (M4-09), for a member who may publish to approve or
       * decline before `expiresAt`. `by.name` is a member's name, or an agent's client name when a
       * page may show it (`shownClient`), else null. Never the request's reason: the asker's own
       * words are read in SignForge, beside the drafts. `url` is where to see it in the CMS.
       */
      data: {
        request: { id: string; url: string | null; drafts: number; expiresAt: string };
        by: { kind: 'user' | 'agent'; id: string; name: string | null };
      };
    }
  | { type: 'test'; data: { message: string } }
);

/** Slack's incoming-webhook URL (docs.slack.dev, Sending messages using incoming webhooks, read 2026-11-18). */
const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/;

const slackWebhookUrl = z
  .string()
  .max(2048)
  .regex(SLACK_WEBHOOK, 'a Slack incoming-webhook URL, https://hooks.slack.com/services/T…/B…/…')
  .describe("The incoming webhook's URL from Slack, https://hooks.slack.com/services/T…/B…/…. Stored encrypted and never shown again");

const URL_PROBLEMS: Record<FeedUrlProblem, string> = {
  'bad-url': 'not a URL',
  'not-https': 'webhooks must be https',
  port: 'webhooks must use the default https port',
  'ip-literal': 'webhooks must name a host, not an IP address',
  'private-address': 'the host is a local name',
};

/** The fetch-safety rules of feed URLs (`@signforge/feeds`); the delivery run checks the address it resolves to as well. */
const outgoingUrl = z
  .string()
  .max(2048)
  .superRefine((url, ctx) => {
    const problem = feedUrlProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', message: URL_PROBLEMS[problem] });
  })
  .describe('Where to POST alerts: https, on the default port, naming a public host. Stored encrypted and never shown again');

const signingSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, '32 to 128 characters of A-Z, a-z, 0-9, _ and -')
  .describe(
    'The secret each POST is signed with, which you make and keep: 32 to 128 random characters of A-Z, a-z, 0-9, _ and -, such as whsec_ and 32 random bytes in base64url. Stored encrypted and never shown again',
  );

const viewOf = (c: AlertChannelRow): z.infer<typeof channelView> => ({
  kind: c.kind,
  host: c.host,
  connectedBy: c.connectedBy,
  secretSetAt: c.secretSetAt,
  version: c.rowVersion,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const deliveryOf = (d: AlertDeliveryRow): z.infer<typeof deliveryView> => ({
  id: d.id,
  channel: d.channel,
  eventType: d.eventType,
  eventId: d.eventId,
  status: d.status,
  attempts: d.attempts,
  lastAttemptAt: d.lastAttemptAt,
  lastHttpStatus: d.lastHttpStatus,
  lastError: d.lastError,
  nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt : null,
  createdAt: d.createdAt,
});

const channelTarget = (kind: string) => ({ kind: 'alert_channel', id: kind });

const getAlertChannels = defineTool({
  name: 'get_alert_channels',
  description:
    "Read where the organization's alerts go besides email: its Slack channel and its outgoing webhook, each null if not set. Shows each one's host, never its URL or secret. Returns { slack, webhook }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({}),
  output: outputs.get_alert_channels,
  example: {},
  handler: async ({ org }) => {
    const [slack, webhook] = await Promise.all([org.alertChannels.get('slack'), org.alertChannels.get('webhook')]);
    return { slack: slack ? viewOf(slack) : null, webhook: webhook ? viewOf(webhook) : null };
  },
});

const setAlertChannel = defineTool({
  name: 'set_alert_channel',
  description:
    "Send the organization's alerts to a channel besides email; owners only. kind slack: a Slack channel, through an incoming webhook made in Slack for it (webhookUrl); it replaces the one set before. kind webhook: an outgoing webhook, each alert POSTed as JSON ({ type, id, occurredAt, org, data }) signed with HMAC-SHA256 under your signing secret, and retried for up to 24 hours while it fails; a new one needs webhookUrl and signingSecret, and afterwards either changes it alone (a new signingSecret rotates it). Secrets are never shown again. Which alerts go to each is each alert rule's (update_org_settings). Pass the version you read as ifVersion to change only that one. Returns { channel }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  // Where alerts go is a person's (review of #419): an agent could silence or redirect every alert, its own refusals' included.
  people: true,
  needs: ['alertSecrets'],
  input: z
    .strictObject({
      kind: z.enum(ALERT_CHANNEL_KINDS),
      webhookUrl: z.string().max(2048).optional().describe("slack: the incoming webhook's URL; webhook: the URL alerts are POSTed to"),
      signingSecret: signingSecret.optional(),
      ifVersion,
    })
    .superRefine((v, ctx) => {
      if (v.kind === 'slack' && v.signingSecret !== undefined)
        ctx.addIssue({ code: 'custom', path: ['signingSecret'], message: 'a Slack channel takes no signing secret' });
      if (v.kind === 'slack' && v.webhookUrl === undefined)
        ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: 'a Slack channel needs its webhookUrl' });
      if (v.kind === 'webhook' && v.webhookUrl === undefined && v.signingSecret === undefined) ctx.addIssue({ code: 'custom', message: 'nothing to change' });
      if (v.webhookUrl === undefined) return;
      // Each kind's own rules for its URL: Slack's host, or a public https address.
      const checked = (v.kind === 'slack' ? slackWebhookUrl : outgoingUrl).safeParse(v.webhookUrl);
      for (const issue of checked.error?.issues ?? []) ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: issue.message });
    }),
  output: outputs.set_alert_channel,
  example: { kind: 'webhook', webhookUrl: 'https://ops.example.com/hooks/signforge', signingSecret: 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD' },
  target: (input) => channelTarget(input.kind),
  handler: async ({ org, actor, input, write, services: { alertSecrets } }) => {
    const { kind } = input;
    const seal = (field: 'url' | 'secret', value: string) => alertSecrets.seal({ orgId: org.orgId, kind }, field, value);
    const current = kind === 'webhook' ? await org.alertChannels.get('webhook') : undefined;
    const url = input.webhookUrl ? { host: new URL(input.webhookUrl).hostname, urlEncrypted: await seal('url', input.webhookUrl) } : current;
    const secret =
      kind === 'slack'
        ? { secretEncrypted: null, secretSetAt: null }
        : input.signingSecret
          ? { secretEncrypted: await seal('secret', input.signingSecret), secretSetAt: Date.now() }
          : current;
    if (!url || (kind === 'webhook' && !secret?.secretEncrypted)) throw new ToolError('invalid_input', 'a new webhook needs both webhookUrl and signingSecret');
    const row = write(
      await org.alertChannels.stage.put(
        kind,
        {
          host: url.host,
          urlEncrypted: url.urlEncrypted,
          secretEncrypted: secret?.secretEncrypted ?? null,
          secretSetAt: secret?.secretSetAt ?? null,
          connectedBy: actor.id,
        },
        input.ifVersion,
      ),
    );
    return { channel: viewOf(row) };
  },
});

const removeAlertChannel = defineTool({
  name: 'remove_alert_channel',
  description:
    'Stop sending alerts to the Slack channel or the webhook, and forget its URL and secret; owners only. Deliveries still queued for it fail. Returns { removed }: false if none was set.',
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  // Where alerts go is a person's (review of #419): an agent could silence or redirect every alert, its own refusals' included.
  people: true,
  input: z.object({ channel: z.enum(ALERT_CHANNEL_KINDS) }),
  output: outputs.remove_alert_channel,
  example: { channel: 'slack' },
  target: (input) => channelTarget(input.channel),
  handler: async ({ org, input, write }) => {
    if (!(await org.alertChannels.get(input.channel))) return { removed: false };
    write(org.alertChannels.stage.remove(input.channel));
    return { removed: true };
  },
});

const testAlertChannel = defineTool({
  name: 'test_alert_channel',
  description:
    'Send a test alert, now, to the Slack channel, the webhook, or by email to you; owners only. It is tried once, and shows in the delivery log (list_alert_deliveries) with how it went. Returns { delivery }.',
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  // Where alerts go is a person's (review of #419): an agent could silence or redirect every alert, its own refusals' included.
  people: true,
  input: z.object({ channel: z.enum(ALERT_CHANNELS).describe('email goes to the member who asks') }),
  output: outputs.test_alert_channel,
  example: { channel: 'email' },
  target: (input) => channelTarget(input.channel),
  handler: async ({ org, actor, input, write, deliverNow }) => {
    if (input.channel === 'email') {
      if (actor.kind !== 'user') throw new ToolError('invalid_input', 'an email test goes to the member who asks; test slack or webhook');
    } else if (!(await org.alertChannels.get(input.channel))) throw new ToolError('conflict', `no ${input.channel} channel is set`);
    const now = Date.now();
    const event: AlertEvent = {
      type: 'test',
      id: newId('evt'),
      occurredAt: new Date(now).toISOString(),
      org: { id: org.orgId, name: await org.name() },
      data: { message: 'A test from SignForge: alerts reach this channel.' },
    };
    const row = write(
      org.alertDeliveries.stage.insert({
        channel: input.channel,
        eventId: event.id,
        eventType: event.type,
        eventJson: JSON.stringify(event),
        toUserId: input.channel === 'email' ? actor.id : null,
        nextAttemptAt: now,
        // Tried once: a test says how the channel answers now.
        giveUpAt: now,
      }),
    );
    deliverNow(row.id);
    return { delivery: deliveryOf(row) };
  },
});

const listAlertDeliveries = defineTool({
  name: 'list_alert_deliveries',
  description:
    'List the alerts sent to Slack, the webhook and test sends in the last 7 days, newest first, a page at a time: each with its status, attempts, and the HTTP status of the last one. Returns { deliveries, next }.',
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: outputs.list_alert_deliveries,
  example: {},
  handler: async ({ org, input }) => {
    const { rows, next } = await keysetPage(
      input,
      (after, take) => org.alertDeliveries.list({ after, take }),
      (d) => [d.createdAt, d.id],
    );
    return { deliveries: rows.map(deliveryOf), next };
  },
});

const retryAlertDelivery = defineTool({
  name: 'retry_alert_delivery',
  description:
    'Try a pending or failed delivery again now, rather than at its next retry; one given up on gets one more try. Refused while an attempt is being sent. Owners only. Returns { delivery }.',
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  // Where alerts go is a person's (review of #419): an agent could silence or redirect every alert, its own refusals' included.
  people: true,
  input: z.object({ alertDeliveryId: id('alert delivery') }),
  output: outputs.retry_alert_delivery,
  example: { alertDeliveryId: 'dlv_0123456789' },
  target: (input) => ({ kind: 'alert_delivery', id: input.alertDeliveryId }),
  handler: async ({ org, input, write, deliverNow }) => {
    const current = await org.alertDeliveries.get(input.alertDeliveryId);
    if (!current) throw notFound('alert delivery', input.alertDeliveryId);
    if (current.status === 'delivered') throw new ToolError('conflict', `alert delivery ${current.id} was delivered`);
    const now = Date.now();
    // A retry now would send it a second time beside the attempt under way, whose answer is still to come.
    if (current.leasedUntil !== null && current.leasedUntil > now)
      throw new ToolError('conflict', `alert delivery ${current.id} is being sent now; see how it went before retrying`);
    const row = write(org.alertDeliveries.stage.retry(current, now));
    deliverNow(row.id);
    return { delivery: deliveryOf(row) };
  },
});

export const alertChannelTools = [getAlertChannels, setAlertChannel, removeAlertChannel, testAlertChannel, listAlertDeliveries, retryAlertDelivery];
