// The screen page's editors in the store: the settings and display hours drafts. Tool calls go
// through a stubbed `fetch` that answers from a queue the test fills; nothing waits on a clock.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { GroupView, ScreenView } from '../src/lib/screen-types';
import { createScreensSlice, editorDraft, type ScreensSlice } from '../src/state/screens';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));

const ORG = 'org_1';
const screen: ScreenView = {
  id: 'scr_1',
  name: 'Lobby',
  timezone: 'UTC',
  orientation: 'landscape',
  displayHours: null,
  version: 3,
} as never;
const groups: GroupView[] = [];

/** Each tool call, and the answers to give them in turn: a body, or `null` for a request that gets no answer. */
let calls: { name: string; input: Record<string, unknown> }[] = [];
let replies: (Reply | null | Promise<Reply | null>)[] = [];
type Reply = { status: number; body: unknown };
const router = { invalidate: vi.fn(async () => {}), state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };

function screensStore() {
  return createStore<ScreensSlice>()((set, get) => createScreensSlice(set as never, get as never, { router, queryClient: {} } as never));
}

beforeEach(() => {
  calls = [];
  replies = [];
  router.invalidate.mockClear();
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    const reply = await (replies.length ? replies.shift() : { status: 200, body: {} });
    if (!reply) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

describe('the settings editor (versioned draft)', () => {
  it('a retry after the rename went through and a later step got no answer sends the version the rename made, and the same group key', async () => {
    const store = screensStore();
    store.getState().openScreenSettings(ORG, screen, []);
    store.getState().renameDraft('Front lobby');
    store.getState().nameNewGroup('Front');
    replies.push({ status: 200, body: { screen: { ...screen, name: 'Front lobby', version: 4 } } }, null);
    await store.getState().saveScreenSettings(screen, groups);
    expect(calls.map((c) => c.name)).toEqual(['rename_screen', 'create_group']);
    expect(editorDraft(store.getState().screens)).toMatchObject({ error: 'Could not reach SignForge. Check your connection and try again.', stale: false });

    // The page has not read the screen again: the retry compares with what it showed.
    replies.push({ status: 200, body: { screen: { ...screen, name: 'Front lobby', version: 5 } } }, { status: 200, body: { group: { id: 'grp_1' } } });
    await store.getState().saveScreenSettings(screen, groups);
    expect(calls.slice(2)).toMatchObject([
      { name: 'rename_screen', input: { ifVersion: 4 } },
      { name: 'create_group', input: { name: 'Front', idempotencyKey: calls[1]!.input.idempotencyKey } },
    ]);
    expect(store.getState().screens.page.editing).toBeNull();
    expect(editorDraft(store.getState().screens)).toBeUndefined();
  });

  it('a conflict keeps the hours edited, marks them stale, and saves nothing more until Reload', async () => {
    const store = screensStore();
    store.getState().openDisplayHours(ORG, screen);
    const hours = { weekly: [{ days: [1], from: '08:00', to: '18:00' }] };
    store.getState().editDraftHours(hours);
    replies.push({ status: 409, body: { error: 'conflict', message: 'stale', details: { version: 4 } } });
    await store.getState().saveDisplayHours(screen);
    expect(editorDraft(store.getState().screens)).toMatchObject({ stale: true, edit: { hours }, error: 'This changed since you opened it.' });
    await store.getState().saveDisplayHours(screen);
    expect(calls).toHaveLength(1);

    await store.getState().reloadScreenEditor();
    expect(store.getState().screens.drafts).toEqual({});
    expect(store.getState().screens.page.notice?.text).toMatch(/^Reloaded/);
  });

  it('the settings and hours drafts are of one screen: a save of one waits for the other, and builds on the version it made (review of #153)', async () => {
    let answer: (r: Reply) => void = () => {};
    const store = screensStore();
    store.getState().openScreenSettings(ORG, screen, []);
    store.getState().renameDraft('Front lobby');
    replies.push(new Promise<Reply>((resolve) => (answer = resolve)));
    const renaming = store.getState().saveScreenSettings(screen, groups);
    // Closed while it saves, and the hours opened and saved.
    store.getState().closeScreenEditor();
    store.getState().openDisplayHours(ORG, screen);
    store.getState().editDraftHours(null);
    const hours = store.getState().saveDisplayHours(screen);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.map((c) => c.name)).toEqual(['rename_screen']);
    answer({ status: 200, body: { screen: { ...screen, name: 'Front lobby', version: 4 } } });
    await Promise.all([renaming, hours]);
    expect(calls[1]).toMatchObject({ name: 'update_screen_settings', input: { displayHours: null, ifVersion: 4 } });
  });

  it('a settings dialog closed while it saves and opened again before the answer conflicts, rather than undoing that save (re-check of #153)', async () => {
    let answer: (r: Reply) => void = () => {};
    const store = screensStore();
    store.getState().openScreenSettings(ORG, screen, []);
    store.getState().renameDraft('Front lobby');
    replies.push(new Promise<Reply>((resolve) => (answer = resolve)));
    const renaming = store.getState().saveScreenSettings(screen, groups);
    store.getState().closeScreenEditor();
    // Opened again on the screen as the page read it before the rename.
    store.getState().openScreenSettings(ORG, screen, []);
    answer({ status: 200, body: { screen: { ...screen, name: 'Front lobby', version: 4 } } });
    await renaming;
    expect(editorDraft(store.getState().screens)?.version).toBe(3);
    // The page has read the rename; the reopened form, saved as it is, would put the old name back.
    await store.getState().saveScreenSettings({ ...screen, name: 'Front lobby', version: 4 } as never, groups);
    expect(calls[1]).toMatchObject({ name: 'rename_screen', input: { name: 'Lobby', ifVersion: 3 } });
  });
});
