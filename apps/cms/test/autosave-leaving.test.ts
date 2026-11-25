// A save still waiting out its autosave delay, when the tab is about to leave its org or close
// (review of #461). Its own file: what is waiting is counted across every store, so no other
// test's held save may be in the count. The save is a fake the test answers; the clock is fake.
import { expect, it, vi } from 'vitest';
import { autosave, createVersionedDrafts, saveWaiting, savesWaiting, type Clock, type Drafts, type Saved } from '../src/state/versioned-draft';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));

const settle = () => new Promise((resolve) => setImmediate(resolve));

it('goes at once, is answered before the tab leaves, and is never sent twice', async () => {
  let drafts: Drafts<{ name: string }> = {};
  const answers: ((saved: Saved<{ name: string }>) => void)[] = [];
  const sent: string[] = [];
  let timers: (() => void)[] = [];
  const clock: Clock = {
    now: () => 0,
    after(_ms, run) {
      timers.push(run);
      return () => (timers = timers.filter((t) => t !== run));
    },
  };
  let ids = 0;
  const module = createVersionedDrafts<{ name: string }>({
    state: { read: () => drafts, write: (change) => (drafts = change(drafts)) },
    save: ({ draft }) => new Promise((resolve) => (sent.push(draft.edit.name), answers.push(resolve))),
    makeId: () => `id_${++ids}`,
    currentOrg: () => 'org_a',
    clock,
  });
  const soon = autosave(clock, 1000, (key) => module.save(key));
  module.edit('a', { orgId: 'org_a', record: 'pls_a', version: 1, edit: { name: '' } }, () => ({ name: 'a1' }));
  soon('a');
  expect(savesWaiting()).toBe(true);

  let left = false;
  const leaving = saveWaiting().then(() => (left = true));
  await settle();
  expect(sent).toEqual(['a1']);
  // On its way: the switch waits for it, and closing the tab now would still lose it.
  expect([left, savesWaiting()]).toEqual([false, true]);
  answers[0]!({ version: 2 });
  await leaving;
  expect(drafts.a).toMatchObject({ status: 'saved', version: 2 });
  expect(savesWaiting()).toBe(false);
  // Its timer went with it.
  expect(timers).toHaveLength(0);
});
