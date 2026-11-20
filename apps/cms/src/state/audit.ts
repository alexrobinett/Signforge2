/**
 * The Audit log's CSV export: every entry the page's filters match, newest first, read a page at
 * a time from the browser (`list_audit_log`) into the file, up to EXPORT_LIMIT entries. The rows
 * are the page's own words, and inputs as recorded, so what was redacted stays redacted.
 */
import { csvLine, CSV_HEADER, type AuditEntry } from '~/lib/audit';
import { auditPageOf, callTool, toolMessage } from '~/lib/tools';
import type { SliceCreator } from './store';

/** At most this many entries in one file (50 calls of 200): a bigger log is exported a filter at a time. */
const EXPORT_LIMIT = 10_000;
const EXPORT_PAGE = 200;

interface AuditState {
  /** The log's text search, kept here and out of the URL: it can be an email or a name (#140). */
  query: string;
  exporting: boolean;
  /** What the last export did, or why it failed. */
  exportNote: { text: string; failed: boolean } | null;
}

export interface AuditSlice {
  audit: AuditState;
  /** Searches the log for `query` (trimmed); empty shows it all. */
  searchAuditLog: (query: string) => void;
  /** Downloads the entries `input` matches as CSV, each row as `row` words it. */
  exportAuditLog: (input: Record<string, unknown>, row: (e: AuditEntry) => string[]) => Promise<void>;
}

export const createAuditSlice: SliceCreator<AuditSlice> = (set) => {
  const audit = (change: Partial<AuditState>) => set((s) => ({ audit: { ...s.audit, ...change } }));
  return {
    audit: { query: '', exporting: false, exportNote: null },

    searchAuditLog(query) {
      audit({ query: query.trim() });
    },

    async exportAuditLog(input, row) {
      audit({ exporting: true, exportNote: null });
      // One string per page, so a page's lines are joined as it arrives. The byte order mark makes Excel read UTF-8.
      const parts = [`\uFEFF${csvLine(CSV_HEADER)}`];
      let count = 0;
      let cursor: string | null = null;
      try {
        do {
          const page = auditPageOf(await callTool('list_audit_log', { ...input, limit: EXPORT_PAGE, ...(cursor ? { cursor } : {}) }));
          parts.push(
            page.entries
              .slice(0, EXPORT_LIMIT - count)
              .map((e) => csvLine(row(e)))
              .join(''),
          );
          count = Math.min(EXPORT_LIMIT, count + page.entries.length);
          cursor = page.next;
        } while (cursor && count < EXPORT_LIMIT);
      } catch (err) {
        // A refusal mid-way (another org's cursor, after a switch in another tab) leaves no file: never a part of one org's log.
        audit({ exporting: false, exportNote: { text: toolMessage(err), failed: true } });
        return;
      }
      const url = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      const capped = cursor ? ` The newest ${EXPORT_LIMIT.toLocaleString('en-GB')}: narrow the filters for older ones.` : '';
      audit({
        exporting: false,
        exportNote: { text: `Exported ${count.toLocaleString('en-GB')} ${count === 1 ? 'entry' : 'entries'}.${capped}`, failed: false },
      });
    },
  };
};
