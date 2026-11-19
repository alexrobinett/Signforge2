import { describe, expect, it } from 'vitest';
import { auditInput, auditTime, csvLine, csvRow, detailText, eventText, isWhen, viaText, whatText, whoText, type AuditEntry } from '../src/lib/audit';

const entry = (e: Partial<AuditEntry>): AuditEntry => ({
  at: Date.UTC(2026, 10, 17, 14, 20),
  actor: { kind: 'user', id: 'usr_jun', clientId: 'cms' },
  action: 'rename_screen',
  target: { kind: 'screen', id: 'scr_1' },
  detail: { input: { screenId: 'scr_1', name: 'Lobby' } },
  ...e,
});

describe('eventText', () => {
  it('says what was done, from the tool and its input', () => {
    expect(eventText({ action: 'set_display_override', input: { state: 'on' } })).toBe('Woken from the CMS');
    expect(eventText({ action: 'set_display_override', input: { state: 'off' } })).toBe('Put to sleep from the CMS');
    expect(eventText({ action: 'set_display_override', input: { state: null } })).toBe('Back to its display hours');
    expect(eventText({ action: 'update_screen_settings', input: { displayHours: null, timezone: 'UTC' } })).toBe('Display hours and time zone changed');
    expect(eventText({ action: 'update_screen_settings', input: { orientation: 'portrait' } })).toBe('Orientation changed');
    expect(eventText({ action: 'rename_screen', input: { name: 'Lobby' } })).toBe('Renamed to Lobby');
    expect(eventText({ action: 'restart_screen', input: {} })).toBe('Player restarted');
    expect(eventText({ action: 'some_new_tool', input: {} })).toBe('Some new tool');
  });
});

describe('the audit log in words', () => {
  it('words a membership change from the fields it kept, and an agent refused for its limits', () => {
    expect(
      whatText(entry({ action: 'invite_member', target: { kind: 'invitation', id: 'inv_1' }, detail: { email: 'sam@example.com', role: 'editor' } })),
    ).toBe('Invited sam@example.com as editor');
    const refused = entry({
      actor: { kind: 'agent', id: 'grt_1', clientId: 'price-bot' },
      action: 'rate_limited',
      target: null,
      detail: { tool: 'update_spot', refused: { error: 'rate_limited', message: 'over its limit' } },
    });
    expect([whoText(refused, new Map(), 'usr_me'), whatText(refused), detailText(refused), viaText(refused)]).toEqual([
      'Agent price-bot',
      'Refused: over its limits',
      'tool: update_spot · refused: over its limit',
      'Agent · price-bot',
    ]);
  });

  it('names members, you, and someone no longer a member', () => {
    const names = new Map([['usr_jun', 'Jun Takahashi']]);
    expect(whoText(entry({}), names, 'usr_me')).toBe('Jun Takahashi');
    expect(whoText(entry({}), names, 'usr_jun')).toBe('You');
    expect(whoText(entry({ actor: { kind: 'user', id: 'usr_gone', clientId: 'cms' } }), names, 'usr_me')).toBe('Former member usr_gone');
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
    expect(auditInput({}, now)).toEqual({});
    expect(auditInput({ who: 'agents', what: 'update_spot', target: 'spot', targetId: 'spt_1', when: 'day', q: 'latte' }, now)).toEqual({
      actor: { kind: 'agent' },
      action: 'update_spot',
      target: { kind: 'spot', id: 'spt_1' },
      from: now - 86_400_000,
      query: 'latte',
    });
    expect(auditInput({ who: 'usr_jun' }, now)).toEqual({ actor: { id: 'usr_jun' } });
    // A name every object has is no filter of ours: one actor's id, never a kind.
    expect(isWhen('constructor')).toBe(false);
    expect(auditInput({ who: 'constructor' }, now)).toEqual({ actor: { id: 'constructor' } });
  });
});

describe('csvLine', () => {
  it('quotes what needs quoting and defuses formulas', () => {
    expect(csvLine(['a', 'b c', 'say "hi"', 'one,two', 'line\nbreak'])).toBe('a,b c,"say ""hi""","one,two","line\nbreak"\r\n');
    expect(csvLine(['=HYPERLINK("x")', '+1', '-2', '@SUM', 'ok'])).toBe(`"'=HYPERLINK(""x"")",'+1,'-2,'@SUM,ok\r\n`);
  });
});
