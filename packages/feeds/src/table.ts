/**
 * Tables: a CSV file (RFC 4180, with a header row) or a JSON list of objects, as the contract's
 * `TableFeed`. Spots map its rows onto a list field's items (`TableMapping`).
 */
import { readPath, type TableFeed } from '@signforge/contract';
import { checkSize, FeedError, LIMITS } from './errors';

export interface TableOptions {
  maxBytes?: number;
  /** JSON only: the dot path to the list of objects. Absent: the document is the list. */
  rowsPath?: string;
}

const malformed = (message: string) => new FeedError('malformed', message);

/** RFC 4180 records: commas between cells, quotes around a cell that holds commas, quotes or line breaks, CRLF or LF between records. */
function records(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  /** The cell was quoted: an empty one is still a cell at the end of the file. */
  let quoted = false;
  let i = 0;
  const end = () => {
    row.push(cell);
    cell = '';
    quoted = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' && cell === '' && !quoted) {
      const close = () => {
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] !== '"') continue;
          if (text[j + 1] === '"') {
            j++;
            continue;
          }
          return j;
        }
        throw malformed(`record ${out.length + 1} opens a quote it never closes`);
      };
      const j = close();
      cell = text.slice(i + 1, j).replaceAll('""', '"');
      i = j + 1;
      quoted = true;
      if (i < text.length && !',\r\n'.includes(text[i] ?? '')) throw malformed(`record ${out.length + 1} has text after a closing quote`);
      continue;
    }
    if (c === ',') {
      end();
      i++;
    } else if (c === '\r' || c === '\n') {
      end();
      out.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== '' || quoted || row.length) {
    end();
    out.push(row);
  }
  return out;
}

/** A CSV file as a TableFeed. Blank lines are skipped, short rows padded with empty cells, and empty columns with no name dropped. */
export function parseCsv(body: string, options: TableOptions = {}): TableFeed {
  checkSize(body, options.maxBytes ?? LIMITS.maxBytes);
  const [header, ...rest] = records(body.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) throw malformed('the file has no header row');
  const rows = rest.map((r, i) => {
    if (r.length > header.length && r.slice(header.length).some((c) => c.trim() !== ''))
      throw malformed(`row ${i + 1} has ${r.length} cells and the header ${header.length}`);
    return header.map((_, k) => r[k] ?? '');
  });
  const names = header.map((h) => h.trim());
  const keep = names.flatMap((name, k) => {
    if (name) return [k];
    if (rows.some((r) => r[k]?.trim())) throw malformed(`column ${k + 1} has cells but no name`);
    return [];
  });
  const columns = keep.map((k) => names[k] ?? '');
  const twice = columns.find((c, k) => columns.indexOf(c) !== k);
  if (twice !== undefined) throw malformed(`two columns are named "${twice.slice(0, 40)}"`);
  return { columns, rows: rows.map((r) => keep.map((k) => r[k] ?? '')) };
}

/** A JSON value as a cell: text and numbers as they are, true and false as words, anything else empty. */
function cell(v: unknown): string | number {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return String(v);
  return '';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON list of objects (the document, or the list at `rowsPath`) as a TableFeed: every key a column, in the order first seen. */
export function parseJsonTable(body: string, options: TableOptions = {}): TableFeed {
  checkSize(body, options.maxBytes ?? LIMITS.maxBytes);
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
    throw new FeedError('malformed', 'not JSON', { cause: e });
  }
  const list = options.rowsPath ? readPath(doc, options.rowsPath) : doc;
  if (!Array.isArray(list) || !list.every(isRecord))
    throw new FeedError('not-a-table', options.rowsPath ? `${options.rowsPath} is not a list of objects` : 'the document is not a list of objects');
  const columns = [...new Set(list.flatMap((o) => Object.keys(o).filter(Boolean)))];
  return { columns, rows: list.map((o) => columns.map((c) => cell(Object.hasOwn(o, c) ? o[c] : undefined))) };
}
