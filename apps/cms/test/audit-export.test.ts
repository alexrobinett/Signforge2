// The Audit log's CSV export (store slice): every page into one file, members by name, a byte order
// mark for Excel; and a page refused part-way (another org's cursor, after a switch in another tab)
// leaves no file at all, only the refusal. Every page names the tab's org (#129), so a tab left on
// the old org is refused rather than given the new org's log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { csvRow, type AuditEntry } from '../src/lib/audit';
import { createAuditSlice, type AuditSlice } from '../src/state/audit';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({ 'x-signforge-org': 'org_north' }) }));

const entry = (at: number): AuditEntry => ({
  at,
  actor: { kind: 'user', id: 'usr_jun', clientId: 'cms' },
  action: 'rename_screen',
  target: { kind: 'screen', id: 'scr_1' },
  detail: { input: { screenId: 'scr_1', name: `Lobby ${at}` } },
});

/** `list_audit_log`'s answers, in order: an output, or a refusal with its status. */
let answers: { body: unknown; status: number }[] = [];
const cursors: (string | undefined)[] = [];
/** The org each call named. */
const orgs: (string | undefined)[] = [];
let files: Blob[] = [];

beforeEach(() => {
  answers = [];
  cursors.length = 0;
  orgs.length = 0;
  files = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      cursors.push((JSON.parse(init.body) as { cursor?: string }).cursor);
      orgs.push(init.headers['x-signforge-org']);
      const { body, status } = answers.shift()!;
      return new Response(JSON.stringify(body), { status });
    }),
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    files.push(blob as Blob);
    return 'blob:audit';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });
});
afterEach(() => vi.unstubAllGlobals());

function exporter() {
  const store = createStore<AuditSlice>()((set, get) => createAuditSlice(set as never, get as never, {} as never));
  const names = new Map([['usr_jun', 'Jun Takahashi']]);
  return { store, run: () => store.getState().exportAuditLog({ action: 'rename_screen' }, (e) => csvRow(e, names)) };
}

describe('exporting the audit log', () => {
  it('writes every page into one file, after a byte order mark, each member by name', async () => {
    answers = [
      { body: { entries: [entry(3), entry(2)], next: 'c1' }, status: 200 },
      { body: { entries: [entry(1)], next: null }, status: 200 },
    ];
    const { store, run } = exporter();
    await run();
    expect(cursors).toEqual([undefined, 'c1']);
    expect(orgs).toEqual(['org_north', 'org_north']);
    expect(files).toHaveLength(1);
    // text() drops a byte order mark, so read its bytes.
    expect([...new Uint8Array(await files[0]!.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await files[0]!.text();
    expect(text.startsWith('time,who,')).toBe(true);
    const lines = text.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(',Jun Takahashi,user,usr_jun,CMS,rename_screen,Renamed to Lobby 3,');
    expect(store.getState().audit.exportNote).toEqual({ text: 'Exported 3 entries.', failed: false });
  });

  it('leaves no file when a later page is refused, and says why', async () => {
    const message = 'cursor cannot be used: it was made in another organization; start again without it';
    answers = [
      { body: { entries: [entry(3)], next: 'c1' }, status: 200 },
      { body: { error: 'invalid_input', message, details: [{ path: 'cursor', message: 'x' }] }, status: 400 },
    ];
    const { store, run } = exporter();
    await run();
    expect(files).toEqual([]);
    expect(store.getState().audit).toEqual({ exporting: false, exportNote: { text: message, failed: true } });
  });

  it('leaves no file when the member switched org in another tab, and says to reload', async () => {
    const message = 'This tab is on Northside; you switched to Southside in another tab. Reload.';
    answers = [{ body: { error: 'org_changed', message }, status: 409 }];
    const { store, run } = exporter();
    await run();
    expect(orgs).toEqual(['org_north']);
    expect(files).toEqual([]);
    expect(store.getState().audit).toEqual({ exporting: false, exportNote: { text: message, failed: true } });
  });
});
