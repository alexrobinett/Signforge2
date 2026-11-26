// list_audit_log (#82): the org's audit rows newest first, a page at a time, filtered.
import { scoped } from '@signforge/db';
import { seedOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller } from '../src';
import { member, memberOf, seededMembers } from './member';
import { fakeServices } from './services';

const { o, as } = seededMembers('audit-org');

interface Entry {
  at: number;
  actor: { kind: string; id: string; clientId: string | null };
  action: string;
  target: { kind: string; id: string } | null;
  detail: Record<string, unknown>;
}

async function list(input: Record<string, unknown>, role: Caller['role'] = 'viewer') {
  const r = await dispatch(registry, 'list_audit_log', input, as(role));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.output as { entries: Entry[]; next: string | null };
}

/** Every page of the log for `input`, in order, as `role` reads it. */
async function all(input: Record<string, unknown>, role: Caller['role'] = 'viewer') {
  const out: Entry[] = [];
  let cursor: string | undefined;
  do {
    const p = await list({ ...input, ...(cursor ? { cursor } : {}) }, role);
    out.push(...p.entries);
    cursor = p.next ?? undefined;
  } while (cursor);
  return out;
}

const T = Date.UTC(2026, 10, 18, 9);

beforeAll(async () => {
  const log = scoped(env.DB, o.orgId).auditLog;
  // Three rows in one millisecond, so paging must break ties; and an agent's limit refusal, whose id is long (#77).
  for (const [i, name] of ['First', 'Second', 'Third'].entries())
    await log.append({
      at: T,
      actorKind: 'user',
      actorId: 'usr_jun',
      clientId: 'cms',
      action: 'update_screen',
      targetKind: 'screen',
      targetId: o.screen,
      detailJson: JSON.stringify({ input: { screenId: o.screen, name: `${name} ${i}` } }),
    });
  await log.appendOnce(`rate_limited_${'g'.repeat(40)}_minute_${T + 1000}`, {
    at: T + 1000,
    actorKind: 'agent',
    actorId: 'grt_price_bot',
    clientId: 'price-bot',
    action: 'rate_limited',
    detailJson: JSON.stringify({ tool: 'save_spot', refused: { error: 'rate_limited', message: 'over' } }),
  });
});

