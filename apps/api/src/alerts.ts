/**
 * Offline alerts (M3-42), run by the Cron Trigger every 5 minutes, the screens' sync interval.
 * A screen unheard from past its org's threshold opens an incident and emails the members the
 * org's `screen_offline` rule names; the screen's next sync clears it, with one more email. The
 * incident row is written before the email, and only by the check that wrote it, so an alert is
 * sent at most once per incident however the runs overlap.
 */
import { findAlertWork, orgMembers, scoped } from '@signforge/db';
import { orgSettings, UNREACHABLE_AFTER_MS, type Audience } from '@signforge/tools';
import type { EmailMessage, EmailSender } from './email';

const AUDIENCE_ROLES: Record<Audience, readonly string[]> = {
  owners: ['owner'],
  editors: ['owner', 'editor'],
  everyone: ['owner', 'editor', 'viewer'],
};

interface OrgContext {
  recipients: string[];
  time: (ms: number) => string;
}

async function orgContext(db: D1Database, orgId: string): Promise<OrgContext> {
  const [settings, members] = await Promise.all([orgSettings(scoped(db, orgId)), orgMembers(db, orgId)]);
  const rule = settings.alerts.screen_offline;
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

export async function checkScreenAlerts(env: Pick<Env, 'DB'>, email: EmailSender, now: number): Promise<void> {
  const work = await findAlertWork(env.DB, now, UNREACHABLE_AFTER_MS);
  const contexts = new Map<string, Promise<OrgContext>>();
  const contextFor = (orgId: string) => {
    let c = contexts.get(orgId);
    if (!c) contexts.set(orgId, (c = orgContext(env.DB, orgId)));
    return c;
  };

  for (const s of work.offline) {
    if (!(await scoped(env.DB, s.orgId).incidents.open(s.screenId, s.lastSeenAt, now))) continue;
    const { recipients, time } = await contextFor(s.orgId);
    await sendAll(email, recipients, {
      subject: `${s.screenName} is offline`,
      text:
        `${s.screenName} in ${s.orgName} has not been heard from since ${time(s.lastSeenAt)}, ${minutes(now - s.lastSeenAt)} ago. ` +
        `It keeps playing what it has until it reconnects.\n\n` +
        `You will get one more email when it is back. Who gets these is in Settings, Notifications.`,
    });
  }
  for (const s of work.back) {
    if (!(await scoped(env.DB, s.orgId).incidents.clear(s.incidentId, now))) continue;
    const { recipients, time } = await contextFor(s.orgId);
    await sendAll(email, recipients, {
      subject: `${s.screenName} is back`,
      text: `${s.screenName} in ${s.orgName} is back at ${time(s.lastSeenAt)}, after ${minutes(s.lastSeenAt - s.since)} without a heartbeat.`,
    });
  }
}
