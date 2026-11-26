/**
 * Screen labels as a CSV file (#188): what the Screens page downloads, and the plan an import makes from a file before
 * anything is written. The file is parsed once, where it comes in, by `@signforge/feeds`' `parseCsv` (the parser
 * table sources use); a download is read back by the same parser. Keys and values are checked by the tools' own rules
 * (`labelProblem` in `@signforge/compiler/selector`), in their words, so the preview refuses what the server would.
 */
import { labelProblem, SYSTEM_KEYS } from '@signforge/compiler/selector';
import { FeedError, readCsv } from '@signforge/feeds';
import type { ScreenView } from './screen-types';

/** The columns every file has: which screen a row is, by id, else by name. */
export const ID_COLUMN = 'screen_id';
export const NAME_COLUMN = 'name';

/**
 * A value a spreadsheet would run as a formula, or a cell that starts with the `'` that guards one (review of #612):
 * labels and names are anyone's text, an agent's included, and a download is opened in Excel or Sheets.
 */
const FORMULA = /^[=+\-@\t\r']/;

/**
 * A cell as the file writes it: a formula's first character guarded by a `'`, which a spreadsheet shows as text and
 * an import drops; quoted when it holds a quote, a comma, a line break or spaces at an edge.
 */
function cell(value: string) {
  const v = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** A cell as it was before `cell` guarded it: one leading `'` dropped where a guarded character follows it. */
const unguard = (v: string) => (v.startsWith("'") && FORMULA.test(v.slice(1)) ? v.slice(1) : v);

/**
 * The largest file an import reads (review of #612): a table spot's cell limit has no bearing on a label file. Sized
 * for 5,000 screens by an org's 100 keys and the two screen columns, and the bytes of a screen's 32 labels at most.
 */
const LABEL_FILE = { maxCells: 5000 * 102, maxBytes: 5000 * (32 * 66 + 200) };

/** The screens' labels as a CSV file: `screen_id, name`, then each key any of them has, in order; CRLF lines. */
export function labelsCsv(screens: readonly Pick<ScreenView, 'id' | 'name' | 'labels'>[]): string {
  const keys = [...new Set(screens.flatMap((s) => Object.keys(s.labels)))].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = [[ID_COLUMN, NAME_COLUMN, ...keys], ...screens.map((s) => [s.id, s.name, ...keys.map((k) => s.labels[k] ?? '')])];
  return `${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** A file read: its columns, its rows, and each row's number as a spreadsheet shows the file. */
export interface LabelFile {
  columns: string[];
  rows: string[][];
  rowAt: number[];
}

/** A file's rows by column, or why it cannot be read: parsed once, here, each cell as it was before the export guarded it. */
export function readLabelCsv(text: string): ({ ok: true } & LabelFile) | { ok: false; error: string } {
  try {
    const t = readCsv(text, LABEL_FILE);
    return { ok: true, columns: t.columns.map(unguard), rows: t.rows.map((r) => r.map(unguard)), rowAt: t.rowAt };
  } catch (err) {
    if (err instanceof FeedError) return { ok: false, error: `The file cannot be read: ${err.message}.` };
    throw err;
  }
}

/** How an import treats an empty cell: `merge` leaves the label as it is, `replace` removes it. */
export type ImportMode = 'merge' | 'replace';

/** One screen's part of an import: its labels added, changed and removed, and the merge that writes them. */
interface ScreenImport {
  screenId: string;
  name: string;
  added: [key: string, value: string][];
  changed: [key: string, from: string, to: string][];
  removed: [key: string, was: string][];
  set: Record<string, string>;
  remove: string[];
}

export interface ImportPlan {
  /** The screens whose labels change, by name. */
  changes: ScreenImport[];
  /** What stops the import: a column or a cell the server would refuse. Nothing is written while there is any. */
  problems: string[];
  /** Rows skipped, each said: no such screen, a name more than one screen has, a screen named twice. */
  skipped: string[];
}

/**
 * What importing a file would change, worked out before anything is sent. Rows find their screen by `screen_id`,
 * else by exact name; a header is a key as the editor takes one (trimmed, lowercased). `screens` are the org's, as
 * the page has them.
 */
export function importPlan({ columns, rows, rowAt }: LabelFile, screens: readonly ScreenView[], mode: ImportMode): ImportPlan {
  const problems: string[] = [];
  const skipped: string[] = [];
  const at = (name: string) => columns.findIndex((c) => c.trim().toLowerCase() === name);
  const idAt = at(ID_COLUMN);
  const nameAt = at(NAME_COLUMN);
  if (idAt < 0 && nameAt < 0) problems.push(`The file needs a ${ID_COLUMN} or a ${NAME_COLUMN} column to find each row's screen.`);
  // Label columns: every other, as the editor reads a key.
  const keyed = columns.flatMap((c, i) => (i === idAt || i === nameAt ? [] : [{ i, key: c.trim().toLowerCase() }]));
  const seen = new Set<string>();
  for (const { key } of keyed) {
    if (SYSTEM_KEYS.some((k) => k === key)) problems.push(`Column ${key}: a system label, set by the screen's settings.`);
    else if (seen.has(key)) problems.push(`Column ${key}: two columns are this key once lowercased. Keep one.`);
    else {
      const why = labelProblem(key, 'x');
      if (why) problems.push(`Column ${key}: ${why}.`);
    }
    seen.add(key);
  }
  const byId = new Map(screens.map((s) => [s.id, s]));
  const byName = new Map<string, ScreenView[]>();
  // Trimmed, as a cell is: a name with a space at an edge is found by it.
  for (const s of screens) byName.set(s.name.trim(), [...(byName.get(s.name.trim()) ?? []), s]);
  const named = new Set<string>();
  const changes: ScreenImport[] = [];
  rows.forEach((row, r) => {
    const line = rowAt[r]!;
    const id = idAt < 0 ? '' : (row[idAt] ?? '').trim();
    const name = nameAt < 0 ? '' : (row[nameAt] ?? '').trim();
    const sameName = byName.get(name) ?? [];
    const screen = id ? byId.get(id) : sameName.length === 1 ? sameName[0] : undefined;
    if (!screen) {
      skipped.push(
        id
          ? `Row ${line}: no screen ${id}.`
          : sameName.length > 1
            ? `Row ${line}: ${sameName.length} screens are named ${name}; give its screen_id.`
            : `Row ${line}: no screen named ${name || '(none)'}.`,
      );
      return;
    }
    if (named.has(screen.id)) {
      skipped.push(`Row ${line}: ${screen.name} is in an earlier row too; only the first is read.`);
      return;
    }
    named.add(screen.id);
    const plan: ScreenImport = { screenId: screen.id, name: screen.name, added: [], changed: [], removed: [], set: {}, remove: [] };
    for (const { i, key } of keyed) {
      const value = (row[i] ?? '').trim();
      const was = screen.labels[key];
      if (!value) {
        if (mode === 'replace' && was !== undefined) {
          plan.removed.push([key, was]);
          plan.remove.push(key);
        }
        continue;
      }
      const why = labelProblem(key, value);
      if (why) {
        problems.push(`Row ${line}, ${key}: ${why}.`);
        continue;
      }
      if (was === undefined) plan.added.push([key, value]);
      else if (was !== value) plan.changed.push([key, was, value]);
      else continue;
      plan.set[key] = value;
    }
    if (plan.added.length || plan.changed.length || plan.removed.length) changes.push(plan);
  });
  return { changes: changes.toSorted((a, b) => a.name.localeCompare(b.name)), problems: [...new Set(problems)], skipped };
}
