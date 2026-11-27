// Settings › Connected agents (MCP)' words (M4-07, M4-08): when a grant was made, its last use as /mcp records
// it, to the hour, its last 7 days and how each call ended. Times are the test's, never the clock.
import { describe, expect, it } from 'vitest';
import { type AgentCall, grantedOn, lastActive, outcome, weekWords } from '../src/lib/agents';

const NOW = Date.UTC(2026, 10, 24, 12);
const HOUR = 60 * 60_000;

describe('lastActive', () => {
  it('says Never, This hour within the hour it cannot see into, and how long ago after it', () => {
    expect(lastActive(null, NOW)).toBe('Never');
    expect(lastActive(NOW, NOW)).toBe('This hour');
    expect(lastActive(NOW - HOUR + 1, NOW)).toBe('This hour');
    expect(lastActive(NOW - HOUR, NOW)).toBe('1 h ago');
    expect(lastActive(NOW - 3 * HOUR, NOW)).toBe('3 h ago');
    expect(lastActive(NOW - 72 * HOUR, NOW)).toBe('3 d ago');
  });
});

describe('grantedOn', () => {
  it('says the day in UTC, the same on the server and in the browser', () => {
    expect(grantedOn(Date.UTC(2026, 10, 12, 23, 30))).toBe('12 Nov');
  });
});

describe('weekWords', () => {
  it('counts calls and changes, one and many', () => {
    expect(weekWords({ calls: 0, changes: 0 })).toBe('0 calls · 0 changes');
    expect(weekWords({ calls: 1, changes: 1 })).toBe('1 call · 1 change');
    expect(weekWords({ calls: 1240, changes: 3 })).toBe('1,240 calls · 3 changes');
  });
});

describe('outcome', () => {
  const call = (c: Partial<AgentCall>): AgentCall => ({ at: NOW, tool: 'update_screen', result: 'ok', change: false, needs: null, target: null, ...c });
  it('says a read, a change, a refusal as the ticket words it, and the rest as what it was', () => {
    expect(outcome(call({}))).toBe('Read');
    expect(outcome(call({ change: true }))).toBe('Changed');
    expect(outcome(call({ result: 'forbidden', needs: 'screens:manage' }))).toBe('Refused · Needs screens:manage');
    expect(outcome(call({ result: 'forbidden' }))).toBe('Refused');
    expect(outcome(call({ result: 'rate_limited' }))).toBe('Refused · Over its limit');
    expect(outcome(call({ result: 'not_found' }))).toBe('Not found');
    expect(outcome(call({ result: 'unavailable' }))).toBe('Failed');
    expect(outcome(call({ result: 'error' }))).toBe('Failed');
    // A code this page has no words for yet.
    expect(outcome(call({ result: 'payload_too_large' }))).toBe('Failed');
  });
});
