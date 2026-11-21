/**
 * The Schedule page (M3-19): the dialogs that make and change a schedule entry or start a
 * takeover, removing one, ending a takeover, and which screen the week view shows.
 *
 * An entry is a draft until it is published (the page's Publish, `publishSchedule`), and so is a
 * removal of one screens play. A takeover is sent at once: started, then published with the
 * playlist and spots it needs; End now is `endTakeover` (./publishing.ts). A dialog checks its
 * entry with the contract's `scheduleEntryProblems`, so the CMS refuses what a screen would.
 *
 * Each dialog's draft is a versioned draft (./versioned-draft.ts): a change sends the entry's
 * version as `ifVersion` and offers Reload on a conflict, and a create (a new entry, a takeover)
 * keeps one idempotency key until it is answered, so a retry after a lost answer makes no second.
 */
import { scheduleEntryProblems } from '@signforge/contract';
import { toast } from 'sonner';
import { orgOnScreen } from '~/lib/live';
import type { ScheduleEntryView } from '~/lib/schedule';
import { callTool, toolMessage } from '~/lib/tools';
import { scheduleKey, scheduleQuery } from '~/queries/schedule';
import type { SliceCreator } from './store';
import { createVersionedDrafts, realClock, type Drafts } from './versioned-draft';

type Target = ScheduleEntryView['target'];

/** A schedule entry in its dialog. Empty strings are fields left out. */
export interface EntryDraft {
  playlistId: string;
  target: Target;
  groupId: string;
  screenId: string;
  priority: number;
  /** Weekdays it plays, 0 = Sunday; all seven means every day. */
  days: number[];
  from: string;
  to: string;
  startDate: string;
  endDate: string;
}

/** A takeover in its dialog: until when, as a `datetime-local` value in the browser's time zone. */
interface TakeoverDraft {
  playlistId: string;
  target: Target;
  groupId: string;
  screenId: string;
  until: string;
}

interface ScheduleState {
  /** The entry dialog's draft (at `DIALOG`): its record is the entry it changes, null for a new one. */
  entries: Drafts<EntryDraft>;
  /** The takeover dialog's draft (at `DIALOG`). */
  takeovers: Drafts<TakeoverDraft>;
  /** The screen the week view shows; null shows the first. */
  weekScreenId: string | null;
}

/** The key of the one dialog's draft. */
export const DIALOG = 'dialog';

export interface ScheduleSlice {
  schedule: ScheduleState;
  /** Opens a new entry in `orgId`, with what the page chose (a screen's own, say). */
  openNewEntry: (orgId: string, preset?: Partial<EntryDraft>) => void;
  openEditEntry: (orgId: string, entry: ScheduleEntryView) => void;
  editEntry: (patch: Partial<EntryDraft>) => void;
  /** Saves the entry as a draft. */
  saveEntry: (orgId: string) => Promise<void>;
  /** Saves the entry, then publishes it alone (`publishEntry`, #181). */
  saveAndPublishEntry: (orgId: string) => Promise<void>;
  /** After a conflict: reads the schedule again and opens the entry as it is now, to make the change again. */
  reloadEntry: (orgId: string) => Promise<void>;
  /** Removes an entry: at once if it was never published, else at the next publish. */
  removeEntry: (orgId: string, entry: ScheduleEntryView) => Promise<void>;
  openTakeover: (orgId: string, preset?: Partial<TakeoverDraft>) => void;
  editTakeover: (patch: Partial<TakeoverDraft>) => void;
  /** Starts the takeover and publishes it, so screens cut in at once. */
  startTakeover: (orgId: string) => Promise<void>;
  closeScheduleDialog: () => void;
  chooseWeekScreen: (screenId: string) => void;
}

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 0];

