// Org settings (M3-42): defaults until set, only owners change them, and the screen state follows the threshold.
import { seedOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dispatch, registry } from '../src';
import { seededMembers } from './member';

const { o, as } = seededMembers('settings-org');

describe('org settings', () => {
  it('reads the defaults before anything is set', async () => {
    const r = await dispatch(registry, 'get_org_settings', {}, as('viewer'));
    expect(r).toMatchObject({
      ok: true,
      output: {
        settings: {
          timezone: null,
          locale: null,
          displayHours: null,
          updateWindow: { from: '02:00', to: '04:00' },
          unreachableAfterMinutes: 15,
          editorsPublish: true,
          auditRetentionDays: 365,
          alerts: {
            screen_offline: { who: 'editors', email: true, slack: false, webhook: false },
            publish_finished: { who: 'editors', email: true, slack: false, webhook: false },
            agent_refused: { who: 'owners', email: true, slack: false, webhook: false },
          },
          version: 1,
        },
      },
    });
  });

  it('lets an owner change only what is given, and audits it', async () => {
    const hours = { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }] };
    const first = await dispatch(
      registry,
      'update_org_settings',
      { timezone: 'Europe/London', locale: 'en-GB', displayHours: hours, unreachableAfterMinutes: 30 },
      as('owner'),
    );
    expect(first).toMatchObject({
      ok: true,
      output: { settings: { timezone: 'Europe/London', locale: 'en-GB', displayHours: hours, unreachableAfterMinutes: 30 } },
    });

    const second = await dispatch(
      registry,
      'update_org_settings',
      { locale: null, alerts: { screen_offline: { who: 'everyone', email: false } } },
      as('owner'),
    );
    expect(second).toMatchObject({
      ok: true,
      output: {
        settings: {
          timezone: 'Europe/London',
          locale: null,
          displayHours: hours,
          unreachableAfterMinutes: 30,
          alerts: { screen_offline: { who: 'everyone', email: false }, agent_refused: { who: 'owners', email: true } },
        },
      },
    });
    const audit = await testScope(env.DB, o.orgId).auditLog.list();
    expect(audit.filter((a) => a.action === 'update_org_settings')).toHaveLength(2);
  });

  it("turns Slack or the webhook on for one kind, keeping the rest of its rule and the others'", async () => {
    const r = await dispatch(registry, 'update_org_settings', { alerts: { screen_offline: { slack: true }, agent_refused: { webhook: true } } }, as('owner'));
    expect(r).toMatchObject({
      ok: true,
      output: {
        settings: {
          alerts: {
            screen_offline: { who: 'everyone', email: false, slack: true, webhook: false },
            publish_finished: { who: 'editors', email: true, slack: false, webhook: false },
            agent_refused: { who: 'owners', email: true, slack: false, webhook: true },
          },
        },
      },
    });
  });

  it('reads a rule stored before Slack and the webhook with both off', async () => {
    const org = testScope(env.DB, 'legacy-rules-org');
    await seedOrg(env.DB, 'legacy-rules-org');
    await org.commit((await org.settings.stage.set({ alertsJson: JSON.stringify({ screen_offline: { who: 'owners', email: false } }) })).writes);
    const r = await dispatch(registry, 'get_org_settings', {}, { ...as('viewer'), org });
    expect(r).toMatchObject({ output: { settings: { alerts: { screen_offline: { who: 'owners', email: false, slack: false, webhook: false } } } } });
  });

  it('lets an owner stop editors publishing, and back', async () => {
    const off = await dispatch(registry, 'update_org_settings', { editorsPublish: false }, as('owner'));
    expect(off).toMatchObject({ ok: true, output: { settings: { editorsPublish: false, timezone: 'Europe/London' } } });
    expect(await dispatch(registry, 'get_org_settings', {}, as('viewer'))).toMatchObject({ output: { settings: { editorsPublish: false } } });
    expect(await dispatch(registry, 'update_org_settings', { editorsPublish: true }, as('editor'))).toMatchObject({ ok: false, error: 'forbidden' });
    const on = await dispatch(registry, 'update_org_settings', { editorsPublish: true }, as('owner'));
    expect(on).toMatchObject({ ok: true, output: { settings: { editorsPublish: true } } });
  });

  it('lets an owner choose how long audit rows are kept', async () => {
    const set = await dispatch(registry, 'update_org_settings', { auditRetentionDays: 30 }, as('owner'));
    expect(set).toMatchObject({ ok: true, output: { settings: { auditRetentionDays: 30, timezone: 'Europe/London' } } });
    expect(await dispatch(registry, 'get_org_settings', {}, as('viewer'))).toMatchObject({ output: { settings: { auditRetentionDays: 30 } } });
    expect(await dispatch(registry, 'update_org_settings', { auditRetentionDays: 3650 }, as('editor'))).toMatchObject({ ok: false, error: 'forbidden' });
    const back = await dispatch(registry, 'update_org_settings', { auditRetentionDays: 365 }, as('owner'));
    expect(back).toMatchObject({ ok: true, output: { settings: { auditRetentionDays: 365 } } });
  });

  it('refuses editors and viewers, and bad values', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      expect(await dispatch(registry, 'update_org_settings', { timezone: 'UTC' }, as(role))).toMatchObject({ ok: false, error: 'forbidden' });
    }
    for (const bad of [
      { unreachableAfterMinutes: 2 },
      { auditRetentionDays: 29 },
      { auditRetentionDays: 3651 },
      { auditRetentionDays: 90.5 },
      { updateWindow: { from: '25:00', to: '04:00' } },
      { updateWindow: { from: '02:00', to: '02:00' } },
      { timezone: 'Mars/Olympus' },
      {},
      { ifVersion: 1 },
    ]) {
      expect(await dispatch(registry, 'update_org_settings', bad, as('owner'))).toMatchObject({ ok: false, error: 'invalid_input' });
    }
  });

  it('refuses a change made from an old read, writing nothing', async () => {
    const read = await dispatch(registry, 'get_org_settings', {}, as('owner'));
    if (!read.ok) throw new Error(read.message);
    const { version, timezone } = (read.output as { settings: { version: number; timezone: string | null } }).settings;
    const stale = await dispatch(registry, 'update_org_settings', { timezone: 'Asia/Tokyo', ifVersion: version - 1 }, as('owner'));
    expect(stale).toMatchObject({ ok: false, error: 'conflict', details: { id: 'settings', version } });
    expect(await dispatch(registry, 'get_org_settings', {}, as('owner'))).toMatchObject({ output: { settings: { timezone, version } } });
    const fresh = await dispatch(registry, 'update_org_settings', { timezone: 'Asia/Tokyo', ifVersion: version }, as('owner'));
    expect(fresh).toMatchObject({ ok: true, output: { settings: { timezone: 'Asia/Tokyo', version: version + 1 } } });
  });

  it("marks a screen unreachable after the org's threshold, not before", async () => {
    const org = testScope(env.DB, o.orgId);
    const twentyMinutesAgo = Date.now() - 20 * 60_000;
    await org.screens.update(o.screen, { lastSeenAt: twentyMinutesAgo });
    await dispatch(registry, 'update_org_settings', { unreachableAfterMinutes: 30 }, as('owner'));
    const calm = await dispatch(registry, 'get_screen', { screenId: o.screen }, as('viewer'));
    expect(calm).toMatchObject({ ok: true, output: { screen: { state: { kind: expect.not.stringMatching(/unreachable/) } } } });
    await dispatch(registry, 'update_org_settings', { unreachableAfterMinutes: 15 }, as('owner'));
    const listed = await dispatch(registry, 'list_screens', {}, as('viewer'));
    expect(listed).toMatchObject({ ok: true, output: { screens: [{ id: o.screen, state: { kind: expect.stringMatching(/unreachable|needs_you/) } }] } });
  });
});
