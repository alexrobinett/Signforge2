// Offline alerts (M3-42): a screen silent past its org's threshold emails once, and once more when it is back.
import { scoped } from '@signforge/db';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { checkScreenAlerts } from '../src/alerts';
import { emailSenderFor, RecordingEmailSender } from '../src/email';
import worker from '../src/index';
import { Client, email, testApp } from './client';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function orgWithTeam() {
  const t = testApp();
  const owner = new Client(t);
  const addr = { owner: email('owner'), editor: email('editor'), viewer: email('viewer') };
  await owner.signIn(addr.owner);
  const org = await owner.createOrg('Northside');
  for (const role of ['editor', 'viewer'] as const) {
    const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: addr[role], role });
    const member = new Client(t);
    await member.signIn(addr[role]);
    await member.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
  }
  return { owner, org, addr };
}

async function pairedScreen(orgId: string, name: string, lastSeenAt: number, kind: 'device' | 'browser' = 'device') {
  const org = scoped(env.DB, orgId);
  const screen = await org.screens.insert({ name, timezone: 'UTC', orientation: 'landscape', lastSeenAt, kind });
  await org.screens.credentials.insert({ screenId: screen.id, secretHash: '0'.repeat(64) });
  return screen.id;
}

const to = (outbox: RecordingEmailSender, screen: string) => outbox.messages.filter((m) => m.subject.startsWith(screen));

describe('offline alerts', () => {
  it('emails owners and editors once when a screen goes past the threshold, and once when it is back', async () => {
    const { org, addr } = await orgWithTeam();
    const start = Date.now();
    const screenId = await pairedScreen(org.id, 'Lobby east', start);
    const outbox = new RecordingEmailSender();

    // Not yet: 14 minutes of silence is under the default 15.
    await checkScreenAlerts(env, outbox, start + 14 * MIN);
    expect(to(outbox, 'Lobby east')).toEqual([]);

    // Past it: one email to each owner and editor, none to the viewer.
    await checkScreenAlerts(env, outbox, start + 16 * MIN);
    const offline = to(outbox, 'Lobby east');
    expect(offline.map((m) => m.to).sort()).toEqual([addr.owner, addr.editor].sort());
    expect(offline[0]!.subject).toBe('Lobby east is offline');
    expect(offline[0]!.text).toContain('Northside');

    // Still silent: the check runs again and sends nothing more.
    await checkScreenAlerts(env, outbox, start + 21 * MIN);
    await checkScreenAlerts(env, outbox, start + 60 * MIN);
    expect(to(outbox, 'Lobby east')).toHaveLength(2);

    // Heard from again: one more email each, then quiet.
    await scoped(env.DB, org.id).screens.update(screenId, { lastSeenAt: start + 61 * MIN });
    await checkScreenAlerts(env, outbox, start + 62 * MIN);
    const back = to(outbox, 'Lobby east').slice(2);
    expect(back.map((m) => m.to).sort()).toEqual([addr.owner, addr.editor].sort());
    expect(back[0]!.subject).toBe('Lobby east is back');
    expect(back[0]!.text).toMatch(/61 minutes/);
    await checkScreenAlerts(env, outbox, start + 63 * MIN);
    expect(to(outbox, 'Lobby east')).toHaveLength(4);

    // A second incident alerts again.
    await checkScreenAlerts(env, outbox, start + 80 * MIN);
    expect(to(outbox, 'Lobby east')).toHaveLength(6);
  });

  it("follows the org's threshold and who it says gets the alert", async () => {
    const { owner, org, addr } = await orgWithTeam();
    const set = await owner.tool('update_org_settings', { unreachableAfterMinutes: 30, alerts: { screen_offline: { who: 'everyone', email: true } } });
    expect(set.status).toBe(200);
    const start = Date.now();
    await pairedScreen(org.id, 'Till 2', start);
    const outbox = new RecordingEmailSender();

    await checkScreenAlerts(env, outbox, start + 20 * MIN);
    expect(to(outbox, 'Till 2')).toEqual([]);
    await checkScreenAlerts(env, outbox, start + 31 * MIN);
    expect(
      to(outbox, 'Till 2')
        .map((m) => m.to)
        .sort(),
    ).toEqual([addr.owner, addr.editor, addr.viewer].sort());
  });

  it('sends nothing for a browser test screen whose tab has closed', async () => {
    const { org } = await orgWithTeam();
    const start = Date.now();
    await pairedScreen(org.id, 'Test tab', start, 'browser');
    const outbox = new RecordingEmailSender();

    await checkScreenAlerts(env, outbox, start + 60 * MIN);
    expect(to(outbox, 'Test tab')).toEqual([]);
  });

  it('sends nothing with email off, and nothing for a revoked or never-seen screen', async () => {
    const { owner, org } = await orgWithTeam();
    const start = Date.now();
    await pairedScreen(org.id, 'Muted', start);
    const revoked = await pairedScreen(org.id, 'Revoked', start);
    const o = scoped(env.DB, org.id);
    for (const c of await o.screens.credentials.forScreen(revoked)) await o.screens.credentials.update(c.id, { revokedAt: start });
    await o.screens.insert({ name: 'Never seen', timezone: 'UTC', orientation: 'landscape' });
    await owner.tool('update_org_settings', { alerts: { screen_offline: { who: 'everyone', email: false } } });
    const outbox = new RecordingEmailSender();

    await checkScreenAlerts(env, outbox, start + 20 * MIN);
    expect(outbox.messages.filter((m) => /^(Muted|Revoked|Never seen) /.test(m.subject))).toEqual([]);
  });
});

describe('the Cron Triggers', () => {
  async function runCron(cron: string, scheduledTime: number) {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime, cron }), env, ctx);
    await waitOnExecutionContext(ctx);
  }

  it("run the alert check on the five-minute schedule, not on the poller's one-minute one", async () => {
    const { org } = await orgWithTeam();
    const start = Date.now();
    await pairedScreen(org.id, 'Cron lobby', start);
    // Dev sends through the recorder, so the alerts the Worker sent can be read.
    const outbox = emailSenderFor(env);
    if (!(outbox instanceof RecordingEmailSender)) throw new Error('dev should send through the recorder');

    await runCron('* * * * *', start + 16 * MIN);
    expect(to(outbox, 'Cron lobby')).toEqual([]);
    await runCron('*/5 * * * *', start + 16 * MIN);
    expect(to(outbox, 'Cron lobby').map((m) => m.subject)).toEqual(['Cron lobby is offline', 'Cron lobby is offline']);
  });

  it('expire idempotency keys after 7 days, on the first five-minute run of each UTC day', async () => {
    const { org } = await orgWithTeam();
    const scope = scoped(env.DB, org.id);
    await scope.commit(scope.idempotency.stage({ key: 'k-retention', action: 'create_group', inputSha256: '0', outputJson: '{}' }).writes);
    const midnight = (days: number) => Math.ceil(Date.now() / DAY) * DAY + days * DAY;

    await runCron('*/5 * * * *', midnight(6));
    expect(await scope.idempotency.get('k-retention')).toBeDefined();
    await runCron('*/5 * * * *', midnight(8) + 5 * MIN);
    await runCron('* * * * *', midnight(8));
    expect(await scope.idempotency.get('k-retention')).toBeDefined();
    await runCron('*/5 * * * *', midnight(8));
    expect(await scope.idempotency.get('k-retention')).toBeUndefined();
  });
});