describe('list_audit_log', () => {
  it('lists the newest first, a page at a time, with no row repeated or skipped', async () => {
    const pages = await all({ limit: 2 });
    expect(pages.map((e) => e.action)).toEqual(['rate_limited', 'update_screen', 'update_screen', 'update_screen', 'seed']);
    // Rows of one millisecond: the latest written first.
    expect(pages.slice(1, 4).map((e) => e.detail.input)).toEqual([
      { screenId: o.screen, name: 'Third 2' },
      { screenId: o.screen, name: 'Second 1' },
      { screenId: o.screen, name: 'First 0' },
    ]);
    expect(pages[0]).toEqual({
      at: T + 1000,
      actor: { kind: 'agent', id: 'grt_price_bot', clientId: 'price-bot' },
      action: 'rate_limited',
      target: null,
      detail: { tool: 'save_spot', refused: { error: 'rate_limited', message: 'over' } },
    });
  });

  it('filters by actor, action, target, time and text', async () => {
    const actions = async (input: Record<string, unknown>) => (await all(input)).map((e) => `${e.action}@${e.at}`);
    expect(await actions({ actor: { kind: 'agent' } })).toEqual([`rate_limited@${T + 1000}`]);
    expect(await actions({ actor: { id: 'usr_jun' } })).toHaveLength(3);
    expect(await actions({ actor: { kind: 'device', id: 'usr_jun' } })).toEqual([]);
    expect(await actions({ action: 'seed' })).toHaveLength(1);
    expect(await actions({ target: { kind: 'screen' } })).toHaveLength(3);
    expect(await actions({ target: { kind: 'screen', id: o.screen } })).toHaveLength(3);
    // A target that is gone, or never was, still filters: its history, if any.
    expect(await actions({ target: { kind: 'screen', id: 'scr_deleted' } })).toEqual([]);
    expect(await actions({ from: T, to: T + 1000 })).toEqual([`update_screen@${T}`, `update_screen@${T}`, `update_screen@${T}`]);
    expect(await actions({ from: T + 1 })).toEqual([`rate_limited@${T + 1000}`]);
    // As an agent reads times, ISO 8601; a time in no accepted form is refused by naming them (#543).
    expect(await actions({ from: new Date(T + 1).toISOString() })).toEqual([`rate_limited@${T + 1000}`]);
    const refused = await dispatch(registry, 'list_audit_log', { from: 'yesterday' }, as('viewer'));
    expect(JSON.stringify(refused)).toMatch(/ISO 8601 time with its offset.*ms since the epoch/);
    // Seconds since the epoch, read as ms, would be January 1970: refused, saying so; an ISO time before 2000 alike (#543).
    const seconds = await dispatch(registry, 'list_audit_log', { from: Math.floor(T / 1000) }, as('viewer'));
    expect(JSON.stringify(seconds)).toMatch(/one this small is seconds: multiply it by 1000/);
    const early = await dispatch(registry, 'list_audit_log', { from: '1969-12-31T23:00:00Z' }, as('viewer'));
    expect(JSON.stringify(early)).toMatch(/a time from 2000 on/);
    // Described as date-time, without zod's regex.
    const d = await dispatch(registry, 'describe', { type: 'audit_entry' }, as('viewer'));
    expect(JSON.stringify(d)).toContain('"format":"date-time"');
    expect(JSON.stringify(d)).not.toContain('pattern');
    // Text: in the recorded input, any case; LIKE's wildcards are plain characters.
    expect((await all({ query: 'second' })).map((e) => e.detail.input)).toEqual([{ screenId: o.screen, name: 'Second 1' }]);
    expect(await actions({ query: 'price_bot' })).toEqual([`rate_limited@${T + 1000}`]);
    expect(await actions({ query: '%' })).toEqual([]);
    expect(await actions({ query: '_' })).toHaveLength(4);
  });

  it('pages a filtered list with the same filters', async () => {
    const first = await list({ actor: { id: 'usr_jun' }, limit: 2 });
    expect(first.entries).toHaveLength(2);
    const second = await list({ actor: { id: 'usr_jun' }, limit: 2, cursor: first.next });
    expect(second).toMatchObject({ entries: [{ detail: { input: { name: 'First 0' } } }], next: null });
  });

  it('returns inputs as they were recorded, secrets redacted', async () => {
    const made = await dispatch(
      registry,
      'save_data_source',
      { name: 'Menu feed', format: 'json', feedUrl: 'https://feeds.example.com/menu?key=hunter2' },
      as('editor'),
    );
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const [entry] = await all({ action: 'save_data_source' });
    expect(entry).toMatchObject({ actor: { kind: 'user', id: 'user-editor', clientId: 'cms' }, target: { kind: 'data_source' } });
    expect(entry!.detail.input).toMatchObject({ name: 'Menu feed', feedUrl: '[redacted]' });
    expect(JSON.stringify(await all({}))).not.toContain('hunter2');
    // Search reads what was stored, so a secret cannot be found by guessing it either.
    expect(await all({ query: 'hunter2' })).toEqual([]);
  });

  it("shows an invitee's email to owners only, who alone may list invitations", async () => {
    const log = scoped(env.DB, o.orgId).auditLog;
    const invited = 'sam.invitee@example.com';
    for (const action of ['invite_member', 'cancel_invitation', 'reject_invitation'])
      await log.append({
        at: T + 3000,
        actorKind: 'user',
        actorId: 'usr_jun',
        clientId: 'cms',
        action,
        targetKind: 'invitation',
        targetId: 'inv_1',
        detailJson: JSON.stringify({ email: invited, role: 'editor' }),
      });
    const invitations = { target: { kind: 'invitation' } };
    expect((await all(invitations, 'owner')).map((e) => e.detail)).toEqual([
      { email: invited, role: 'editor' },
      { email: invited, role: 'editor' },
      { email: invited, role: 'editor' },
    ]);
    expect((await all({ query: 'sam.invitee' }, 'owner')).map((e) => e.action).sort()).toEqual(['cancel_invitation', 'invite_member', 'reject_invitation']);
    for (const role of ['editor', 'viewer'] as const) {
      expect((await all(invitations, role)).map((e) => e.detail)).toEqual([{ role: 'editor' }, { role: 'editor' }, { role: 'editor' }]);
      // Nor can a search find who was invited by guessing the address.
      expect(await all({ query: 'sam.invitee' }, role)).toEqual([]);
      // The rest of the row is still searchable.
      expect(await all({ query: 'inv_1' }, role)).toHaveLength(3);
    }
  });

  it("hides the invitee of a cancel the tool recorded, under its detail, as it does Better Auth's (#321)", async () => {
    const log = scoped(env.DB, o.orgId).auditLog;
    await log.append({
      at: T + 4000,
      actorKind: 'agent',
      actorId: 'agt_1',
      clientId: 'agent-app',
      action: 'cancel_invitation',
      targetKind: 'invitation',
      targetId: 'inv_2',
      detailJson: JSON.stringify({ input: { invitationId: 'inv_2' }, detail: { email: 'kim.invitee@example.com' } }),
    });
    const mine = { target: { kind: 'invitation', id: 'inv_2' } };
    expect((await all(mine, 'owner')).map((e) => e.detail)).toEqual([{ input: { invitationId: 'inv_2' }, detail: { email: 'kim.invitee@example.com' } }]);
    for (const role of ['editor', 'viewer'] as const) {
      expect((await all(mine, role)).map((e) => e.detail)).toEqual([{ input: { invitationId: 'inv_2' }, detail: {} }]);
      expect(await all({ query: 'kim.invitee' }, role)).toEqual([]);
    }
  });

  it("hides the invitee a drawer card's summary names, on a confirmed cancel and on a refused press, rows written before the card withheld it (review of #414)", async () => {
    const log = scoped(env.DB, o.orgId).auditLog;
    const confirmed = {
      summary: 'Cancel an invitation: The invitation for lee.invitee@example.com as editor stops working.',
      runId: 'run_1',
      callId: 'call_1',
    };
    const rows = [
      { input: { invitationId: 'inv_3' }, detail: { email: 'lee.invitee@example.com' }, confirmed },
      {
        input: { invitationId: 'inv_3' },
        refused: { error: 'conflict', message: 'invitation inv_3 was accepted, rejected or cancelled meanwhile' },
        confirmed,
      },
    ];
    for (const [i, detail] of rows.entries())
      await log.append({
        at: T + 5000 + i,
        actorKind: 'user',
        actorId: 'usr_jun',
        clientId: 'cms-agent',
        action: 'cancel_invitation',
        targetKind: 'invitation',
        targetId: 'inv_3',
        detailJson: JSON.stringify(detail),
      });
    const mine = { target: { kind: 'invitation', id: 'inv_3' } };
    expect(JSON.stringify(await all(mine, 'owner'))).toContain('lee.invitee@example.com');
    for (const role of ['editor', 'viewer'] as const) {
      const seen = await all(mine, role);
      expect(seen.map((e) => e.detail.confirmed)).toEqual([
        { runId: 'run_1', callId: 'call_1' },
        { runId: 'run_1', callId: 'call_1' },
      ]);
      expect(JSON.stringify(seen)).not.toContain('lee.invitee');
      expect(await all({ query: 'lee.invitee' }, role)).toEqual([]);
    }
  });

  it("refuses a cursor made in another org, so a member who switched org cannot page one org's log into another's", async () => {
    const other = await seedOrg(env.DB, 'audit-other-org');
    const first = await list({ limit: 1 });
    expect(first.next).not.toBeNull();
    const r = await dispatch(registry, 'list_audit_log', { limit: 1, cursor: first.next }, member(other.orgId, 'viewer'));
    expect(r).toMatchObject({ ok: false, error: 'invalid_input', details: [{ path: 'cursor' }] });
  });

  it('refuses a cursor it did not make', async () => {
    const forged = btoa(JSON.stringify(['a', 'b'])).replace(/=+$/, '');
    expect(await dispatch(registry, 'list_audit_log', { cursor: forged }, as('viewer'))).toMatchObject({ ok: false, error: 'invalid_input' });
    // One naming this org, but not made by this list, is not said to be another org's.
    const own = btoa(JSON.stringify(['a', 1, o.orgId])).replace(/=+$/, '');
    expect(await dispatch(registry, 'list_audit_log', { cursor: own }, as('viewer'))).toMatchObject({
      ok: false,
      error: 'invalid_input',
      message: 'cursor cannot be used: it is not one this list returned; start again without it',
    });
  });

  it('searches with the longest text it takes, in any script and with wildcard characters', async () => {
    // D1 refuses a LIKE pattern over 50 bytes; this text is 200 bytes in UTF-8.
    const long = `${'Ä_%'.repeat(33)}Ä`;
    expect(long).toHaveLength(100);
    await scoped(env.DB, o.orgId).auditLog.append({
      at: T + 2000,
      actorKind: 'user',
      actorId: 'usr_jun',
      clientId: 'cms',
      action: 'rename_spot',
      detailJson: JSON.stringify({ input: { name: `Menu ${long}` } }),
    });
    expect((await all({ query: long })).map((e) => e.action)).toEqual(['rename_spot']);
    expect(await all({ query: 'z'.repeat(100) })).toEqual([]);
  });
});

