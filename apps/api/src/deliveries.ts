/**
 * Alert deliveries (#88): the alerts queued for Slack and the outgoing webhook, and test sends.
 * The five-minute Cron Trigger runs `deliverAlerts` once the alert check has queued its alerts, so
 * a slow or failing receiver never holds the check up; a test send or a retry from Settings goes at
 * once (`deliverAlert`, after the tool call's response).
 *
 * Each attempt is claimed first, so overlapping runs send it once. A failure is tried again after
 * 5 minutes, doubling up to 2 hours between tries, until 24 hours after the alert (`giveUpAt`),
 * then given up on; a test is tried once. Every POST goes through the fetch guards (./data/fetch.ts).
 *
 * Slack: an incoming webhook's message, in Block Kit (docs.slack.dev, Sending messages using
 * incoming webhooks and Formatting message text, read 2026-11-18). The webhook: the event as JSON,
 * signed as `SignForge-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<body>" under the secret>`
 * with `SignForge-Timestamp` in Unix seconds (packages/tools README, Alert channels).
 */
import {
  type AlertChannelRow,
  alertChannelsOf,
  type AlertDeliveryRow,
  type AttemptResult,
  claimDueAlertDeliveries,
  orgMembers,
  scoped,
  settleAlertDeliveries,
} from '@signforge/db';
import type { AlertEvent } from '@signforge/tools';
import { MissingKey, openAlertSecret } from './data/cipher';
import { dohResolver, FetchError, type FetchGuards, guardedPost } from './data/fetch';
import type { EmailSender } from './email';

/**
 * Deliveries per run. Each POST takes one fetch, and its host's DNS two more, once per run: 12 to
 * as many hosts is 36 of the Free plan's 50 fetches an invocation. Its D1 queries do not grow with
 * it: the claim, the channels and the settles are one each (`claimDueAlertDeliveries` in
 * packages/db), and an email test reads its org's members once. The rest wait for the next run.
 */
const DELIVERIES_PER_RUN = 12;
/** How long a claimed attempt is held: past one run's sends at 5 seconds each, and short of the next run. */
const LEASE_MS = 4 * 60_000;
const FIRST_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 2 * 3_600_000;

/** How long after its `attempts`th failed attempt a delivery is tried again. */
const retryDelay = (attempts: number) => Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);

/** A failure no retry can mend: the channel is gone, or what it holds no longer opens. */
class Undeliverable extends Error {
  constructor(readonly code: 'no-channel' | 'sealed-url' | 'no-member') {
    super(code);
  }
}

/** workerd's `fetch` throws "Illegal invocation" when called as a method of another object, so the guards get a bare function. */
const workerFetch: typeof fetch = (input, init) => fetch(input, init);
const workerGuards = (): FetchGuards => ({ fetch: workerFetch, resolve: dohResolver(workerFetch) });

type DeliveryEnv = Pick<Env, 'DB' | 'DATA_SOURCE_KEY' | 'ENVIRONMENT'>;

/** Where an attempt sends: the channel its delivery names, and for email the org's members. */
interface Reach {
  channel: (orgId: string, kind: AlertChannelRow['kind']) => AlertChannelRow | undefined;
  members: (orgId: string) => Promise<{ userId: string; email: string }[]>;
}

/** The org's members, read once per run or call. */
function membersOnce(db: D1Database): Reach['members'] {
  const read = new Map<string, Promise<{ userId: string; email: string }[]>>();
  return (orgId) => {
    let m = read.get(orgId);
    if (!m) read.set(orgId, (m = orgMembers(db, orgId)));
    return m;
  };
}

/**
 * Send what is due at `now`, one at a time, so one receiver at a time sees SignForge and Slack's
 * one message a second holds; then record every attempt in one batch. A run that dies before that
 * leaves its attempts claimed, and the next run after the lease sends them again.
 */
