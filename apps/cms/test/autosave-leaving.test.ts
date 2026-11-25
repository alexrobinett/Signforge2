// A save still waiting out its autosave delay, when the tab is about to leave its org or close
// (review of #461). Its own file: what is waiting is counted across every store, so no other
// test's held save may be in the count. The save is a fake the test answers; the clock is fake.
import { expect, it, vi } from 'vitest';
import { Refusal } from '../src/lib/tools';
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

it('a save that fails with no answer counts until tried again: closing the tab asks, and Try again saves it (review of #461)', async () => {
  let drafts: Drafts<{ name: string }> = {};
  let failing = true;
  const sent: string[] = [];
  // Its delay runs out at the next turn, which the test awaits: no wall clock.
  const clock: Clock = { now: () => 0, after: (_ms, run) => (setImmediate(run), () => {}) };
  let ids = 0;
  const module = createVersionedDrafts<{ name: string }>({
    state: { read: () => drafts, write: (change) => (drafts = change(drafts)) },
    save: async ({ draft }) => {
      sent.push(draft.edit.name);
      if (failing) throw new Refusal('network', 'Could not reach SignForge. Check your connection and try again.');
      return { version: 2 };
    },
    makeId: () => `id_${++ids}`,
    currentOrg: () => 'org_a',
    clock,
  });
  const soon = autosave(clock, 1000, (key) => module.save(key));
  module.edit('a', { orgId: 'org_a', record: 'spt_a', version: 1, edit: { name: '' } }, () => ({ name: 'Lunch' }));
  soon('a');
  await settle();
  expect(drafts.a).toMatchObject({ status: 'unsaved', error: 'Could not reach SignForge. Check your connection and try again.' });
  // Nothing waits or is on its way, but the edit is not saved: the tab asks before it closes.
  expect(savesWaiting()).toBe(true);
  failing = false;
  await module.save('a');
  expect(sent).toEqual(['Lunch', 'Lunch']);
  expect(drafts.a).toMatchObject({ status: 'saved', error: null });
  expect(savesWaiting()).toBe(false);
  // Dropped instead (Reload), a failed draft no longer counts either.
  failing = true;
  module.edit('a', { orgId: 'org_a', record: 'spt_a', version: 2, edit: { name: 'Lunch' } }, () => ({ name: 'Dinner' }));
  await module.save('a');
  expect(savesWaiting()).toBe(true);
  module.drop('a');
  expect(savesWaiting()).toBe(false);
});
