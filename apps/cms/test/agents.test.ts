// Settings › API & agents' words for time (M4-07): when a grant was made, and its last use as /mcp
// records it, to the hour. Times are the test's, never the clock.
import { describe, expect, it } from 'vitest';
import { grantedOn, lastActive } from '../src/lib/agents';

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