describe('list_audit_log by a screen command (#345)', () => {
  it("finds screen_command's rows under the tool each command replaced, and only those", async () => {
    const mine = await seedOrg(env.DB, 'audit-commands');
    const editor = member(mine.orgId, 'editor');
    for (const command of ['identify', 'restart', 'display_on', 'display_auto'])
      expect(await dispatch(registry, 'screen_command', { screenId: mine.screen, command }, editor), command).toMatchObject({ ok: true });
    const commands = async (action: string) => {
      const r = await dispatch(registry, 'list_audit_log', { action }, editor);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (r.output as { entries: Entry[] }).entries.map((e) => (e.detail.input as { command: string }).command).sort();
    };
    expect(await commands('restart_screen')).toEqual(['restart']);
    expect(await commands('identify_screen')).toEqual(['identify']);
    expect(await commands('set_display_override')).toEqual(['display_auto', 'display_on']);
    expect(await commands('screen_command')).toEqual(['display_auto', 'display_on', 'identify', 'restart']);
  });
});

describe('list_audit_log by a content or group save (#345, #507)', () => {
  it("finds each save's rows under the create or update it replaced, by whether it gave the id", async () => {
    const mine = await seedOrg(env.DB, 'audit-saves');
    const editor = member(mine.orgId, 'editor');
    const save = async (name: string, input: Record<string, unknown>) => {
      const r = await dispatch(registry, name, input, editor);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return r.output as Record<string, { id: string; version: number }>;
    };
    const { playlist } = await save('save_playlist', { name: 'Lunch', idempotencyKey: 'audit-saves-pl' });
    await save('save_playlist', { playlistId: playlist!.id, name: 'Lunch menu', ifVersion: playlist!.version });
    const { group } = await save('save_group', { name: 'Windows', idempotencyKey: 'audit-saves-grp' });
    await save('save_group', { groupId: group!.id, screenIds: [mine.screen], membership: 'add' });
    const found = async (action: string) => {
      const r = await dispatch(registry, 'list_audit_log', { action }, editor);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (r.output as { entries: Entry[] }).entries.map((e) => `${e.action} ${JSON.stringify(e.detail.input)}`);
    };
    expect(await found('create_playlist')).toEqual([expect.stringMatching(/^save_playlist \{"name":"Lunch",/)]);
    expect(await found('update_playlist')).toEqual([expect.stringMatching(/^save_playlist \{"playlistId":/)]);
    expect(await found('save_playlist')).toHaveLength(2);
    expect(await found('create_group')).toEqual([expect.stringMatching(/^save_group \{"name":"Windows",/)]);
    expect(await found('add_group_members')).toEqual([expect.stringMatching(/"membership":"add"/)]);
    expect(await found('rename_group')).toEqual([]);
    expect(await found('remove_group_members')).toEqual([]);
  });
});

describe('list_audit_log by a delete or a takeover (#345 PR 5)', () => {
  it('finds each row under the tool its type or action replaced, and only those', async () => {
    const mine = await seedOrg(env.DB, 'audit-merged');
    const owner = member(mine.orgId, 'owner');
    const run = async (name: string, input: Record<string, unknown>) => {
      const r = await dispatch(registry, name, input, owner);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return r.output;
    };
    const { playlist } = (await run('save_playlist', { name: 'Gone soon', idempotencyKey: 'audit-merged-pl' })) as { playlist: { id: string } };
    await run('delete', { type: 'playlist', id: playlist.id });
    await run('delete', { type: 'schedule_entry', id: mine.scheduleEntry });
    const found = async (action: string) => {
      const r = await dispatch(registry, 'list_audit_log', { action }, owner);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (r.output as { entries: Entry[] }).entries.map((e) => `${e.action} ${(e.detail.input as { type?: string }).type}`);
    };
    expect(await found('delete_playlist')).toEqual(['delete playlist']);
    expect(await found('delete_schedule_entry')).toEqual(['delete schedule_entry']);
    expect(await found('delete_asset')).toEqual([]);
    expect(await found('delete')).toHaveLength(2);
  });
});

describe('list_audit_log, every replaced tool by the rows of the one that does its job (#507)', () => {
  it('finds the creates and changes of spots, schedule entries, brand kits and data sources, the group changes, a kit made the default, and a screen renamed or set', async () => {
    const mine = await seedOrg(env.DB, 'audit-every-pair');
    const owner = memberOf(scoped(env.DB, mine.orgId), 'owner', fakeServices);
    const run = async (name: string, input: Record<string, unknown>) => {
      const r = await dispatch(registry, name, input, owner);
      if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r)}`);
      return r.output as Record<string, { id: string; version: number }>;
    };
    const { spot } = await run('save_spot', { name: 'Page', kind: 'url', url: 'https://example.com', idempotencyKey: 'every-pair-spot' });
    await run('save_spot', { spotId: spot!.id, name: 'Page 2', ifVersion: spot!.version });
    const { entry } = await run('save_schedule_entry', { playlistId: mine.playlist, target: 'org', idempotencyKey: 'every-pair-entry' });
    await run('save_schedule_entry', { scheduleEntryId: entry!.id, priority: 3, ifVersion: entry!.version });
    const colors = { primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' };
    const { brandKit } = await run('save_brand_kit', { name: 'Spare', colors, idempotencyKey: 'every-pair-kit' });
    await run('save_brand_kit', { brandKitId: brandKit!.id, name: 'Spare 2', ifVersion: brandKit!.version });
    // Asked to be the default, of the kit the seed made the default: made nothing the default.
    const seeded = (await scoped(env.DB, mine.orgId).brandKits.assignments.list()).find((a) => a.target === 'org')!.brandKitId;
    await run('save_brand_kit', { brandKitId: seeded, makeDefault: true });
    await run('save_brand_kit', { brandKitId: brandKit!.id, makeDefault: true });
    const { dataSource } = await run('save_data_source', { id: 'pairs', name: 'Pairs', format: 'json', feedUrl: 'https://api.example.com/p.json' });
    await run('save_data_source', { dataSourceId: dataSource!.id, name: 'Pairs 2' });
    const { group } = await run('save_group', { name: 'Hall', idempotencyKey: 'every-pair-group' });
    await run('save_group', { groupId: group!.id, name: 'Hall 2', ifVersion: group!.version });
    await run('save_group', { groupId: group!.id, screenIds: [mine.screen], membership: 'set', ifVersion: group!.version + 1 });
    await run('save_group', { groupId: group!.id, screenIds: [mine.screen], membership: 'remove' });
    await run('update_screen', { screenId: mine.screen, name: 'Lobby 2' });
    await run('update_screen', { screenId: mine.screen, timezone: 'Europe/London' });
    await run('update_screen', { screenId: mine.screen, displayHours: null });
    const found = async (action: string) => {
      const r = await dispatch(registry, 'list_audit_log', { action }, owner);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return (r.output as { entries: Entry[] }).entries.map((e) => `${e.action} ${JSON.stringify(e.detail.input)}`);
    };
    expect(await found('create_spot')).toEqual([expect.stringMatching(/^save_spot \{"name":"Page",/)]);
    expect(await found('update_spot')).toEqual([expect.stringMatching(/^save_spot \{"spotId":/)]);
    expect(await found('create_schedule_entry')).toEqual([expect.stringMatching(/^save_schedule_entry \{"playlistId":/)]);
    expect(await found('update_schedule_entry')).toEqual([expect.stringMatching(/^save_schedule_entry \{"scheduleEntryId":/)]);
    expect(await found('create_brand_kit')).toEqual([expect.stringMatching(/"name":"Spare",/)]);
    // The rename and the kit made the default: asking it of the default already changes nothing, so writes no row.
    expect(await found('update_brand_kit')).toHaveLength(2);
    expect(await found('set_default_brand_kit')).toEqual([expect.stringContaining(`"brandKitId":"${brandKit!.id}","makeDefault":true`)]);
    expect(await found('create_data_source')).toEqual([expect.stringMatching(/"name":"Pairs",/)]);
    expect(await found('update_data_source')).toEqual([expect.stringMatching(/"dataSourceId":"pairs"/)]);
    expect(await found('rename_group')).toEqual([expect.stringContaining('"name":"Hall 2"')]);
    expect(await found('set_group_members')).toEqual([expect.stringContaining('"membership":"set"')]);
    expect(await found('remove_group_members')).toEqual([expect.stringContaining('"membership":"remove"')]);
    expect(await found('rename_screen')).toEqual([expect.stringContaining('"name":"Lobby 2"')]);
    // A setting cleared, given as null, is a setting changed (#545).
    expect(await found('update_screen_settings')).toEqual([
      expect.stringContaining('"displayHours":null'),
      expect.stringContaining('"timezone":"Europe/London"'),
    ]);
  });
});
