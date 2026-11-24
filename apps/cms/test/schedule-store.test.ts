// The Schedule page's dialogs in the store (#149): a create keeps one idempotency key until it is
// answered, so a retry after a lost answer makes no second entry or takeover; a change that
// conflicts keeps the edit and offers Reload. Tool calls go through a stubbed `fetch` that answers
// from a queue the test fills; nothing waits on a clock.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ScheduleEntryView } from '../src/lib/schedule';
import { scheduleKey } from '../src/queries/schedule';
import { createScheduleSlice, DIALOG, type ScheduleSlice } from '../src/state/schedule';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/schedule.functions', () => ({ getSchedule: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const ORG = 'org_1';

/** Each tool call, and the answers to give them in turn: a body, or `null` for a request that gets no answer. */
let calls: { name: string; input: Record<string, unknown> }[] = [];
type Reply = { status: number; body: unknown };
let replies: (Reply | null | Promise<Reply | null>)[] = [];
const router = { state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };

/** `sample`: what the question about sample text answers before a takeover is made (#360). */
function scheduleStore(sample: 'none' | 'allowed' | 'cancelled' = 'none') {
  const queryClient = new QueryClient();
  const publishSchedule = vi.fn(async () => true);
  const publishEntry = vi.fn(async () => true);
  const checkSampleText = vi.fn(async () => sample);
  const store = createStore<
    ScheduleSlice & { publishSchedule: typeof publishSchedule; publishEntry: typeof publishEntry; checkSampleText: typeof checkSampleText }
  >()((set, get) => ({
    ...createScheduleSlice(set as never, get as never, { router, queryClient } as never),
    publishSchedule,
    publishEntry,
    checkSampleText,
  }));
  return { store, queryClient, publishSchedule, publishEntry, checkSampleText };
}

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    const reply = await (replies.length ? replies.shift() : { status: 200, body: {} });
    if (!reply) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

const made = { status: 200, body: { entry: { id: 'sch_1' } } };

describe('a retried create (#149)', () => {
  it('a new entry whose answer was lost is sent again with the same idempotency key, and the dialog closes once answered', async () => {
    const { store } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_breakfast' });
    replies.push(null);
    await store.getState().saveEntry(ORG);
    expect(store.getState().schedule.entries[DIALOG]).toMatchObject({ error: 'Could not reach SignForge. Check your connection and try again.' });

    replies.push(made);
    await store.getState().saveEntry(ORG);
    expect(calls.map((c) => c.name)).toEqual(['create_schedule_entry', 'create_schedule_entry']);
    expect(calls[1]!.input.idempotencyKey).toBe(calls[0]!.input.idempotencyKey);
    expect(store.getState().schedule.entries).toEqual({});
  });

  it('a takeover whose answer was lost is started again with the same key, then published once', async () => {
    const { store, publishSchedule } = scheduleStore();
    store.getState().openTakeover(ORG, { playlistId: 'pls_flash' });
    replies.push(null);
    await store.getState().startTakeover(ORG);
    expect(publishSchedule).not.toHaveBeenCalled();

    replies.push(made);
    await store.getState().startTakeover(ORG);
    expect(calls.map((c) => c.name)).toEqual(['start_takeover', 'start_takeover']);
    expect(calls[1]!.input.idempotencyKey).toBe(calls[0]!.input.idempotencyKey);
    // With the default to make first when there is none: the takeover's playlist, as the dialog prefills it (#243).
    expect(publishSchedule).toHaveBeenCalledExactlyOnceWith(ORG, ['sch_1'], { choice: 'pls_flash', publishDefault: false }, false);
  });

  it('a takeover whose playlist still has sample text: Edit first makes nothing; Publish anyway starts it and publishes it allowed (#360)', async () => {
    const cancelled = scheduleStore('cancelled');
    cancelled.store.getState().openTakeover(ORG, { playlistId: 'pls_flash' });
    await cancelled.store.getState().startTakeover(ORG);
    expect(calls).toEqual([]);
    expect(cancelled.publishSchedule).not.toHaveBeenCalled();
    expect(cancelled.checkSampleText).toHaveBeenCalledWith(ORG, 'pls_flash');

    const allowed = scheduleStore('allowed');
    allowed.store.getState().openTakeover(ORG, { playlistId: 'pls_flash' });
    replies.push(made);
    await allowed.store.getState().startTakeover(ORG);
    expect(calls.map((c) => c.name)).toEqual(['start_takeover']);
    expect(allowed.publishSchedule).toHaveBeenCalledExactlyOnceWith(ORG, ['sch_1'], { choice: 'pls_flash', publishDefault: false }, true);
  });

  it('the next new entry is a new creation, with a new key', async () => {
    const { store } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_breakfast' });
    replies.push(made);
    await store.getState().saveEntry(ORG);
    store.getState().openNewEntry(ORG, { playlistId: 'pls_lunch' });
    await store.getState().saveEntry(ORG);
    expect(calls[1]!.input.idempotencyKey).not.toBe(calls[0]!.input.idempotencyKey);
  });
});

