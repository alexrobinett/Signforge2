/**
 * Tables: a CSV file (RFC 4180, with a header row) or a JSON list of objects, as the contract's
 * `TableFeed`. Spots map its rows onto a list field's items (`TableMapping`).
 */
import { MAX_SNAPSHOT_BYTES, readPath, type TableFeed } from '@signforge/contract';
import { checkSize, FeedError, LIMITS } from './errors';

export interface TableOptions {
  maxBytes?: number;
  /** CSV only: the most cells the table may have; a table spot's is what can fit a snapshot (`MAX_CELLS`). */
  maxCells?: number;
  /** JSON only: the dot path to the list of objects. Absent: the document is the list. */
  rowsPath?: string;
}

const malformed = (message: string) => new FeedError('malformed', message);

/**
 * The most cells a table may have. Every cell costs at least 2 bytes of a snapshot's JSON (a
 * one-digit number and its comma), so a table with more can never fit `MAX_SNAPSHOT_BYTES`. It is
 * checked before the rows are built: padding every row to every column turns a small body (keys
 * that each appear once, short rows under a wide header) into millions of cells, past a Worker's
 * memory.
 */
const MAX_CELLS = MAX_SNAPSHOT_BYTES / 2;

function refuseOversized(columns: number, rows: number, maxCells = MAX_CELLS): void {
  if (columns * rows > maxCells) throw new FeedError('too-large', `${columns} columns by ${rows} rows is more than the ${maxCells} cells a table may have`);
}

/**
 * RFC 4180 records: commas between cells, quotes around a cell that holds commas, quotes or line
 * breaks, CRLF or LF between records. Blank records are skipped. More records than `MAX_CELLS`
 * (a header and a row per cell) can never fit a snapshot, so reading stops there as `too-large`
 * rather than hold an array for each of a million one-character lines.
 */
function records(text: string, maxCells: number): { out: string[][]; rowAt: number[] } {
  const out: string[][] = [];
  /** Each record's row as a spreadsheet shows the file: blank records counted, a quoted line break not. */
  const rowAt: number[] = [];
  let read = 0;
  const keep = (r: string[]) => {
    read++;
    if (!r.some((c) => c.trim() !== '')) return;
    if (out.length > maxCells) throw new FeedError('too-large', `the file has more than ${maxCells} rows`);
    out.push(r);
    rowAt.push(read);
  };
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
      keep(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== '' || quoted || row.length) {
    end();
    keep(row);
  }
  return { out, rowAt };
}

/** A CSV file as a TableFeed. Blank lines are skipped, short rows padded with empty cells, and empty columns with no name dropped. */
export function parseCsv(body: string, options: TableOptions = {}): TableFeed {
  const { columns, rows } = readCsv(body, options);
  return { columns, rows };
}

/**
 * A CSV file as `parseCsv` reads it, with each row's number as a spreadsheet shows the file (`rowAt`, the header
 * row 1), for a reader that names the row a problem is in.
 */
export function readCsv(body: string, options: TableOptions = {}): { columns: string[]; rows: string[][]; rowAt: number[] } {
  checkSize(body, options.maxBytes ?? LIMITS.maxBytes);
  const read = records(body.replace(/^﻿/, ''), options.maxCells ?? MAX_CELLS);
  const [header, ...rest] = read.out;
  const rowAt = read.rowAt.slice(1);
  if (!header) throw malformed('the file has no header row');
  rest.forEach((r, i) => {
    if (r.length > header.length && r.slice(header.length).some((c) => c.trim() !== ''))
      throw malformed(`row ${rowAt[i]} has ${r.length} cells and the header ${header.length}`);
  });
  const names = header.map((h) => h.trim());
  // One pass over the cells, and one over the names: a scan of every row per column, or of every
  // name per name, takes seconds on a wide header, past a Worker's CPU limit before the size check.
  // Cells past the header are known blank (above).
  for (const r of rest)
    r.forEach((c, k) => {
      if (k < names.length && !names[k] && c.trim()) throw malformed(`column ${k + 1} has cells but no name`);
    });
  const keep = names.flatMap((name, k) => (name ? [k] : []));
  const columns = keep.map((k) => names[k] ?? '');
  const seen = new Set<string>();
  const twice = columns.find((c) => seen.size === seen.add(c).size);
  if (twice !== undefined) throw malformed(`two columns are named "${twice.slice(0, 40)}"`);
  refuseOversized(columns.length, rest.length, options.maxCells);
  // Short rows padded with empty cells.
  return { columns, rows: rest.map((r) => keep.map((k) => r[k] ?? '')), rowAt };
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
  refuseOversized(columns.length, list.length);
  return { columns, rows: list.map((o) => columns.map((c) => cell(Object.hasOwn(o, c) ? o[c] : undefined))) };
}