/** An hour from now, to the minute, as a `datetime-local` value in the browser's time zone. */
function inAnHour(): string {
  const d = new Date(Date.now() + 3_600_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whom an entry is aimed at, as the tools take it. */
const aim = (d: { target: Target; groupId: string; screenId: string }) => ({
  target: d.target,
  ...(d.target === 'group' ? { groupId: d.groupId } : {}),
  ...(d.target === 'screen' ? { screenId: d.screenId } : {}),
});

/** The entry's when, as the tools take it: a field left out is null, every day is no days. */
export const entryWhen = (d: EntryDraft) => ({
  priority: d.priority,
  days: d.days.length === 7 ? null : d.days,
  from: d.from || null,
  to: d.to || null,
  startDate: d.startDate || null,
  endDate: d.endDate || null,
});

/** What is wrong with the dialog's entry, as a screen or the tools would refuse it: empty when it can be saved. */
export function entryProblems(d: EntryDraft): string[] {
  const out: string[] = [];
  if (!d.playlistId) out.push('Choose a playlist.');
  if (d.target === 'group' && !d.groupId) out.push('Choose a group.');
  if (d.target === 'screen' && !d.screenId) out.push('Choose a screen.');
  if (!d.days.length) out.push('Choose at least one day.');
  const w = entryWhen(d);
  const entry = {
    id: 'draft',
    playlist: d.playlistId,
    priority: w.priority,
    target: d.target,
    ...(w.days ? { days: w.days } : {}),
    ...(w.from ? { from: w.from } : {}),
    ...(w.to ? { to: w.to } : {}),
    ...(w.startDate ? { startDate: w.startDate } : {}),
    ...(w.endDate ? { endDate: w.endDate } : {}),
  };
  out.push(...scheduleEntryProblems(entry).map((p) => `${p.replace('schedule entry "draft": ', '').replace(/^./, (c) => c.toUpperCase())}.`));
  if (w.startDate && w.endDate && w.endDate < w.startDate) out.push('The last date is before the first.');
  return out;
}

export const createScheduleSlice: SliceCreator<ScheduleSlice> = (set, get, { router, queryClient }) => {
  const patch = (fn: (s: ScheduleState) => ScheduleState) => set((s) => ({ schedule: fn(s.schedule) }));
  const refresh = (orgId: string) => queryClient.invalidateQueries({ queryKey: scheduleKey(orgId) });
  const common = { makeId: () => crypto.randomUUID(), currentOrg: () => orgOnScreen(router), clock: realClock };

  const entries = createVersionedDrafts<EntryDraft>({
    ...common,
    state: { read: () => get().schedule.entries, write: (change) => patch((s) => ({ ...s, entries: change(s.entries) })) },
    async save({ draft: { orgId, record, version, edit, idempotencyKey } }) {
      const fields = { playlistId: edit.playlistId, ...aim(edit), ...entryWhen(edit) };
      const out =
        record === null
          ? await callTool('create_schedule_entry', { ...fields, idempotencyKey })
          : await callTool('update_schedule_entry', { scheduleEntryId: record, ...fields, ifVersion: version });
      await refresh(orgId);
      return { record: out.entry.id };
    },
  });

  const takeovers = createVersionedDrafts<TakeoverDraft>({
    ...common,
    state: { read: () => get().schedule.takeovers, write: (change) => patch((s) => ({ ...s, takeovers: change(s.takeovers) })) },
    async save({ draft: { orgId, edit: d, idempotencyKey } }) {
      const made = await callTool('start_takeover', { playlistId: d.playlistId, ...aim(d), endsAt: new Date(d.until).toISOString(), idempotencyKey });
      await refresh(orgId);
      return { record: made.entry.id };
    },
  });

  /** Saves the dialog's entry in `orgId`: its id once saved, else null (refused, or the dialog is another org's). The dialog closes once saved, unless another has opened. */
  async function saveDialogEntry(orgId: string): Promise<string | null> {
    if (get().schedule.entries[DIALOG]?.orgId !== orgId) return null;
    // This draft's outcome, though its dialog may have been closed, or opened on another, meanwhile.
    const saved = await entries.save(DIALOG);
    if (saved?.status !== 'saved' || saved.record === null) return null;
    if (get().schedule.entries[DIALOG]?.id === saved.id) entries.drop(DIALOG);
    return saved.record;
  }

  /** Opens one dialog: the other's draft goes. */
  const close = () => {
    entries.drop(DIALOG);
    takeovers.drop(DIALOG);
  };

  return {
    schedule: { entries: {}, takeovers: {}, weekScreenId: null },

    openNewEntry(orgId, preset = {}) {
      close();
      entries.open(DIALOG, {
        orgId,
        record: null,
        version: null,
        edit: {
          playlistId: '',
          target: 'org',
          groupId: '',
          screenId: '',
          priority: 0,
          days: EVERY_DAY,
          from: '',
          to: '',
          startDate: '',
          endDate: '',
          ...preset,
        },
      });
    },

    openEditEntry(orgId, e) {
      close();
      entries.open(DIALOG, {
        orgId,
        record: e.id,
        version: e.version,
        edit: {
          playlistId: e.playlistId,
          target: e.target,
          groupId: e.groupId ?? '',
          screenId: e.screenId ?? '',
          priority: e.priority,
          days: e.days ?? EVERY_DAY,
          from: e.from ?? '',
          to: e.to ?? '',
          startDate: e.startDate ?? '',
          endDate: e.endDate ?? '',
        },
      });
    },

    editEntry: (change) => entries.update(DIALOG, (d) => ({ ...d, ...change })),

    async saveEntry(orgId) {
      const d = get().schedule.entries[DIALOG];
      if (await saveDialogEntry(orgId))
        toast.success(d?.record === null ? 'Scheduled, as a draft' : 'Saved, as a draft', { description: 'Publish to send it to screens.' });
    },

    async saveAndPublishEntry(orgId) {
      const record = await saveDialogEntry(orgId);
      if (record) await get().publishEntry(orgId, record);
    },

    async reloadEntry(orgId) {
      const id = get().schedule.entries[DIALOG]?.record;
      entries.drop(DIALOG);
      await refresh(orgId);
      const now = queryClient.getQueryData(scheduleQuery(orgId).queryKey)?.entries.find((e) => e.id === id);
      if (now) get().openEditEntry(orgId, now);
    },

    async removeEntry(orgId, e) {
      try {
        await callTool('delete_schedule_entry', { scheduleEntryId: e.id });
        await refresh(orgId);
        toast.success('Removed', { description: e.published ? 'Screens keep it until you publish.' : 'It was never published.' });
      } catch (err) {
        toast.error('Not removed', { description: toolMessage(err) });
      }
    },

    openTakeover(orgId, preset = {}) {
      close();
      takeovers.open(DIALOG, {
        orgId,
        record: null,
        version: null,
        edit: { playlistId: '', target: 'org', groupId: '', screenId: '', until: inAnHour(), ...preset },
      });
    },

    editTakeover: (change) => takeovers.update(DIALOG, (d) => ({ ...d, ...change })),

    async startTakeover(orgId) {
      if (get().schedule.takeovers[DIALOG]?.orgId !== orgId) return;
      // This takeover's outcome: one started is published, though its dialog was closed meanwhile.
      const made = await takeovers.save(DIALOG);
      if (made?.status !== 'saved' || made.record === null) return;
      if (get().schedule.takeovers[DIALOG]?.id === made.id) takeovers.drop(DIALOG);
      await get().publishSchedule(orgId, [made.record]);
    },

    closeScheduleDialog: close,

    chooseWeekScreen: (screenId) => patch((s) => ({ ...s, weekScreenId: screenId })),
  };
};
