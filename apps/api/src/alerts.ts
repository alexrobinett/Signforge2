/**
 * Offline and rollout alerts (M3-42, M3-18), run by the Cron Trigger every 5 minutes, the screens' sync interval.
 * A screen unheard from past its org's threshold opens an incident, emails the members the org's
 * `screen_offline` rule names, and queues a `screen.offline` event for the Slack channel and the
 * webhook if the rule sends it there (#88); the screen's next sync clears it, with one more of
 * each (`screen.back`). The incident row and its queued events are written in one batch, and only
 * by the check that wrote the incident, so an alert is sent at most once per incident however the
 * runs overlap; the email follows. Queued events are sent by ./deliveries.ts, after this check, so
 * a slow receiver never holds it up. A publish whose every screen plays it, or moved on, is marked
 * finished the same way, with a `publish.finished` event and an email to whom the org's
 * `publish_finished` rule names (`finishRollouts`).
 */
import { findAlertWork, findUnfinishedRollouts, orgMembers, scoped } from '@signforge/db';
import { ALERT_RETRY_MS, type AlertEvent, AUDIENCE_ROLES, grantClient, orgSettings, tally, UNREACHABLE_AFTER_MS } from '@signforge/tools';
import { agentName } from './deliveries';
import type { EmailMessage, EmailSender } from './email';

interface OrgContext {
  recipients: string[];
  /** The channels besides email the rule sends to, of those the org has set. */
  channels: ('slack' | 'webhook')[];
  time: (ms: number) => string;
}

/** The alerts sent here, by the org setting's rule name. */
type CheckedAlert = 'screen_offline' | 'publish_finished' | 'agent_refused';

