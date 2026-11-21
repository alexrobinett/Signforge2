// ⌘K's found screens and groups in the store (#180): what is typed, the actions shown, and an
// action run (a tool call, through a stubbed `fetch`, or a navigation). Nothing waits on a clock.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { TargetAction } from '../src/lib/command-menu';
import { createCommandMenuSlice, type CommandMenuSlice } from '../src/state/command-menu';
import { toast } from 'sonner';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

let calls: { name: string; input: unknown }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

function menuStore() {
  const router = { navigate: vi.fn(async () => {}), invalidate: vi.fn(async () => {}) };
  const store = createStore<CommandMenuSlice & { ui: object }>()((set, get) => ({
    ui: {},
    ...createCommandMenuSlice(set as never, get as never, { router } as never),
  }));
  return { store, router };
}

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: {} };
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

const identify: TargetAction = {
  kind: 'tool',
  label: 'Identify (10 s)',
  tool: 'identify_screen',
  screenId: 'scr_1',
  screenName: '0157 Drive-thru L',
  done: 'Sent.',
};

describe('⌘K on a found screen or group', () => {
  it('keeps what is typed through a target and Back, and starts empty when opened again', () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().searchCommands('0157');
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    expect(store.getState().commandMenu).toMatchObject({ query: '0157', target: { kind: 'screen', id: 'scr_1' } });
    store.getState().backToCommands();
    expect(store.getState().commandMenu).toMatchObject({ query: '0157', target: null });
    store.getState().closeCommandMenu();
    store.getState().openCommandMenu();
    expect(store.getState().commandMenu).toMatchObject({ open: true, query: '', target: null });
  });

  it("runs a screen's tool with its id, closes, and says so", async () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    await store.getState().runTargetAction(identify);
    expect(calls).toEqual([{ name: 'identify_screen', input: { screenId: 'scr_1' } }]);
    expect(store.getState().commandMenu).toMatchObject({ open: false, target: null, running: false });
    expect(toast.success).toHaveBeenCalledWith('Identify (10 s): 0157 Drive-thru L', { description: 'Sent.' });
  });

  it('stays open on the screen after a refusal, and says why', async () => {
    const { store } = menuStore();
    store.getState().openCommandMenu();
    store.getState().chooseTarget({ kind: 'screen', id: 'scr_1' });
    reply = { status: 403, body: { error: 'forbidden', message: 'Your role cannot do that.' } };
    await store.getState().runTargetAction(identify);
    expect(store.getState().commandMenu).toMatchObject({ open: true, target: { kind: 'screen', id: 'scr_1' }, running: false });
    expect(toast.error).toHaveBeenCalledWith('Identify (10 s): 0157 Drive-thru L', { description: 'Your role cannot do that.' });
  });

  it("opens a screen's page, and a group's screens on the Screens page, closing the menu", async () => {
    const { store, router } = menuStore();
    store.getState().openCommandMenu();
    await store.getState().runTargetAction({ kind: 'open-screen', label: 'Open', screenId: 'scr_1' });
    expect(router.navigate).toHaveBeenLastCalledWith({ to: '/screens/$screenId', params: { screenId: 'scr_1' } });
    expect(store.getState().commandMenu.open).toBe(false);
    store.getState().openCommandMenu();
    await store.getState().runTargetAction({ kind: 'open-group', label: 'Show its screens', groupId: 'grp_1' });
    expect(router.navigate).toHaveBeenLastCalledWith({ to: '/screens', search: { group: 'grp_1' } });
    expect(store.getState().commandMenu.open).toBe(false);
    expect(calls).toEqual([]);
  });
});
