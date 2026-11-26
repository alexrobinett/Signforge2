import { describe, expect, it } from 'vitest';
import { agentWho, auditInput, auditTime, csvLine, csvRow, detailText, eventText, isWhen, viaText, whatText, whoText, type AuditEntry } from '../src/lib/audit';

const entry = (e: Partial<AuditEntry>): AuditEntry => ({
  at: Date.UTC(2026, 10, 17, 14, 20),
  actor: { kind: 'user', id: 'usr_jun', clientId: 'cms' },
  action: 'update_screen',
  target: { kind: 'screen', id: 'scr_1' },
  detail: { input: { screenId: 'scr_1', name: 'Lobby' } },
  ...e,
});

describe('eventText', () => {
  it('says what was done, from the tool and its input', () => {
    expect(eventText({ action: 'set_display_override', input: { state: 'on' } })).toBe('Woken from the CMS');
    expect(eventText({ action: 'set_display_override', input: { state: 'off' } })).toBe('Put to sleep from the CMS');
    expect(eventText({ action: 'set_display_override', input: { state: null } })).toBe('Back to its display hours');
    expect(eventText({ action: 'update_screen', input: { displayHours: null, timezone: 'UTC' } })).toBe('Display hours and time zone changed');
    expect(eventText({ action: 'update_screen', input: { orientation: 'portrait' } })).toBe('Orientation changed');
    expect(eventText({ action: 'update_screen', input: { name: 'Lobby' } })).toBe('Renamed to Lobby');
    expect(eventText({ action: 'update_screen', input: { name: 'Lobby', timezone: 'UTC' } })).toBe('Name and time zone changed');
    expect(eventText({ action: 'screen_command', input: { command: 'display_on' } })).toBe('Woken from the CMS');
    expect(eventText({ action: 'screen_command', input: { command: 'restart' } })).toBe('Player restarted');
    expect(eventText({ action: 'save_group', input: { name: 'Windows', screenIds: ['scr_1'] } })).toBe('Created Windows');
    expect(eventText({ action: 'save_group', input: { groupId: 'grp_1', name: 'Shop windows' } })).toBe('Renamed to Shop windows');
    expect(eventText({ action: 'save_group', input: { groupId: 'grp_1', screenIds: ['scr_1'], membership: 'remove' } })).toBe('Screens removed');
    expect(eventText({ action: 'save_spot', input: { name: 'Menu', kind: 'url' } })).toBe('Created');
    expect(eventText({ action: 'save_spot', input: { spotId: 'spt_1', name: 'Menu' } })).toBe('Draft changed');
    expect(eventText({ action: 'save_schedule_entry', input: { playlistId: 'pls_1', target: 'org' } })).toBe('Scheduled');
    expect(eventText({ action: 'save_brand_kit', input: { brandKitId: 'bk_1', makeDefault: true } })).toBe('Changed · made the default');
    expect(eventText({ action: 'delete', input: { type: 'schedule_entry', id: 'sch_1' } })).toBe('Unscheduled');
    expect(eventText({ action: 'takeover', input: { action: 'end', scheduleEntryId: 'sch_1' } })).toBe('Takeover ended');
    expect(eventText({ action: 'finalize_upload', input: { assetId: 'ast_1', kind: 'video' } })).toBe('Video checked');
    expect(eventText({ action: 'set_alert_channel', input: { kind: 'slack' } })).toBe('Slack channel set');
    expect(eventText({ action: 'set_alert_channel', input: { kind: 'webhook' } })).toBe('Webhook set');
    // Rows from before #345 merged the screen, group and content tools keep their own words.
    expect(eventText({ action: 'restart_screen', input: {} })).toBe('Player restarted');
    expect(eventText({ action: 'rename_screen', input: { name: 'Lobby' } })).toBe('Renamed to Lobby');
    expect(eventText({ action: 'some_new_tool', input: {} })).toBe('Some new tool');
  });
});