export async function deliverAlerts(env: DeliveryEnv, email: EmailSender, { now, guards = workerGuards() }: { now: number; guards?: FetchGuards }) {
  const claimed = await claimDueAlertDeliveries(env.DB, now, { limit: DELIVERIES_PER_RUN, leaseMs: LEASE_MS });
  if (!claimed.length) return;
  const channels = await alertChannelsOf(env.DB, claimed);
  const reach: Reach = { channel: (orgId, kind) => channels.find((c) => c.orgId === orgId && c.kind === kind), members: membersOnce(env.DB) };
  // One lookup per host per run: most deliveries go to hooks.slack.com.
  const lookups = new Map<string, Promise<string[]>>();
  const resolve: FetchGuards['resolve'] = (host, signal) => {
    let found = lookups.get(host);
    if (!found) lookups.set(host, (found = guards.resolve(host, signal)));
    return found;
  };
  const settled: { orgId: string; id: string; attempt: number; result: AttemptResult }[] = [];
  const failed: unknown[] = [];
  for (const row of claimed) {
    await attempt(env, email, { ...guards, resolve }, reach, row, now).then(
      (result) => settled.push({ orgId: row.orgId, id: row.id, attempt: row.attempts, result }),
      (e: unknown) => failed.push(e),
    );
  }
  await settleAlertDeliveries(env.DB, now, settled);
  if (failed.length) throw new AggregateError(failed, 'alert deliveries failed');
}

/** Send one delivery now, if it is due and no run holds it: a test send or a retry. */
export async function deliverAlert(env: DeliveryEnv, email: EmailSender, orgId: string, id: string, { now = Date.now(), guards = workerGuards() } = {}) {
  const org = scoped(env.DB, orgId);
  const row = await org.alertDeliveries.claim(id, now, LEASE_MS);
  if (!row) return;
  const channel = row.channel === 'email' ? undefined : await org.alertChannels.get(row.channel);
  const reach: Reach = { channel: () => channel, members: membersOnce(env.DB) };
  await org.alertDeliveries.settle(row.id, row.attempts, now, await attempt(env, email, guards, reach, row, now));
}

/** One claimed attempt, and what it came to. A bug (anything but a failed send) is thrown, and the attempt is retried once its lease ends. */
async function attempt(env: DeliveryEnv, email: EmailSender, guards: FetchGuards, reach: Reach, row: AlertDeliveryRow, now: number): Promise<AttemptResult> {
  const event: AlertEvent = JSON.parse(row.eventJson);
  try {
    return { ok: true, httpStatus: await send(env, email, guards, reach, row, event) };
  } catch (e) {
    const failure =
      e instanceof Undeliverable
        ? { error: e.code, httpStatus: null, final: true }
        : e instanceof FetchError
          ? { error: e.code, httpStatus: e.status ?? null, final: false }
          : e instanceof MissingKey
            ? { error: 'no-key', httpStatus: null, final: false }
            : row.channel === 'email'
              ? { error: 'email', httpStatus: null, final: false }
              : undefined;
    if (!failure) throw e;
    const retryAt = now + retryDelay(row.attempts);
    return { ok: false, httpStatus: failure.httpStatus, error: failure.error, ...(failure.final || retryAt > row.giveUpAt ? {} : { retryAt }) };
  }
}

/** Send it on its channel; the receiver's HTTP status, or null for email. */
async function send(env: DeliveryEnv, email: EmailSender, guards: FetchGuards, reach: Reach, row: AlertDeliveryRow, event: AlertEvent): Promise<number | null> {
  if (row.channel === 'email') {
    const member = (await reach.members(row.orgId)).find((m) => m.userId === row.toUserId);
    if (!member) throw new Undeliverable('no-member');
    await email.send({ to: member.email, subject: `SignForge: ${summary(event)}`, text: summary(event) });
    return null;
  }
  const channel = reach.channel(row.orgId, row.channel);
  if (!channel) throw new Undeliverable('no-channel');
  const where = { orgId: row.orgId, kind: channel.kind };
  const url = await openAlertSecret(env, where, 'url', channel.urlEncrypted);
  if (!url) throw new Undeliverable('sealed-url');
  const headers = new Headers({ 'content-type': 'application/json', 'user-agent': 'SignForge alerts' });
  if (channel.kind === 'slack') return guardedPost(url, JSON.stringify(slackMessage(event)), headers, guards);

  const secret = channel.secretEncrypted && (await openAlertSecret(env, where, 'secret', channel.secretEncrypted));
  if (!secret) throw new Undeliverable('sealed-url');
  // The time it is sent, not the run's: a receiver refuses an old timestamp, and the event's own time is in the body.
  const timestamp = String(Math.floor(Date.now() / 1000));
  headers.set('signforge-event-id', event.id);
  headers.set('signforge-timestamp', timestamp);
  headers.set('signforge-signature', `v1=${await hmacHex(secret, `${timestamp}.${row.eventJson}`)}`);
  return guardedPost(url, row.eventJson, headers, guards);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One line for an email subject and Slack's notification text. */
function summary(event: AlertEvent): string {
  switch (event.type) {
    case 'screen.offline':
      return `${event.data.screen.name} in ${event.org.name} is offline`;
    case 'screen.back':
      return `${event.data.screen.name} in ${event.org.name} is back`;
    case 'publish.finished': {
      const { publish, screens, playing } = event.data;
      return playing === screens
        ? `v${publish.revision} reached every screen in ${event.org.name}`
        : `v${publish.revision} finished in ${event.org.name}: playing on ${playing} of ${screens} screens`;
    }
    case 'agent.refused':
      return `${agentName(event.data.grant.client)} in ${event.org.name} was refused ${event.data.refusals} times this hour`;
    case 'test':
      return event.data.message;
  }
}

/** An agent's client as an alert names it: its name when a page may show it (`shownClient`), else not at all. */
export const agentName = (client: { name: string | null }) => (client.name === null ? 'An unverified agent' : `The agent “${client.name}”`);

/** `&`, `<` and `>` are Slack's control characters: names are escaped, as the docs ask. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A time each reader sees in their own time zone, with the UTC time for clients that cannot. */
const slackTime = (iso: string) => `<!date^${Math.floor(Date.parse(iso) / 1000)}^{date_short_pretty} at {time}|${iso}>`;

const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });

