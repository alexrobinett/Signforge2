// The label editors in the store (#185): one merge into a screen's labels, a refusal kept on the editor, and the
// pairing form's labels claimed with the screen. Tool calls go through a stubbed `fetch`; nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ScreenView } from '../src/lib/screen-types';
import { createLabelsSlice, labelRowsOf, type LabelsSlice } from '../src/state/labels';
import { createScreensSlice, type ScreensSlice } from '../src/state/screens';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/screens.functions', () => ({ getScreens: vi.fn(), getScreenStatus: vi.fn(), getLabelKeys: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const ORG = 'org_1';
const screen = { id: 'scr_1', name: 'Lobby', labels: { region: 'north', store: '0142' }, systemLabels: {} } as unknown as ScreenView;

let calls: { name: string; input: Record<string, unknown> }[] = [];
let replies: { status: number; body: unknown }[] = [];
const router = {
  invalidate: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
  state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] },
};

function store() {
  const queryClient = new QueryClient();
  return createStore<LabelsSlice & ScreensSlice>()((set, get) => ({
    ...createLabelsSlice(set as never, get as never, { router, queryClient } as never),
    ...createScreensSlice(set as never, get as never, { router, queryClient } as never),
  }));
}

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

describe("a screen's label editor", () => {
  it('saves one merge: the keys changed or added, the keys taken out, and closes', async () => {
    const s = store();
    s.getState().editScreenLabels(screen);
    const target = { screenId: screen.id };
    // Its labels by key, then an empty row to type in.
    expect(labelRowsOf(s.getState().labels, target)).toEqual([
      { key: 'region', value: 'north' },
      { key: 'store', value: '0142' },
      { key: '', value: '' },
    ]);
    s.getState().typeLabel(target, 0, { key: 'region', value: ' south ' });
    s.getState().removeLabelRow(target, 1);
    s.getState().typeLabel(target, 1, { key: 'Type', value: 'kiosk' });
    await s.getState().saveScreenLabels(ORG, screen);
    expect(calls).toEqual([{ name: 'update_screen_labels', input: { screenIds: [screen.id], set: { region: 'south', type: 'kiosk' }, remove: ['store'] } }]);
    expect(s.getState().labels.editor).toBeNull();
  });

  it('sends nothing when nothing changed, and keeps a refusal on the open editor', async () => {
    const s = store();
    s.getState().editScreenLabels(screen);
    await s.getState().saveScreenLabels(ORG, screen);
    expect(calls).toEqual([]);

    s.getState().editScreenLabels(screen);
    s.getState().typeLabel({ screenId: screen.id }, 2, { key: 'name', value: 'x' });
    replies.push({ status: 400, body: { error: { code: 'invalid_input', message: 'name is not a label key' } } });
    await s.getState().saveScreenLabels(ORG, screen);
    expect(s.getState().labels.editor).toMatchObject({ screenId: screen.id, pending: false });
    expect(s.getState().labels.editor?.error).toBeTruthy();
  });
});

describe("the pairing form's labels", () => {
  it('copies another screen’s labels and claims the screen with them, then empties them', async () => {
    const s = store();
    s.getState().copyLabelsForPairing(screen.labels);
    s.getState().typeLabel('pairing', 2, { key: 'type', value: 'kiosk' });
    s.getState().enterPairingCode('ABC123');
    s.getState().nameNewScreen('Till 2');
    replies.push({ status: 200, body: { screen: { id: 'scr_2' } } });
    await s.getState().pairScreen({ timezone: 'UTC', locale: null, hours: null });
    expect(calls[0]).toMatchObject({ name: 'claim_screen', input: { labels: { region: 'north', store: '0142', type: 'kiosk' } } });
    expect(labelRowsOf(s.getState().labels, 'pairing')).toEqual([]);
  });
});
