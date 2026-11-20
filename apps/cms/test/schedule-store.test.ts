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
let replies: ({ status: number; body: unknown } | null)[] = [];
const router = { state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };

function scheduleStore() {
  const queryClient = new QueryClient();
  const publishSchedule = vi.fn(async () => {});
  const store = createStore<ScheduleSlice & { publishSchedule: typeof publishSchedule }>()((set, get) => ({
    ...createScheduleSlice(set as never, get as never, { router, queryClient } as never),
    publishSchedule,
  }));
  return { store, queryClient, publishSchedule };
}

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    const reply = replies.length ? replies.shift() : { status: 200, body: {} };
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
    expect(publishSchedule).toHaveBeenCalledExactlyOnceWith(ORG, ['sch_1']);
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
