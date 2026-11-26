// The label editors in the store (#185): one merge into a screen's labels, a refusal kept on the editor, and the
// pairing form's labels claimed with the screen. Tool calls go through a stubbed `fetch`; nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ScreenView } from '../src/lib/screen-types';
import { MAX_BULK_SCREENS } from '../src/lib/labels';
import { connectLabels, createLabelsSlice, labelRowsOf, type LabelsSlice } from '../src/state/labels';
import { createScreensSlice, searchText, type ScreensSlice } from '../src/state/screens';

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

describe('rows that cannot be saved as they are (review of #597)', () => {
  it('sends nothing for two rows of one key, keeps the editor open and says why, then saves once one goes', async () => {
    const s = store();
    s.getState().editScreenLabels(screen);
    const target = { screenId: screen.id };
    s.getState().typeLabel(target, 2, { key: 'Region', value: 'south' });
    await s.getState().saveScreenLabels(ORG, screen);
    expect(calls).toEqual([]);
    expect(s.getState().labels.editor).toMatchObject({ screenId: screen.id, pending: false, error: 'Fix the labels marked above first.' });
    s.getState().removeLabelRow(target, 0);
    await s.getState().saveScreenLabels(ORG, screen);
    expect(calls).toEqual([{ name: 'update_screen_labels', input: { screenIds: [screen.id], set: { region: 'south' }, remove: [] } }]);
  });

  it('pairs no screen while a label has a key and no value, and says why', async () => {
    const s = store();
    s.getState().addLabelRow('pairing');
    s.getState().typeLabel('pairing', 0, { key: 'store', value: '' });
    s.getState().enterPairingCode('ABC123');
    s.getState().nameNewScreen('Till 3');
    await s.getState().pairScreen({ timezone: 'UTC', locale: null, hours: null });
    expect(calls).toEqual([]);
    expect(s.getState().screens.pairing).toMatchObject({ pending: false, error: 'Fix the labels marked above first.' });
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

describe('the Screens page’s search and "+ Filter" (review of #601)', () => {
  it('shows the search as typed while its URL write is on its way, and the URL’s q once none is', async () => {
    const s = store();
    let arrive!: () => void;
    router.navigate.mockImplementationOnce(() => new Promise<void>((done) => (arrive = done)));
    const typing = s.getState().searchScreens('driveX north');
    // The URL still says what it said: the box shows what was typed, so its caret stays.
    expect(searchText(s.getState().screens, 'drive north')).toBe('driveX north');
    arrive();
    await typing;
    expect(searchText(s.getState().screens, 'driveX north')).toBe('driveX north');
    // Nothing on its way: a Back that changes q shows the URL's.
    expect(searchText(s.getState().screens, 'lobby')).toBe('lobby');
  });

  it('ticks and unticks a value however it is spelled', () => {
    const s = store();
    s.getState().openLabelFilter('region', ['North']);
    s.getState().tickFilterValue('north', false);
    expect(s.getState().labels.filter?.values).toEqual([]);
    s.getState().tickFilterValue('north', true);
    s.getState().tickFilterValue('NORTH ', true);
    expect(s.getState().labels.filter?.values).toEqual(['NORTH ']);
  });
});

describe('bulk "Labels…" on a selection', () => {
  it('sets one key to one value on every screen in one call, or removes it, and closes', async () => {
    const s = store();
    s.getState().openBulkLabels(ORG, ['scr_1', 'scr_2', 'scr_3']);
    s.getState().chooseBulkKey(' Store ');
    s.getState().typeBulkValue(' 0142 ');
    await s.getState().applyBulkLabels();
    expect(calls).toEqual([{ name: 'update_screen_labels', input: { screenIds: ['scr_1', 'scr_2', 'scr_3'], set: { store: '0142' } } }]);
    expect(s.getState().labels.bulk).toBeNull();

    s.getState().openBulkLabels(ORG, ['scr_1']);
    s.getState().chooseBulkKey('store');
    s.getState().chooseBulkMode('remove');
    await s.getState().applyBulkLabels();
    expect(calls[1]).toEqual({ name: 'update_screen_labels', input: { screenIds: ['scr_1'], remove: ['store'] } });
  });

  it('sends nothing without a key, or a value to set, and keeps a refusal on the dialog', async () => {
    const s = store();
    s.getState().openBulkLabels(ORG, ['scr_1']);
    s.getState().chooseBulkKey('store');
    await s.getState().applyBulkLabels();
    expect(calls).toEqual([]);
    expect(s.getState().labels.bulk?.error).toBe('Choose a label and a value.');

    s.getState().typeBulkValue('0142');
    replies.push({ status: 409, body: { error: 'conflict', message: 'a screen has at most 32 labels' } });
    await s.getState().applyBulkLabels();
    expect(s.getState().labels.bulk).toMatchObject({ pending: false, error: 'a screen has at most 32 labels' });
  });

  it('sends nothing for more screens than one change takes', async () => {
    const s = store();
    s.getState().openBulkLabels(
      ORG,
      Array.from({ length: MAX_BULK_SCREENS + 1 }, (_, i) => `scr_${i}`),
    );
    s.getState().chooseBulkKey('store');
    s.getState().typeBulkValue('0142');
    await s.getState().applyBulkLabels();
    expect(calls).toEqual([]);
    expect(s.getState().labels.bulk).toMatchObject({ pending: false, error: null });
  });

  it('leaves a dialog opened since alone when a cancelled save answers, as a refusal or as done', async () => {
    for (const reply of [
      { status: 409, body: { error: 'conflict', message: 'a screen has at most 32 labels' } },
      { status: 200, body: {} },
    ]) {
      const s = store();
      let answer: () => void = () => {};
      const answered = new Promise<void>((r) => (answer = r));
      vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
        calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
        await answered;
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      });
      s.getState().openBulkLabels(ORG, ['scr_1']);
      s.getState().chooseBulkKey('store');
      s.getState().typeBulkValue('0142');
      const saving = s.getState().applyBulkLabels();
      // Cancelled while it saves, and another selection's dialog opened before the reply comes.
      s.getState().closeBulkLabels();
      s.getState().openBulkLabels(ORG, ['scr_2', 'scr_3']);
      s.getState().chooseBulkKey('region');
      answer();
      await saving;
      expect(s.getState().labels.bulk).toMatchObject({ screenIds: ['scr_2', 'scr_3'], key: 'region', pending: false, error: null });
    }
  });

  it('closes when the page is left, so coming back opens no old draft', () => {
    const s = store();
    let navigated: (e: { pathChanged: boolean }) => void = () => {};
    connectLabels(s as never, { router: { subscribe: (_: string, fn: typeof navigated) => (navigated = fn) } } as never);
    s.getState().openBulkLabels(ORG, ['scr_1']);
    s.getState().chooseBulkKey('store');
    // A filter or a sort on the page itself keeps it.
    navigated({ pathChanged: false });
    expect(s.getState().labels.bulk).toMatchObject({ key: 'store' });
    navigated({ pathChanged: true });
    expect(s.getState().labels.bulk).toBeNull();
  });
});

describe('"Import labels…" (#188)', () => {
  const lobby = { id: 'scr_1', name: 'Lobby', labels: { region: 'north' }, systemLabels: {} } as unknown as ScreenView;
  const till = { id: 'scr_2', name: 'Till', labels: {}, systemLabels: {} } as unknown as ScreenView;
  const file = (text: string) => new File([text], 'labels.csv', { type: 'text/csv' });

  it('reads the file once, and sends each screen its own change in one import_screen_labels', async () => {
    const s = store();
    s.getState().openLabelImport(ORG);
    await s.getState().readLabelFile(file('﻿screen_id,name,region,store\r\nscr_1,,south,0142\r\n,Till,,9\r\n'));
    expect(s.getState().labels.import?.file?.columns).toEqual(['screen_id', 'name', 'region', 'store']);
    await s.getState().applyLabelImport([lobby, till]);
    expect(calls).toEqual([
      {
        name: 'import_screen_labels',
        input: {
          screens: [
            { screenId: 'scr_1', set: { region: 'south', store: '0142' }, remove: [] },
            { screenId: 'scr_2', set: { store: '9' }, remove: [] },
          ],
        },
      },
    ]);
    expect(s.getState().labels.import).toBeNull();
  });

  it('sends nothing for a file that cannot be read, or has a refused column, and keeps a refusal on the dialog', async () => {
    const s = store();
    s.getState().openLabelImport(ORG);
    await s.getState().readLabelFile(file('screen_id,region\nscr_1,"north\n'));
    expect(s.getState().labels.import).toMatchObject({ file: null, error: expect.stringMatching(/cannot be read/) });
    await s.getState().readLabelFile(file('screen_id,orientation\nscr_1,portrait\n'));
    await s.getState().applyLabelImport([lobby]);
    expect(calls).toEqual([]);
    expect(s.getState().labels.import?.error).toMatch(/Fix the file/);

    await s.getState().readLabelFile(file('screen_id,store\nscr_1,1\n'));
    replies.push({ status: 409, body: { error: 'conflict', message: 'a screen has at most 32 labels' } });
    await s.getState().applyLabelImport([lobby]);
    expect(s.getState().labels.import).toMatchObject({ pending: false, error: expect.stringMatching(/32 labels/) });
  });

  it('refuses before sending a file that changes more than 1000 screens', async () => {
    const s = store();
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `scr_m${i}`, name: `M${i}`, labels: {}, systemLabels: {} }) as unknown as ScreenView);
    s.getState().openLabelImport(ORG);
    await s.getState().readLabelFile(file(`screen_id,store\n${many.map((m) => `${m.id},1`).join('\n')}\n`));
    await s.getState().applyLabelImport(many);
    expect(calls).toEqual([]);
    expect(s.getState().labels.import?.error).toMatch(/at most 1000 screens; this file changes 1001/);
  });
});
