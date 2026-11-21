import { validateTableFeed } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { LIMITS, normaliseFeed, parseCsv, parseJsonTable } from '../src/index';
import menu from './fixtures/menu.csv?raw';
import { code, inLinearTime, linearMs } from './linear';

describe('CSV (RFC 4180, header row)', () => {
  it('reads quoted cells with commas, doubled quotes and line breaks, and skips blank lines', () => {
    const feed = parseCsv(menu);
    expect(feed).toEqual({
      columns: ['Item', 'Price', 'Description', 'Section', 'Tag'],
      rows: [
        ['Tomato soup', '4.50', 'Basil, cream', 'Starters', 'Vegan'],
        ['Fish "n" chips', '$12', '', 'Mains', 'Popular'],
        ["Shepherd's pie", '11', 'Lamb,\nmash', 'Mains', ''],
        ['Lemon tart', '6.25', '', 'Desserts', 'New'],
      ],
    });
    expect(validateTableFeed(feed)).toEqual([]);
  });

  it('takes CRLF, a byte order mark, short rows padded and trailing empty columns dropped', () => {
    expect(parseCsv('﻿Item, Price ,,\r\nTea,2,,\r\nCake\r\n')).toEqual({
      columns: ['Item', 'Price'],
      rows: [
        ['Tea', '2'],
        ['Cake', ''],
      ],
    });
  });

  it('refuses a file that is not a table, as malformed', () => {
    expect(code(() => parseCsv(''))).toBe('malformed');
    expect(code(() => parseCsv('Item,Price\n"Tea,2\n'))).toBe('malformed');
    expect(code(() => parseCsv('Item,Price\n"Tea"x,2\n'))).toBe('malformed');
    expect(code(() => parseCsv('Item,Item\nTea,2\n'))).toBe('malformed');
    expect(code(() => parseCsv('Item,,Price\nTea,hot,2\n'))).toBe('malformed');
    expect(code(() => parseCsv('Item,Price\nTea,2,extra\n'))).toBe('malformed');
  });

  it('refuses a table too big for a snapshot before it builds the rows: short rows under a wide header', () => {
    const wide = (columns: number, rows: number) => [Array.from({ length: columns }, (_, i) => `c${i}`).join(','), ...Array(rows).fill('x')].join('\n');
    // 20 kB: 3000 columns by 3000 rows would be 9M cells.
    expect(code(() => parseCsv(wide(3000, 3000)))).toBe('too-large');
    // Just under 1 MB.
    const big = wide(40_000, 300_000);
    expect(big.length).toBeLessThan(LIMITS.maxBytes);
    expect(code(() => parseCsv(big))).toBe('too-large');
    // A table that can fit is still read.
    expect(parseCsv(wide(16, 2000)).rows).toHaveLength(2000);
  });

  // A Worker has 30 s of CPU, and a poll run carries other orgs' sources: every refusal is quick, whatever the header's width.
  it('reads a wide header in time linear in the body', { timeout: 120_000 }, () => {
    const base = linearMs();
    const timed = (body: string) => {
      expect(body.length).toBeLessThanOrEqual(LIMITS.maxBytes);
      const result = code(() => parseCsv(body));
      return { result: result === 'no error' ? 'ok' : result, fast: inLinearTime(() => parseCsv(body), base) };
    };
    // 460 kB: a named column and 400,000 unnamed ones over 30,000 short rows, under the row cap, so every
    // check runs; it reads as one column. A scan of every row per unnamed column took 13 s.
    expect(timed(`a${','.repeat(400_000)}\n${'x\n'.repeat(30_000)}`)).toEqual({ result: 'ok', fast: true });
    // 300 kB and 1 MB: the same over 100,000 and 250,000 rows, more than any snapshot can hold, so
    // reading stops at the row cap before any column check.
    expect(timed(`a${','.repeat(100_000)}\n${'x\n'.repeat(100_000)}`)).toEqual({ result: 'too-large', fast: true });
    expect(timed(`a${','.repeat(500_000)}\n${'x\n'.repeat(249_999)}`)).toEqual({ result: 'too-large', fast: true });
    // 1 MB: one line of 135,000 distinct names, the last a repeat. A scan of every name per name took 22.9 s.
    const names = Array.from({ length: 135_000 }, (_, i) => `c${i}`);
    expect(timed([...names, 'c0'].join(','))).toEqual({ result: 'malformed', fast: true });
    // A cell under an unnamed column is still found, wherever it is.
    expect(timed(`a,,b\n1,,2\n3,x,4\n`)).toEqual({ result: 'malformed', fast: true });
    // 1 MB of one-character lines: refused by the row cap itself, once there are more rows than any snapshot can hold.
    const lines = `a\n${'x\n'.repeat(499_000)}`;
    expect(timed(lines)).toEqual({ result: 'too-large', fast: true });
    expect(() => parseCsv(lines)).toThrow(/^more than \d+ rows cannot fit a snapshot$/);
  });

  it('refuses a body over the size limit before reading it', () => {
    expect(code(() => parseCsv(`Item\n${'x'.repeat(50)}`, { maxBytes: 40 }))).toBe('too-large');
  });
});

describe('JSON (a list of objects, or a path to one)', () => {
  it('makes columns of every key in the order first seen; numbers stay numbers, nested values are empty', () => {
    const body = JSON.stringify({
      data: {
        items: [
          { name: 'Tea', price: 2.5 },
          { name: 'Cake', vegan: true, sizes: [1, 2], note: null },
        ],
      },
    });
    expect(parseJsonTable(body, { rowsPath: 'data.items' })).toEqual({
      columns: ['name', 'price', 'vegan', 'sizes', 'note'],
      rows: [
        ['Tea', 2.5, '', '', ''],
        ['Cake', '', 'true', '', ''],
      ],
    });
    expect(parseJsonTable('[{"a":1}]')).toEqual({ columns: ['a'], rows: [[1]] });
  });

  it('refuses a table too big for a snapshot before it builds the rows: objects that each have their own key', { timeout: 120_000 }, () => {
    const base = linearMs();
    // 71 kB: 6000 objects with one distinct key each would be 6000 x 6000 = 36M cells.
    const sparse = JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ [`k${i}`]: 1 })));
    expect(sparse.length).toBeLessThan(80_000);
    expect(code(() => parseJsonTable(sparse))).toBe('too-large');
    expect(inLinearTime(() => parseJsonTable(sparse), base)).toBe(true);
    // 1 MB: one object with 100,000 keys, and 333,000 empty objects.
    const wide = JSON.stringify([Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 1]))]);
    const many = JSON.stringify(Array(333_000).fill({}));
    for (const body of [wide, many]) expect(inLinearTime(() => parseJsonTable(body), base)).toBe(true);
  });

  it('refuses JSON that does not parse as malformed, and a path to anything but a list of objects as not-a-table', () => {
    expect(code(() => parseJsonTable('{"items":'))).toBe('malformed');
    expect(code(() => parseJsonTable('{"items":[]}'))).toBe('not-a-table');
    expect(code(() => parseJsonTable('{"items":[1,2]}', { rowsPath: 'items' }))).toBe('not-a-table');
    expect(code(() => parseJsonTable('[{"a":1}]', { rowsPath: 'missing' }))).toBe('not-a-table');
  });

  it('is what normaliseFeed gives for csv and json-table sources', () => {
    expect(normaliseFeed('csv', 'A\n1\n')).toEqual({ columns: ['A'], rows: [['1']] });
    expect(normaliseFeed('json-table', '{"r":[{"A":1}]}', { rowsPath: 'r' })).toEqual({ columns: ['A'], rows: [[1]] });
  });
});
