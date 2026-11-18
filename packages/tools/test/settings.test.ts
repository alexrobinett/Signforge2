// Org settings (M3-42): defaults until set, only owners change them, and the screen state follows the threshold.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller } from '../src';

let o: SeededOrg;
const as = (role: Caller['role']): Caller => ({ org: scoped(env.DB, o.orgId), role, actor: { kind: 'user', id: `user-${role}`, clientId: 'cms' }, blobs: env.BLOBS });

beforeAll(async () => {
  o = await seedOrg(env.DB, 'settings-org');
});

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
          alerts: {
            screen_offline: { who: 'editors', email: true },
            publish_finished: { who: 'editors', email: true },
            agent_refused: { who: 'owners', email: true },
          },
        },
      },
    });
  });

  it('lets an owner change only what is given, and audits it', async () => {
    const hours = { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }] };
    const first = await dispatch(registry, 'update_org_settings', { timezone: 'Europe/London', locale: 'en-GB', displayHours: hours, unreachableAfterMinutes: 30 }, as('owner'));
    expect(first).toMatchObject({ ok: true, output: { settings: { timezone: 'Europe/London', locale: 'en-GB', displayHours: hours, unreachableAfterMinutes: 30 } } });

    const second = await dispatch(registry, 'update_org_settings', { locale: null, alerts: { screen_offline: { who: 'everyone', email: false } } }, as('owner'));
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
    const audit = await scoped(env.DB, o.orgId).auditLog.list();
    expect(audit.filter((a) => a.action === 'update_org_settings')).toHaveLength(2);
  });

  it('refuses editors and viewers, and bad values', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      expect(await dispatch(registry, 'update_org_settings', { timezone: 'UTC' }, as(role))).toMatchObject({ ok: false, error: 'forbidden' });
    }
    for (const bad of [{ unreachableAfterMinutes: 2 }, { updateWindow: { from: '25:00', to: '04:00' } }, { updateWindow: { from: '02:00', to: '02:00' } }, { timezone: 'Mars/Olympus' }, {}]) {
      expect(await dispatch(registry, 'update_org_settings', bad, as('owner'))).toMatchObject({ ok: false, error: 'invalid_input' });
    }
  });

  it("marks a screen unreachable after the org's threshold, not before", async () => {
    const org = scoped(env.DB, o.orgId);
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
