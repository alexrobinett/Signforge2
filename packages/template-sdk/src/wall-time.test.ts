// A date or datetime field's value as the instant it falls on in the screen's zone (#192). Every
// instant is fixed: none comes from the clock this test runs on.
import { describe, expect, it, vi } from 'vitest';
import { wallTime } from './wall-time';

const at = (timezone: string, value: string) => wallTime({ timezone }, value).toISOString();

describe('wallTime', () => {
  it("reads a datetime's wall time in the screen's zone, so one value is that hour on every screen", () => {
    expect(at('UTC', '2026-11-27T18:00')).toBe('2026-11-27T18:00:00.000Z');
    expect(at('America/New_York', '2026-11-27T18:00')).toBe('2026-11-27T23:00:00.000Z');
    expect(at('America/Los_Angeles', '2026-11-27T18:00')).toBe('2026-11-28T02:00:00.000Z');
    expect(at('Asia/Tokyo', '2026-11-27T18:00')).toBe('2026-11-27T09:00:00.000Z');
    expect(at('Asia/Kolkata', '2026-11-27T18:00')).toBe('2026-11-27T12:30:00.000Z');
    // Summer time where the zone keeps it.
    expect(at('America/New_York', '2026-07-04T21:00')).toBe('2026-07-05T01:00:00.000Z');
    expect(at('Europe/London', '2026-07-04T21:00')).toBe('2026-07-04T20:00:00.000Z');
  });

  it("reads a date as the start of that day in the screen's zone", () => {
    expect(at('America/New_York', '2026-11-27')).toBe('2026-11-27T05:00:00.000Z');
    expect(at('Australia/Sydney', '2026-11-27')).toBe('2026-11-26T13:00:00.000Z');
  });

  it('moves a wall time the clocks skip on by as much as they jumped, as Temporal does', () => {
    // New York jumps from 02:00 to 03:00 on 8 March 2026: 02:30 is read as 03:30 EDT.
    expect(at('America/New_York', '2026-03-08T02:30')).toBe('2026-03-08T07:30:00.000Z');
    expect(at('America/New_York', '2026-03-08T03:00')).toBe('2026-03-08T07:00:00.000Z');
    // London jumps from 01:00 to 02:00 on 29 March 2026: 01:30 is read as 02:30 BST.
    expect(at('Europe/London', '2026-03-29T01:30')).toBe('2026-03-29T01:30:00.000Z');
    // São Paulo jumped from 00:00 to 01:00 on 4 November 2018: that day began at 01:00.
    expect(at('America/Sao_Paulo', '2018-11-04')).toBe('2018-11-04T03:00:00.000Z');
  });

  it('takes the first of a wall time the clocks repeat, as Temporal does', () => {
    // New York goes back from 02:00 EDT to 01:00 EST on 1 November 2026: 01:30 happens twice.
    expect(at('America/New_York', '2026-11-01T01:30')).toBe('2026-11-01T05:30:00.000Z');
    expect(at('America/New_York', '2026-11-01T00:59')).toBe('2026-11-01T04:59:00.000Z');
    expect(at('America/New_York', '2026-11-01T02:00')).toBe('2026-11-01T07:00:00.000Z');
    // London goes back from 02:00 BST to 01:00 GMT on 25 October 2026.
    expect(at('Europe/London', '2026-10-25T01:30')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('reads years 1 to 99 as themselves, not as 1901 to 1999 as Date.UTC does: right without the contract, which refuses them', () => {
    expect(at('UTC', '0050-06-15T12:00')).toBe('0050-06-15T12:00:00.000Z');
    expect(at('UTC', '0001-01-01T00:00')).toBe('0001-01-01T00:00:00.000Z');
    expect(at('America/New_York', '1900-01-01')).toBe('1900-01-01T05:00:00.000Z');
  });

  it('makes one clock per time zone, so a list of dates in prepare does not build one a row on the Pi', () => {
    const made = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      for (const day of ['2026-11-27', '2026-11-28', '2026-11-29']) wallTime({ timezone: 'Pacific/Auckland' }, day);
      wallTime({ timezone: 'Pacific/Chatham' }, '2026-11-27');
      wallTime({ timezone: 'Pacific/Auckland' }, '2026-11-30T09:00');
      expect(made).toHaveBeenCalledTimes(2);
    } finally {
      made.mockRestore();
    }
  });
});