/** The message for an incoming webhook: `text` for notifications, blocks for the channel. */
function slackMessage(event: AlertEvent) {
  const org = mrkdwn(`*Organization*\n${esc(event.org.name)}`);
  switch (event.type) {
    case 'test':
      return { text: esc(summary(event)), blocks: [{ type: 'section', text: mrkdwn(esc(event.data.message)), fields: [org] }] };
    case 'screen.offline':
    case 'screen.back': {
      const { screen } = event.data;
      const name = screen.url ? `<${screen.url}|${esc(screen.name)}>` : esc(screen.name);
      const state = event.type === 'screen.offline' ? `:red_circle: ${name} is *offline*` : `:large_green_circle: ${name} is *back*`;
      const since =
        event.type === 'screen.offline'
          ? mrkdwn(`*Last heard from*\n${slackTime(event.data.lastSeenAt)}`)
          : mrkdwn(`*Offline from*\n${slackTime(event.data.offlineSince)} to ${slackTime(event.data.lastSeenAt)}`);
      const blocks: object[] = [{ type: 'section', text: mrkdwn(state), fields: [org, since] }];
      if (screen.url) blocks.push({ type: 'context', elements: [mrkdwn(`<${screen.url}|Open the screen in SignForge>`)] });
      return { text: esc(summary(event)), blocks };
    }
    case 'publish.finished': {
      const { publish, screens, playing, replaced } = event.data;
      const v = `v${publish.revision}`;
      const name = publish.url ? `<${publish.url}|${v}>` : v;
      const reach = mrkdwn(
        `*Screens*\nPlaying on ${playing} of ${screens}${replaced ? `; a later publish reached ${replaced} first` : ''}${screens - playing - replaced ? `; ${screens - playing - replaced} revoked` : ''}`,
      );
      const at = mrkdwn(`*Published*\n${slackTime(publish.publishedAt)}`);
      const state = playing === screens ? `:white_check_mark: ${name} reached *every screen*` : `:white_check_mark: ${name} *finished*`;
      const blocks: object[] = [{ type: 'section', text: mrkdwn(state), fields: [org, reach, at] }];
      if (publish.url) blocks.push({ type: 'context', elements: [mrkdwn(`<${publish.url}|Open the rollout in SignForge>`)] });
      return { text: esc(summary(event)), blocks };
    }
    case 'agent.refused': {
      const { grant, refusals, tool, needs } = event.data;
      const state = `:no_entry: ${esc(agentName(grant.client))} was *refused* ${refusals} times this hour`;
      const latest = mrkdwn(`*Latest*\n${esc(tool)}${needs ? `, which needs ${esc(needs)}` : ''}`);
      const blocks: object[] = [{ type: 'section', text: mrkdwn(state), fields: [org, latest] }];
      if (grant.url) blocks.push({ type: 'context', elements: [mrkdwn(`<${grant.url}|Open the agent in SignForge>`)] });
      return { text: esc(summary(event)), blocks };
    }
  }
}
