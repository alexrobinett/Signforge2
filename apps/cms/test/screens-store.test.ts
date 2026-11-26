// The screen page's editors in the store: the settings and display hours drafts. Tool calls go
// through a stubbed `fetch` that answers from a queue the test fills; nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { GroupView, ScreenView } from '../src/lib/screen-types';
import { screensQuery } from '../src/queries/screens';
import { createScreensSlice, editorDraft, selectedIn, type ScreensSlice } from '../src/state/screens';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/screens.functions', () => ({ getScreens: vi.fn(), getScreenStatus: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

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
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
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
    expect(calls.map((c) => c.name)).toEqual(['update_screen', 'save_group']);
    expect(editorDraft(store.getState().screens)).toMatchObject({ error: 'Could not reach SignForge. Check your connection and try again.', stale: false });

    // The page has not read the screen again: the retry compares with what it showed.
    replies.push({ status: 200, body: { screen: { ...screen, name: 'Front lobby', version: 5 } } }, { status: 200, body: { group: { id: 'grp_1' } } });
    await store.getState().saveScreenSettings(screen, groups);
    expect(calls.slice(2)).toMatchObject([
      { name: 'update_screen', input: { ifVersion: 4 } },
      { name: 'save_group', input: { name: 'Front', idempotencyKey: calls[1]!.input.idempotencyKey } },
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
    expect(calls.map((c) => c.name)).toEqual(['update_screen']);
    answer({ status: 200, body: { screen: { ...screen, name: 'Front lobby', version: 4 } } });
    await Promise.all([renaming, hours]);
    expect(calls[1]).toMatchObject({ name: 'update_screen', input: { displayHours: null, ifVersion: 4 } });
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
    expect(calls[1]).toMatchObject({ name: 'update_screen', input: { name: 'Lobby', ifVersion: 3 } });
  });
});

describe('the Screens table selection (#183)', () => {
  const front = { id: 'grp_front', name: 'Front', screenIds: ['scr_0'], version: 2 } as GroupView;

  function withList() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(screensQuery(ORG).queryKey, { screens: [], groups: [front], at: 0 });
    const store = createStore<ScreensSlice>()((set, get) => createScreensSlice(set as never, get as never, { router, queryClient } as never));
    return { store, queryClient };
  }

  it('adds the selected screens to a group in one call, and the page shows them in it', async () => {
    const { store, queryClient } = withList();
    replies.push({ status: 200, body: { group: { ...front, screenIds: ['scr_0', 'scr_1', 'scr_2', 'scr_3'], version: 3 } } });
    await store.getState().addScreensToGroup(ORG, front, ['scr_1', 'scr_2', 'scr_3']);
    expect(calls).toEqual([{ name: 'save_group', input: { groupId: 'grp_front', screenIds: ['scr_1', 'scr_2', 'scr_3'], membership: 'add' } }]);
    expect(queryClient.getQueryData(screensQuery(ORG).queryKey)?.groups[0]).toMatchObject({ screenIds: ['scr_0', 'scr_1', 'scr_2', 'scr_3'], version: 3 });
    expect(toast.success).toHaveBeenCalledWith('Added 3 screens to Front');
  });

  it('removes them from a group in one call', async () => {
    const { store } = withList();
    replies.push({ status: 200, body: { group: { ...front, screenIds: [], version: 3 } } });
    await store.getState().removeScreensFromGroup(ORG, front, ['scr_0', 'scr_1']);
    expect(calls).toEqual([{ name: 'save_group', input: { groupId: 'grp_front', screenIds: ['scr_0', 'scr_1'], membership: 'remove' } }]);
    expect(toast.success).toHaveBeenCalledWith('Removed 2 screens from Front');
  });

  it('a refusal is said, and the selection kept to try again', async () => {
    const { store } = withList();
    store.getState().selectScreens(ORG, ['scr_1', 'scr_2'], true);
    replies.push({ status: 404, body: { error: 'not_found', message: 'group grp_front not found' } });
    await store.getState().addScreensToGroup(ORG, front, ['scr_1', 'scr_2']);
    expect(toast.error).toHaveBeenCalledWith('Not added to Front', { description: 'group grp_front not found' });
    expect(selectedIn(store.getState().screens, ORG)).toEqual(['scr_1', 'scr_2']);
  });

  it('a second bulk change while one is on its way is ignored', async () => {
    const { store } = withList();
    let answer: (r: Reply) => void = () => {};
    replies.push(new Promise<Reply>((resolve) => (answer = resolve)));
    const first = store.getState().addScreensToGroup(ORG, front, ['scr_1']);
    expect(store.getState().screens.bulkPending).toBe(true);
    await store.getState().removeScreensFromGroup(ORG, front, ['scr_1']);
    answer({ status: 200, body: { group: front } });
    await first;
    expect(calls.map((c) => c.name)).toEqual(['save_group']);
    expect(store.getState().screens.bulkPending).toBe(false);
  });

  it('selects and unselects rows, all shown at once too, and a selection belongs to its org', () => {
    const { store } = withList();
    store.getState().selectScreens(ORG, ['scr_1', 'scr_2'], true);
    store.getState().selectScreens(ORG, ['scr_2'], false);
    store.getState().selectScreens(ORG, ['scr_1', 'scr_3'], true);
    expect(selectedIn(store.getState().screens, ORG)).toEqual(['scr_1', 'scr_3']);
    expect(selectedIn(store.getState().screens, 'org_2')).toEqual([]);
    // Selecting in another org starts that org's selection afresh.
    store.getState().selectScreens('org_2', ['scr_9'], true);
    expect(selectedIn(store.getState().screens, 'org_2')).toEqual(['scr_9']);
    store.getState().clearScreenSelection();
    expect(selectedIn(store.getState().screens, 'org_2')).toEqual([]);
  });
});
