import { validateTableFeed } from '@signforge/contract';
import { describe, expect, it } from 'vitest';
import { FeedError, normaliseFeed, parseCsv, parseJsonTable } from '../src/index';
import menu from './fixtures/menu.csv?raw';

const code = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    return e instanceof FeedError ? e.code : e;
  }
  return 'no error';
};

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
