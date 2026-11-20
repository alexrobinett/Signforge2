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
import { id, ifVersion, version } from './fields';
import { keysetPage, nextOutput, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';

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
  | { type: 'test'; data: { message: string } }
);

const KINDS = ['slack', 'webhook'] as const;
const CHANNELS = ['email', ...KINDS] as const;

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

const channelView = z.object({
  kind: z.enum(KINDS),
  host: z.string().describe('The host it posts to; the rest of the URL is sealed and never shown'),
  connectedBy: z.string().describe('Who set it last: a user id, or an agent grant id'),
  secretSetAt: z.number().nullable().describe('The webhook: when its signing secret was last set. Null for Slack'),
  version: version.describe('Moves on with every change; pass it as ifVersion to change only what you read'),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const viewOf = (c: AlertChannelRow): z.infer<typeof channelView> => ({
  kind: c.kind,
  host: c.host,
  connectedBy: c.connectedBy,
  secretSetAt: c.secretSetAt,
  version: c.rowVersion,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const deliveryView = z.object({
  id: z.string(),
  channel: z.enum(CHANNELS),
  eventType: z.string().describe('screen.offline, screen.back, or test'),
  eventId: z.string().describe("The event's id, the same on every channel it went to"),
  status: z.enum(['pending', 'delivered', 'failed']).describe('failed: given up on, after 24 hours of retries (a test, after one try)'),
  attempts: z.number(),
  lastAttemptAt: z.number().nullable(),
  lastHttpStatus: z.number().nullable().describe("The receiver's HTTP status on the last attempt; null for no answer, or for email"),
  lastError: z.string().nullable().describe('Why the last attempt failed, as a category (http-status, timeout, private-address, ...)'),
  nextAttemptAt: z.number().nullable().describe('When it is tried next, while pending'),
  createdAt: z.number(),
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
  output: z.object({ slack: channelView.nullable(), webhook: channelView.nullable() }),
  example: {},
  handler: async ({ org }) => {
    const [slack, webhook] = await Promise.all([org.alertChannels.get('slack'), org.alertChannels.get('webhook')]);
    return { slack: slack ? viewOf(slack) : null, webhook: webhook ? viewOf(webhook) : null };
  },
});

const setSlackAlertChannel = defineTool({
  name: 'set_slack_alert_channel',
  description:
    "Post the organization's alerts to a Slack channel, through an incoming webhook made in Slack for that channel; owners only. Replaces the one set before. Which alerts go there is each alert rule's slack (update_org_settings). Pass the version you read as ifVersion to replace only that one. Returns { channel }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['alertSecrets'],
  input: z.object({ webhookUrl: slackWebhookUrl, ifVersion }),
  output: z.object({ channel: channelView }),
  example: { webhookUrl: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX' },
  target: () => channelTarget('slack'),
  handler: async ({ org, actor, input, write, services: { alertSecrets } }) => {
    const urlEncrypted = await alertSecrets.seal({ orgId: org.orgId, kind: 'slack' }, 'url', input.webhookUrl);
    const row = write(
      await org.alertChannels.stage.put(
        'slack',
        { host: new URL(input.webhookUrl).hostname, urlEncrypted, secretEncrypted: null, secretSetAt: null, connectedBy: actor.id },
        input.ifVersion,
      ),
    );
    return { channel: viewOf(row) };
  },
});

const setWebhookAlertChannel = defineTool({
  name: 'set_webhook_alert_channel',
  description:
    "Send the organization's alerts to an outgoing webhook: each is POSTed as JSON ({ type, id, occurredAt, org, data }) signed with HMAC-SHA256 under your signing secret, and retried for up to 24 hours while it fails; owners only. A new webhook needs webhookUrl and signingSecret; afterwards give either to change it alone (a new signingSecret rotates it). The secret is never shown again. Pass the version you read as ifVersion to change only that one. Returns { channel }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['alertSecrets'],
  input: z
    .object({ webhookUrl: outgoingUrl.optional(), signingSecret: signingSecret.optional(), ifVersion })
    .refine((v) => v.webhookUrl !== undefined || v.signingSecret !== undefined, 'nothing to change'),
  output: z.object({ channel: channelView }),
  example: { webhookUrl: 'https://ops.example.com/hooks/signforge', signingSecret: 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD' },
  target: () => channelTarget('webhook'),
  handler: async ({ org, actor, input, write, services: { alertSecrets } }) => {
    const current = await org.alertChannels.get('webhook');
    const seal = (field: 'url' | 'secret', value: string) => alertSecrets.seal({ orgId: org.orgId, kind: 'webhook' }, field, value);
    const url = input.webhookUrl ? { host: new URL(input.webhookUrl).hostname, urlEncrypted: await seal('url', input.webhookUrl) } : current;
    const secret = input.signingSecret ? { secretEncrypted: await seal('secret', input.signingSecret), secretSetAt: Date.now() } : current;
    if (!url || !secret?.secretEncrypted) throw new ToolError('invalid_input', 'a new webhook needs both webhookUrl and signingSecret');
    const row = write(
      await org.alertChannels.stage.put(
        'webhook',
        { host: url.host, urlEncrypted: url.urlEncrypted, secretEncrypted: secret.secretEncrypted, secretSetAt: secret.secretSetAt, connectedBy: actor.id },
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
  input: z.object({ channel: z.enum(KINDS) }),
  output: z.object({ removed: z.boolean() }),
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
  input: z.object({ channel: z.enum(CHANNELS).describe('email goes to the member who asks') }),
  output: z.object({ delivery: deliveryView }),
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
  output: z.object({ deliveries: z.array(deliveryView), next: nextOutput }),
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
  input: z.object({ alertDeliveryId: id('alert delivery') }),
  output: z.object({ delivery: deliveryView }),
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

export const alertChannelTools = [
  getAlertChannels,
  setSlackAlertChannel,
  setWebhookAlertChannel,
  removeAlertChannel,
  testAlertChannel,
  listAlertDeliveries,
  retryAlertDelivery,
];
