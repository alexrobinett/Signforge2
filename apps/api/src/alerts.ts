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
import { findAlertWork, findFinishedRollouts, orgMembers, scoped } from '@signforge/db';
import { ALERT_RETRY_MS, type AlertEvent, orgSettings, UNREACHABLE_AFTER_MS, type Audience } from '@signforge/tools';
import type { EmailMessage, EmailSender } from './email';

const AUDIENCE_ROLES: Record<Audience, readonly string[]> = {
  owners: ['owner'],
  editors: ['owner', 'editor'],
  everyone: ['owner', 'editor', 'viewer'],
};

interface OrgContext {
  recipients: string[];
  /** The channels besides email the rule sends to, of those the org has set. */
  channels: ('slack' | 'webhook')[];
  time: (ms: number) => string;
}

/** The alerts these checks send, by the org setting's rule name. */
type CheckedAlert = 'screen_offline' | 'publish_finished';

async function orgContext(db: D1Database, orgId: string, kind: CheckedAlert): Promise<OrgContext> {
  const org = scoped(db, orgId);
  const [settings, members, set] = await Promise.all([orgSettings(org), orgMembers(db, orgId), org.alertChannels.list()]);
  const rule = settings.alerts[kind];
  const roles = AUDIENCE_ROLES[rule.who];
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

export async function checkScreenAlerts(env: Pick<Env, 'DB' | 'CMS_ORIGIN'>, email: EmailSender, now: number): Promise<void> {
  const work = await findAlertWork(env.DB, now, UNREACHABLE_AFTER_MS);
  const contextFor = contexts(env.DB, 'screen_offline');
  // Without CMS_ORIGIN the API does not know where the CMS is (dev, or one origin for both), so alerts carry no link.
  const screenOf = (s: { screenId: string; screenName: string }) => ({
    id: s.screenId,
    name: s.screenName,
    url: env.CMS_ORIGIN ? `${env.CMS_ORIGIN}/screens/${s.screenId}` : null,
  });

  for (const s of work.offline) {
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
  for (const s of work.back) {
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
 * Mark finished every publish whose rollout is over: each screen it switched plays it, or a later
 * publish moved it on. The mark and its `publish.finished` event are written in one batch, by the
 * check that made the mark, so the alert goes once; the email follows. A publish no screen played
 * (none switched, or undone before any got there) is marked with no alert: it reached nobody.
 */
export async function finishRollouts(env: Pick<Env, 'DB' | 'CMS_ORIGIN'>, email: EmailSender, now: number): Promise<void> {
  const contextFor = contexts(env.DB, 'publish_finished');
  for (const p of await findFinishedRollouts(env.DB)) {
    const org = scoped(env.DB, p.orgId);
    if (!p.playing) {
      await org.publishes.finish(p.id, now);
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
        screens: p.screens,
        playing: p.playing,
        replaced: p.replaced,
      },
    });
    const marked = await orAlone(
      () => org.publishes.finish(p.id, now, finished),
      () => org.publishes.finish(p.id, now),
    );
    if (!marked) continue;
    const every = p.playing === p.screens;
    const where = every ? (p.screens === 1 ? 'its screen' : `all ${p.screens} screens it changed`) : `${p.playing} of the ${p.screens} screens it changed`;
    const others = [
      p.replaced && `a later publish reached ${p.replaced} first`,
      p.screens - p.playing - p.replaced && `${p.screens - p.playing - p.replaced} revoked`,
    ].filter(Boolean);
    await sendAll(email, recipients, {
      subject: every ? `v${p.revision} reached every screen` : `v${p.revision} finished, playing on ${p.playing} of ${p.screens} screens`,
      text:
        `v${p.revision} in ${p.orgName}, published ${time(p.createdAt)}, is now playing on ${where}${others.length ? ` (${others.join('; ')})` : ''}.\n\n` +
        `Who gets these is in Settings, Notifications.`,
    });
  }
}