describe('the audit log in words', () => {
  it('says a publish made the org’s first default playlist, by name, and only then (#243)', () => {
    const publish = (detail: AuditEntry['detail']) => entry({ action: 'publish', target: { kind: 'publish', id: 'pub_1' }, detail });
    expect(whatText(publish({ input: {}, detail: { madeDefault: { id: 'pls_1', name: 'Opening week' } } }))).toBe(
      'Published · made Opening week the default playlist',
    );
    expect(whatText(publish({ input: {} }))).toBe('Published');
    // Its detail stays the input's: the default is said once, in what was done.
    expect(detailText(publish({ input: {}, detail: { madeDefault: { id: 'pls_1', name: 'Opening week' } } }))).toBe('');
  });

  it("says who a cancelled invitation was for, from Better Auth's row or the tool's, which keeps it apart from its input (#321)", () => {
    const target = { kind: 'invitation', id: 'inv_1' };
    const endpoint = entry({ action: 'cancel_invitation', target, detail: { email: 'sam@example.com' } });
    const tool = entry({ action: 'cancel_invitation', target, detail: { input: { invitationId: 'inv_1' }, detail: { email: 'sam@example.com' } } });
    for (const e of [endpoint, tool]) expect([whatText(e), detailText(e)]).toEqual(['Invitation cancelled', 'email: sam@example.com']);
  });

  it('names an agent by its plain name, else as an agent, and as gone only once disconnected: never "An agent, agent" (#410)', () => {
    expect(agentWho({ name: 'Deli bot', gone: false })).toBe('Deli bot, agent');
    expect(agentWho({ name: null, gone: false })).toBe('An agent');
    expect(agentWho({ name: null, gone: true })).toBe('An agent no longer connected');
    expect(agentWho(undefined)).toBe('An agent');
  });

  it('words a membership change from the fields it kept, and an agent refused for its limits', () => {
    expect(
      whatText(entry({ action: 'invite_member', target: { kind: 'invitation', id: 'inv_1' }, detail: { email: 'sam@example.com', role: 'editor' } })),
    ).toBe('Invited sam@example.com as editor');
    const refused = entry({
      actor: { kind: 'agent', id: 'grt_1', clientId: 'price-bot' },
      action: 'rate_limited',
      target: null,
      detail: { tool: 'save_spot', refused: { error: 'rate_limited', message: 'over its limit' } },
    });
    expect([whoText(refused, new Map(), 'usr_me'), whatText(refused), detailText(refused), viaText(refused)]).toEqual([
      'Agent price-bot',
      'Refused: over its limits',
      'tool: save_spot · refused: over its limit',
      'Agent · price-bot',
    ]);
  });

  it('names members, you, and someone no longer a member', () => {
    const names = new Map([['usr_jun', 'Jun Takahashi']]);
    expect(whoText(entry({}), names, 'usr_me')).toBe('Jun Takahashi');
    expect(whoText(entry({}), names, 'usr_jun')).toBe('You');
    expect(whoText(entry({ actor: { kind: 'user', id: 'usr_gone', clientId: 'cms' } }), names, 'usr_me')).toBe('Former member usr_gone');
    // The built-in agent acts as the member who asked it (#263).
    const filled = entry({ actor: { kind: 'user', id: 'usr_jun', clientId: 'cms-agent' }, action: 'save_spot' });
    expect([whoText(filled, names, 'usr_me'), whoText(filled, names, 'usr_jun')]).toEqual(['Jun Takahashi via agent', 'You via agent']);
    // The file is read by others: the exporter's own rows by name, even when a caller says who is exporting.
    // @ts-expect-error: csvRow takes no exporter; a CSV never says "You".
    expect(csvRow(entry({}), names, 'usr_jun')[1]).toBe('Jun Takahashi');
  });

  it('shows the input, without the target it names, redacted values as recorded', () => {
    expect(detailText(entry({ action: 'claim_screen', detail: { input: { code: '[redacted]', name: 'Lobby' } } }))).toBe('code: [redacted] · name: Lobby');
    expect(detailText(entry({}))).toBe('name: Lobby');
  });

  it('gives the time in the org’s zone, with the day when it is not today', () => {
    const at = Date.UTC(2026, 10, 17, 14, 20);
    expect(auditTime(at, 'Europe/London', at + 60_000)).toBe('14:20');
    expect(auditTime(at, 'America/Los_Angeles', at + 60_000)).toBe('06:20');
    expect(auditTime(at, 'UTC', at + 2 * 86_400_000)).toBe('Tue 17 Nov 14:20');
    expect(auditTime(at, 'UTC', Date.UTC(2027, 0, 2))).toBe('Tue 17 Nov 2026 14:20');
  });
});

describe('auditInput', () => {
  it('turns the page’s filters into list_audit_log’s input', () => {
    const now = Date.UTC(2026, 10, 18);
    expect(auditInput({}, '', now)).toEqual({});
    expect(auditInput({ who: 'agents', what: 'save_spot', target: 'spot', targetId: 'spt_1', when: 'day' }, 'latte', now)).toEqual({
      actor: { kind: 'agent' },
      action: 'save_spot',
      target: { kind: 'spot', id: 'spt_1' },
      from: now - 86_400_000,
      query: 'latte',
    });
    expect(auditInput({ who: 'usr_jun' }, '', now)).toEqual({ actor: { id: 'usr_jun' } });
    // A name every object has is no filter of ours: one actor's id, never a kind.
    expect(isWhen('constructor')).toBe(false);
    expect(auditInput({ who: 'constructor' }, '', now)).toEqual({ actor: { id: 'constructor' } });
  });
});

describe('csvLine', () => {
  it('quotes what needs quoting and defuses formulas', () => {
    expect(csvLine(['a', 'b c', 'say "hi"', 'one,two', 'line\nbreak'])).toBe('a,b c,"say ""hi""","one,two","line\nbreak"\r\n');
    expect(csvLine(['=HYPERLINK("x")', '+1', '-2', '@SUM', 'ok'])).toBe(`"'=HYPERLINK(""x"")",'+1,'-2,'@SUM,ok\r\n`);
  });
});