async function orgContext(db: D1Database, orgId: string, kind: CheckedAlert): Promise<OrgContext> {
  const org = scoped(db, orgId);
  const [settings, members, set] = await Promise.all([orgSettings(org), orgMembers(db, orgId), org.alertChannels.list()]);
  const rule = settings.alerts[kind];
  const roles: readonly string[] = AUDIENCE_ROLES[rule.who];
  const format = new Intl.DateTimeFormat(settings.locale ?? 'en-US', {
    timeZone: settings.timezone ?? 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return {
    recipients: rule.email ? members.filter((m) => roles.includes(m.role)).map((m) => m.email) : [],
    channels: set.map((c) => c.kind).filter((kind) => rule[kind]),
    time: (ms) => format.format(ms),
  };
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m === 1 ? '1 minute' : `${m} minutes`;
};

async function sendAll(email: EmailSender, to: string[], message: Omit<EmailMessage, 'to'>) {
  const sent = await Promise.allSettled(to.map((addr) => email.send({ ...message, to: addr })));
  for (const r of sent) if (r.status === 'rejected') console.error('alert email failed', r.reason);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Each org's context for one kind of alert, read once per run. */
function contexts(db: D1Database, kind: CheckedAlert) {
  const read = new Map<string, Promise<OrgContext>>();
  return (orgId: string) => {
    let c = read.get(orgId);
    if (!c) read.set(orgId, (c = orgContext(db, orgId, kind)));
    return c;
  };
}

const alertOf = (now: number, channels: OrgContext['channels'], event: AlertEvent) => ({
  event: { id: event.id, type: event.type, json: JSON.stringify(event) },
  channels,
  giveUpAt: now + ALERT_RETRY_MS,
});

/**
 * A write with its alert queued in the same batch; if that batch fails, the write alone, so the
 * email still goes once and later checks do not alert again. Slack and the webhook miss that
 * alert, which is logged.
 */
async function orAlone<T>(withAlert: () => Promise<T>, alone: () => Promise<T>): Promise<T> {
  try {
    return await withAlert();
  } catch (err) {
    console.error('alert deliveries could not be queued: sending the email only', err);
    return alone();
  }
}

export async function checkScreenAlerts(env: Pick<Env, 'DB' | 'CMS_ORIGIN'>, email: EmailSender, now: number, limit = Infinity): Promise<void> {
  const work = await findAlertWork(env.DB, now, UNREACHABLE_AFTER_MS);
  const contextFor = contexts(env.DB, 'screen_offline');
  // Without CMS_ORIGIN the API does not know where the CMS is (dev, or one origin for both), so alerts carry no link.
  const screenOf = (s: { screenId: string; screenName: string }) => ({
    id: s.screenId,
    name: s.screenName,
    url: env.CMS_ORIGIN ? `${env.CMS_ORIGIN}/screens/${s.screenId}` : null,
  });

  const offlineWork = work.offline.slice(0, limit);
  for (const s of offlineWork) {
    const org = scoped(env.DB, s.orgId);
    const { recipients, channels, time } = await contextFor(s.orgId);
    const offline = (incidentId: string): AlertEvent => ({
      type: 'screen.offline',
      id: `evt_${incidentId}_offline`,
      occurredAt: iso(now),
      org: { id: s.orgId, name: s.orgName },
      data: { screen: screenOf(s), lastSeenAt: iso(s.lastSeenAt) },
    });
    const incidentId = await orAlone(
      () => org.incidents.open(s.screenId, s.lastSeenAt, now, (id) => alertOf(now, channels, offline(id))),
      () => org.incidents.open(s.screenId, s.lastSeenAt, now),
    );
    if (!incidentId) continue;
    await sendAll(email, recipients, {
      subject: `${s.screenName} is offline`,
      text:
        `${s.screenName} in ${s.orgName} has not been heard from since ${time(s.lastSeenAt)}, ${minutes(now - s.lastSeenAt)} ago. ` +
        `It keeps playing what it has until it reconnects.\n\n` +
        `You will get one more email when it is back. Who gets these is in Settings, Notifications.`,
    });
  }
  for (const s of work.back.slice(0, limit - offlineWork.length)) {
    const org = scoped(env.DB, s.orgId);
    const { recipients, channels, time } = await contextFor(s.orgId);
    const back = alertOf(now, channels, {
      type: 'screen.back',
      id: `evt_${s.incidentId}_back`,
      occurredAt: iso(now),
      org: { id: s.orgId, name: s.orgName },
      data: { screen: screenOf(s), lastSeenAt: iso(s.lastSeenAt), offlineSince: iso(s.since) },
    });
    const cleared = await orAlone(
      () => org.incidents.clear(s.incidentId, now, back),
      () => org.incidents.clear(s.incidentId, now),
    );
    if (!cleared) continue;
    await sendAll(email, recipients, {
      subject: `${s.screenName} is back`,
      text: `${s.screenName} in ${s.orgName} is back at ${time(s.lastSeenAt)}, after ${minutes(s.lastSeenAt - s.since)} without a heartbeat.`,
    });
  }
}

/**
 * Mark finished every publish whose rollout is over (`tally` in @signforge/tools: every screen it
 * switched plays it, moved on, or is revoked). The mark and its `publish.finished` event are
 * written in one batch, by the check that made the mark, so the alert goes once; the email
 * follows. A publish this check sees no screen playing (none switched, or replaced before any
 * check saw a screen report it, which includes one played and replaced between two checks) is
 * marked with no alert.
 */
export async function finishRollouts(env: Pick<Env, 'DB' | 'CMS_ORIGIN'>, email: EmailSender, now: number, limit = Infinity): Promise<void> {
  const contextFor = contexts(env.DB, 'publish_finished');
  let remaining = limit;
  for (const p of await findUnfinishedRollouts(env.DB)) {
    const { screens, playing, replaced, revoked, open } = tally(p.rollout);
    if (open) continue;
    if (remaining-- <= 0) break;
    const org = scoped(env.DB, p.orgId);
    if (!playing) {
      await org.publishes.finish(p.id, now, playing);
      continue;
    }
    const { recipients, channels, time } = await contextFor(p.orgId);
    const finished = alertOf(now, channels, {
      type: 'publish.finished',
      id: `evt_${p.id}_finished`,
      occurredAt: iso(now),
      org: { id: p.orgId, name: p.orgName },
      data: {
        publish: { id: p.id, revision: p.revision, url: env.CMS_ORIGIN ? `${env.CMS_ORIGIN}/publishes?id=${p.id}` : null, publishedAt: iso(p.createdAt) },
        screens,
        playing,
        replaced,
      },
    });
    const marked = await orAlone(
      () => org.publishes.finish(p.id, now, playing, finished),
      () => org.publishes.finish(p.id, now, playing),
    );
    if (!marked) continue;
    const every = playing === screens;
    const where = every ? (screens === 1 ? 'its screen' : `all ${screens} screens it changed`) : `${playing} of the ${screens} screens it changed`;
    const others = [replaced && `a later publish reached ${replaced} first`, revoked && `${revoked} revoked`].filter(Boolean);
    await sendAll(email, recipients, {
      subject: every ? `v${p.revision} reached every screen` : `v${p.revision} finished, playing on ${playing} of ${screens} screens`,
      text:
        `v${p.revision} in ${p.orgName}, published ${time(p.createdAt)}, is now playing on ${where}${others.length ? ` (${others.join('; ')})` : ''}.\n\n` +
        `Who gets these is in Settings, Notifications.`,
    });
  }
}

/**
 * An agent refused `forbidden` again and again within the hour (M4-08): an `agent.refused` event
 * for the channels and an email to whom the org's `agent_refused` rule names. The grant's object
 * says once an hour that it is due (`refused`), and the event's id is the grant's and the hour's,
 * so a channel is sent it once however the calls race. The client is named as a page names it.
 */
export async function alertAgentRefused(
  env: Pick<Env, 'DB' | 'CMS_ORIGIN'>,
  email: EmailSender,
  refused: { orgId: string; grantId: string; tool: string; needs: string | null; refusals: number; hour: number },
  now: number,
): Promise<void> {
  const org = scoped(env.DB, refused.orgId);
  const [[connected], name] = await Promise.all([org.agentGrants.connected({ grantId: refused.grantId }), org.name()]);
  // Revoked since: nobody to tell about it.
  if (!connected) return;
  const { grant } = connected;
  const client = grantClient(connected);
  const { recipients, channels } = await orgContext(env.DB, refused.orgId, 'agent_refused');
  const url = env.CMS_ORIGIN ? `${env.CMS_ORIGIN}/settings/api/${grant.id}` : null;
  await org.alertDeliveries.queue(
    alertOf(now, channels, {
      type: 'agent.refused',
      id: `evt_agent_refused_${grant.id}_${refused.hour}`,
      occurredAt: iso(now),
      org: { id: refused.orgId, name },
      data: {
        grant: { id: grant.id, url, client: { id: client.id, name: client.name } },
        refusals: refused.refusals,
        tool: refused.tool,
        needs: refused.needs,
      },
    }),
    now,
  );
  const who = agentName(client);
  await sendAll(email, recipients, {
    subject: `${who} was refused ${refused.refusals} times this hour`,
    text:
      `${who} in ${name} was refused ${refused.refusals} times this hour, most recently calling ${refused.tool}` +
      `${refused.needs ? `, which needs ${refused.needs}` : ''}. It may be misconfigured or misled.\n\n` +
      `${url ? `See it, change its scopes or disconnect it: ${url}\n\n` : ''}Who gets these is in Settings, Notifications.`,
  });
}