describe('a change to an entry', () => {
  const entry = { id: 'sch_1', playlistId: 'pls_breakfast', target: 'org', priority: 0, days: null, version: 2 } as ScheduleEntryView;

  it('sends the version it opened with; a conflict keeps the edit, and Reload opens the entry as it is now', async () => {
    const { store, queryClient } = scheduleStore();
    store.getState().openEditEntry(ORG, entry);
    store.getState().editEntry({ priority: 5 });
    replies.push({ status: 409, body: { error: 'conflict', message: 'stale', details: { version: 3 } } });
    await store.getState().saveEntry(ORG);
    expect(calls[0]).toMatchObject({ name: 'update_schedule_entry', input: { scheduleEntryId: 'sch_1', priority: 5, ifVersion: 2 } });
    expect(store.getState().schedule.entries[DIALOG]).toMatchObject({ stale: true, edit: { priority: 5 }, error: 'This changed since you opened it.' });

    queryClient.setQueryData(scheduleKey(ORG), { entries: [{ ...entry, priority: 9, version: 3 }] });
    await store.getState().reloadEntry(ORG);
    expect(store.getState().schedule.entries[DIALOG]).toMatchObject({ stale: false, version: 3, edit: { priority: 9 } });
  });
});

/** An answer the test gives when it chooses. */
function held() {
  let give: (r: Reply | null) => void = () => {};
  const promise = new Promise<Reply | null>((resolve) => (give = resolve));
  return { promise, give };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('a dialog closed while it saves, and opened again (review of #153, 2)', () => {
  it('the new entry saves on its own: the old one refused does not leave it stuck at saving', async () => {
    const { store } = scheduleStore();
    const first = held();
    replies.push(first.promise);
    store.getState().openNewEntry(ORG, { playlistId: 'pls_breakfast' });
    const saving = store.getState().saveEntry(ORG);
    await flush();
    store.getState().closeScheduleDialog();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_lunch' });
    replies.push({ status: 400, body: { error: 'error', message: 'Refused again' } });
    const again = store.getState().saveEntry(ORG);
    first.give({ status: 400, body: { error: 'error', message: 'Refused' } });
    await Promise.all([saving, again]);
    expect(calls.map((c) => c.input.playlistId)).toEqual(['pls_breakfast', 'pls_lunch']);
    expect(store.getState().schedule.entries[DIALOG]).toMatchObject({ status: 'unsaved', pending: false, error: 'Refused again' });

    await store.getState().saveEntry(ORG);
    expect(calls).toHaveLength(3);
  });

  it('two takeovers started from the dialog, one before it was closed, are each published', async () => {
    const { store, publishSchedule } = scheduleStore();
    const first = held();
    replies.push(first.promise, { status: 200, body: { entry: { id: 'sch_2' } } });
    store.getState().openTakeover(ORG, { playlistId: 'pls_flash' });
    const starting = store.getState().startTakeover(ORG);
    await flush();
    store.getState().closeScheduleDialog();
    store.getState().openTakeover(ORG, { playlistId: 'pls_lunch' });
    const again = store.getState().startTakeover(ORG);
    first.give({ status: 200, body: { entry: { id: 'sch_1' } } });
    await Promise.all([starting, again]);
    // Each with its own dialog's default to make first, should there be none (#243).
    expect(publishSchedule.mock.calls).toEqual([
      [ORG, ['sch_1'], { choice: 'pls_flash', publishDefault: false }, false],
      [ORG, ['sch_2'], { choice: 'pls_lunch', publishDefault: false }, false],
    ]);
  });
});

describe('a not_found about the playlist an entry names (review of #153, 3)', () => {
  it('is shown in the dialog, and a fixed entry is sent', async () => {
    const { store } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_deleted' });
    replies.push({ status: 404, body: { error: 'not_found', message: 'playlist pls_deleted not found' } });
    await store.getState().saveEntry(ORG);
    expect(store.getState().schedule.entries[DIALOG]).toMatchObject({ gone: false, error: 'playlist pls_deleted not found' });
    store.getState().editEntry({ playlistId: 'pls_lunch' });
    replies.push(made);
    await store.getState().saveEntry(ORG);
    expect(calls.map((c) => c.input.playlistId)).toEqual(['pls_deleted', 'pls_lunch']);
    expect(store.getState().schedule.entries).toEqual({});
  });
});

describe('save and publish (#181)', () => {
  it('saves the entry, closes the dialog and publishes the entry it saved, alone', async () => {
    const { store, publishEntry } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_holiday', target: 'screen', screenId: 'scr_1' });
    replies.push(made);
    await store.getState().saveAndPublishEntry(ORG);
    expect(calls.map((c) => c.name)).toEqual(['create_schedule_entry']);
    expect(calls[0]!.input).toMatchObject({ playlistId: 'pls_holiday', target: 'screen', screenId: 'scr_1' });
    expect(publishEntry).toHaveBeenCalledWith(ORG, 'sch_1', { choice: 'pls_holiday', publishDefault: false });
    expect(store.getState().schedule.entries).toEqual({});
  });

  it('publishes nothing when the save is refused, and keeps the dialog with the refusal', async () => {
    const { store, publishEntry } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_holiday', target: 'screen', screenId: 'scr_1' });
    replies.push({ status: 400, body: { error: 'invalid_input', message: 'Choose a playlist that exists.' } });
    await store.getState().saveAndPublishEntry(ORG);
    expect(publishEntry).not.toHaveBeenCalled();
    expect(store.getState().schedule.entries[DIALOG]).toMatchObject({ error: 'Choose a playlist that exists.' });
  });
});

describe('the default playlist a publish from the dialogs asks for, with none yet (#243)', () => {
  it('passes the one chosen for a narrower entry, prefilled with its playlist, or none', async () => {
    const { store, publishEntry } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_breakfast', target: 'screen', screenId: 'scr_1' });
    replies.push(made);
    await store.getState().saveAndPublishEntry(ORG);
    expect(publishEntry).toHaveBeenLastCalledWith(ORG, 'sch_1', { choice: 'pls_breakfast', publishDefault: false });

    store.getState().openNewEntry(ORG, { playlistId: 'pls_breakfast', target: 'org', from: '06:00', to: '10:30' });
    store.getState().editEntry({ firstDefault: '' });
    replies.push(made);
    await store.getState().saveAndPublishEntry(ORG);
    expect(publishEntry).toHaveBeenLastCalledWith(ORG, 'sch_1', { choice: '', publishDefault: false });
  });

  it('passes none for an entry on every screen at all hours: its publish makes the default itself', async () => {
    const { store, publishEntry } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_all_day' });
    replies.push(made);
    await store.getState().saveAndPublishEntry(ORG);
    expect(publishEntry).toHaveBeenLastCalledWith(ORG, 'sch_1', { choice: undefined, publishDefault: false });
  });

  it("passes a takeover's chosen default, another playlist than its own", async () => {
    const { store, publishSchedule } = scheduleStore();
    store.getState().openTakeover(ORG, { playlistId: 'pls_flash' });
    store.getState().editTakeover({ firstDefault: 'pls_all_day' });
    replies.push(made);
    await store.getState().startTakeover(ORG);
    expect(publishSchedule).toHaveBeenLastCalledWith(ORG, ['sch_1'], { choice: 'pls_all_day', publishDefault: false }, false);
  });

  it('passes the box ticked to publish a default never published, from either dialog, and only then (#393)', async () => {
    const { store, publishEntry, publishSchedule } = scheduleStore();
    store.getState().openNewEntry(ORG, { playlistId: 'pls_breakfast', target: 'screen', screenId: 'scr_1' });
    store.getState().editEntry({ publishDefault: true });
    replies.push(made);
    await store.getState().saveAndPublishEntry(ORG);
    expect(publishEntry).toHaveBeenLastCalledWith(ORG, 'sch_1', { choice: 'pls_breakfast', publishDefault: true });

    store.getState().openTakeover(ORG, { playlistId: 'pls_flash' });
    store.getState().editTakeover({ publishDefault: true });
    replies.push(made);
    await store.getState().startTakeover(ORG);
    expect(publishSchedule).toHaveBeenLastCalledWith(ORG, ['sch_1'], { choice: 'pls_flash', publishDefault: true }, false);
  });
});
