/**
 * Schedule tools: which playlist plays on which screens, and when (M3-19). An entry aims a
 * playlist at every screen, a group or one screen, on some dates, days and a daily window, all in
 * each screen's time zone. A screen plays the entry that applies with the highest priority, and of
 * equal ones the most specific (screen over group over every screen), else the default playlist:
 * player-core's `resolvePlaylist`, which the screen itself runs.
 *
 * A takeover (`start_takeover`) is an entry bounded by two instants, at most a day apart, above
 * every schedule entry: when the winning takeover changes, a screen ends the spot on screen at
 * once, and it ends the takeover on time with the network down.
 *
 * An entry is a draft: screens get it at the next publish, which holds it back until its playlist
 * is published. Each is checked with the contract's `scheduleEntryProblems` before it is stored.
 * Deleting a published entry needs the right to publish, and waits like an edit: screens keep it
 * until a publish of everything, or one that pins the deletion, applies it (`deleted_at`).
 * `end_takeover` (./publish.ts) deletes a takeover and publishes that alone, in one batch. A
 * takeover that has ended is left out of every compile, and its row goes at the next publish
 * (`ended`). Deletes and creates go through `packages/db`'s repository, so an entry made again
 * with a deleted one's id continues its versions (`draft_tombstones`).
 */
import { scheduleEntryProblems, type ScheduleEntry } from '@signforge/contract';
import { draftChanged, published, StaleVersionError, type OrgScope, type ScheduleEntryRow } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion } from './fields';
import { page, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';
import { type entryOutput, type fieldsOutput, outputs, scheduleTarget } from './outputs';

/** The longest takeover: past a day it is a schedule, and a screen that misses its end would run it too long. */
const TAKEOVER_MAX_MS = 24 * 3_600_000;
/** A takeover's priority: above every schedule entry's (at most 99). */
const TAKEOVER_PRIORITY = 100;

const aim = {
  target: scheduleTarget,
  groupId: id('group').optional().describe('For a group entry: the group'),
  screenId: id('screen').optional().describe('For a screen entry: the screen'),
};
const aimed = (v: { target?: string; groupId?: string; screenId?: string }) =>
  v.target === undefined
    ? v.groupId === undefined && v.screenId === undefined
    : (v.target === 'group') === (v.groupId !== undefined) && (v.target === 'screen') === (v.screenId !== undefined);
const AIMED = 'give groupId for a group entry and screenId for a screen entry, nothing for org';

const priority = z.number().int().min(0).max(99).describe('Higher wins where entries overlap; 0 to 99, default 0. Takeovers are above all of them');
const date = (what: string) => z.string().describe(`${what}, YYYY-MM-DD in each screen's time zone`);
const time = (what: string) => z.string().describe(`${what}, HH:MM in each screen's time zone`);
const when = {
  startDate: date('First date, inclusive').nullable().optional(),
  endDate: date('Last date, inclusive').nullable().optional(),
  days: z.array(z.number().int()).min(1).max(7).nullable().optional().describe('Weekdays it plays, 0 = Sunday; omit for every day'),
  from: time('Daily start, inclusive').nullable().optional(),
  to: time('Daily end, exclusive; at or before from, the window crosses midnight').nullable().optional(),
};
const instant = (what: string) => z.string().describe(`${what}, an ISO 8601 time`);

type EntryView = z.infer<typeof entryOutput>;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** An entry's content as the tools show it, from its draft or its published version. */
const fieldsView = (row: ScheduleEntryRow): z.infer<typeof fieldsOutput> => ({
  playlistId: row.playlistId,
  target: row.target,
  groupId: row.groupId,
  screenId: row.screenId,
  priority: row.priority,
  startDate: row.startDate,
  endDate: row.endDate,
  // Written only by these tools, from a checked list of weekdays.
  days: row.daysJson === null ? null : JSON.parse(row.daysJson),
  from: row.fromTime,
  to: row.toTime,
  startsAt: iso(row.startsAt),
  endsAt: iso(row.endsAt),
  takeover: row.endsAt !== null,
});

export const entryView = (row: ScheduleEntryRow): EntryView => {
  const live = published(row);
  return {
    id: row.id,
    ...fieldsView(row),
    deleted: row.deletedAt !== null,
    live: live ? fieldsView(live) : null,
    version: row.rowVersion,
    published: live !== undefined,
    draftChanged: draftChanged(row),
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/**
 * Whether a takeover is over for good at `now`: its draft and its published version (if any) have
 * both ended. It plays nowhere again, so a publish leaves it out and deletes it.
 */
export const ended = (row: ScheduleEntryRow, now: number): boolean => {
  const over = (e: Pick<ScheduleEntryRow, 'endsAt'>) => e.endsAt !== null && e.endsAt <= now;
  const live = published(row);
  return over(row) && (!live || over(live));
};

type Stored = Pick<
  ScheduleEntryRow,
  'playlistId' | 'target' | 'groupId' | 'screenId' | 'priority' | 'startDate' | 'endDate' | 'daysJson' | 'fromTime' | 'toTime' | 'startsAt' | 'endsAt'
>;

/** Refuse an entry a screen would refuse, as the contract checks it in a manifest. */
function check(id: string, e: Stored): void {
  const entry: ScheduleEntry = {
    id,
    playlist: e.playlistId,
    priority: e.priority,
    target: e.target,
    ...(e.startDate !== null ? { startDate: e.startDate } : {}),
    ...(e.endDate !== null ? { endDate: e.endDate } : {}),
    ...(e.daysJson !== null ? { days: JSON.parse(e.daysJson) } : {}),
    ...(e.fromTime !== null ? { from: e.fromTime } : {}),
    ...(e.toTime !== null ? { to: e.toTime } : {}),
    ...(e.startsAt !== null ? { startsAt: new Date(e.startsAt).toISOString() } : {}),
    ...(e.endsAt !== null ? { endsAt: new Date(e.endsAt).toISOString() } : {}),
  };
  const problems = scheduleEntryProblems(entry).map((p) => p.replace(`schedule entry "${id}": `, ''));
  if (e.daysJson !== null && new Set(JSON.parse(e.daysJson)).size !== JSON.parse(e.daysJson).length) problems.push('days must not repeat');
  if (e.startDate !== null && e.endDate !== null && e.endDate < e.startDate) problems.push('endDate is before startDate');
  if (problems.length) throw new ToolError('invalid_input', problems.join('; '), { problems });
}

/** A takeover's bounds as stored, refused unless it ends after it starts, at most a day later, and not already over. */
function takeoverBounds(startsAt: string, endsAt: string, now: number): { startsAt: number; endsAt: number } {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const problems = [
    Number.isNaN(start) && 'startsAt must be an ISO 8601 time',
    Number.isNaN(end) && 'endsAt must be an ISO 8601 time',
    end <= start && 'endsAt must be after startsAt',
    end - start > TAKEOVER_MAX_MS && 'a takeover lasts at most 24 hours; make a schedule entry for longer',
    end <= now && 'endsAt has passed',
  ].filter((p): p is string => typeof p === 'string');
  if (problems.length) throw new ToolError('invalid_input', problems.join('; '), { problems });
  return { startsAt: start, endsAt: end };
}

/** The ids an entry is aimed at, refused when the playlist, group or screen does not exist. */
async function requireAim(org: OrgScope, e: { playlistId: string; target: 'org' | 'group' | 'screen'; groupId?: string; screenId?: string }) {
  if (!(await org.playlists.get(e.playlistId))) throw notFound('playlist', e.playlistId);
  if (e.target === 'group' && !(await org.screenGroups.get(e.groupId ?? ''))) throw notFound('group', e.groupId ?? '');
  if (e.target === 'screen' && !(await org.screens.get(e.screenId ?? ''))) throw notFound('screen', e.screenId ?? '');
  return { target: e.target, groupId: e.target === 'group' ? (e.groupId ?? null) : null, screenId: e.target === 'screen' ? (e.screenId ?? null) : null };
}

/** The same refusals after a failed commit: a playlist, group or screen deleted meanwhile fails the batch's foreign keys. */
async function missingAim(org: OrgScope, e: { playlistId?: string; groupId?: string; screenId?: string }) {
  if (e.playlistId && !(await org.playlists.get(e.playlistId))) return notFound('playlist', e.playlistId);
  if (e.groupId && !(await org.screenGroups.get(e.groupId))) return notFound('group', e.groupId);
  if (e.screenId && !(await org.screens.get(e.screenId))) return notFound('screen', e.screenId);
  return undefined;
}

/** The entry, refused when it does not exist or is deleted, waiting for a publish. */
async function requireEntry(org: OrgScope, scheduleEntryId: string) {
  const row = await org.scheduleEntries.get(scheduleEntryId);
  if (!row || row.deletedAt !== null) throw notFound('schedule entry', scheduleEntryId);
  return row;
}

const daysJson = (days: number[] | null | undefined) => (days ? JSON.stringify([...days].sort((a, b) => a - b)) : null);

const entryTarget = (input: { scheduleEntryId: string }) => ({ kind: 'schedule_entry', id: input.scheduleEntryId });

const listEntries = defineTool({
  name: 'list_schedule_entries',
  description:
    "List the organization's schedule entries and takeovers, the drafts as last edited, ordered by id, a page at a time: which playlist each plays where and when. Each says whether it is published and whether its draft differs. Filtered to the unpublished ones (removals waiting for a publish included), they come most recently edited first. Returns { entries: ScheduleEntry[], next, total }: total counts every entry the filter matches; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput, unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'), }),
  output: outputs.list_schedule_entries,
  example: {},
  handler: async ({ org, input }) => {
    const views = (await org.scheduleEntries.list()).map(entryView).filter((e) => !input.unpublished || e.draftChanged);
    const { rows, next } = page(views, (e) => (input.unpublished ? [-e.updatedAt, e.id] : [e.id]), input);
    return { entries: rows, next, total: views.length };
  },
});

const createEntry = defineTool({
  name: 'create_schedule_entry',
  description:
    "Schedule a playlist, as a draft: on every screen (target org), a group's screens or one screen, on the dates, weekdays and daily window given (each in the screen's own time zone; omit them for always). From the next publish, where entries overlap the highest priority wins, then the most specific target; where none applies a screen plays the default playlist. For a short interruption that cuts in at once, use start_takeover. Pass an idempotencyKey so a retry cannot create it twice. Returns { entry }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({ playlistId: id('playlist'), ...aim, priority: priority.optional(), ...when, idempotencyKey }).refine(aimed, AIMED),
  output: outputs.create_schedule_entry,
  example: { playlistId: 'pls_example', target: 'group', groupId: 'grp_example', days: [1, 2, 3, 4, 5], from: '06:00', to: '10:30' },
  target: (_input, output) => ({ kind: 'schedule_entry', id: output.entry.id }),
  handler: async ({ org, input, write }) => {
    const aimedAt = await requireAim(org, input);
    const values: Stored = {
      playlistId: input.playlistId,
      ...aimedAt,
      priority: input.priority ?? 0,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      daysJson: daysJson(input.days),
      fromTime: input.from ?? null,
      toTime: input.to ?? null,
      startsAt: null,
      endsAt: null,
    };
    check('new', values);
    return { entry: entryView(write(await org.scheduleEntries.stage.insert(values))) };
  },
  refuseFailedCommit: async ({ org, input }) => missingAim(org, input),
});

const startTakeover = defineTool({
  name: 'start_takeover',
  description:
    "Take over screens with a playlist, as a draft: from startsAt (default now) until endsAt, at most 24 hours later, on every screen (target org), a group's screens or one screen, above every schedule entry. Publish it to send it: a screen then ends the spot on screen at once instead of at its end, and ends the takeover on time with the network down. Of two takeovers on the same screens, the one that starts later wins, so a new one replaces one running. End one now with end_takeover, or early with update_schedule_entry (endsAt) and publish. Once over, it is left out of every publish and deleted at the next. Pass an idempotencyKey so a retry cannot create it twice. Returns { entry }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z
    .object({
      playlistId: id('playlist'),
      ...aim,
      startsAt: instant('When it starts; default now').optional(),
      endsAt: instant('When it ends, at most 24 hours after it starts'),
      idempotencyKey,
    })
    .refine(aimed, AIMED),
  output: outputs.start_takeover,
  example: { playlistId: 'pls_example', target: 'org', endsAt: '2026-11-17T20:00:00Z' },
  target: (_input, output) => ({ kind: 'schedule_entry', id: output.entry.id }),
  handler: async ({ org, input, write }) => {
    const aimedAt = await requireAim(org, input);
    const now = Date.now();
    const bounds = takeoverBounds(input.startsAt ?? new Date(now).toISOString(), input.endsAt, now);
    const values: Stored = {
      playlistId: input.playlistId,
      ...aimedAt,
      priority: TAKEOVER_PRIORITY,
      startDate: null,
      endDate: null,
      daysJson: null,
      fromTime: null,
      toTime: null,
      ...bounds,
    };
    check('new', values);
    return { entry: entryView(write(await org.scheduleEntries.stage.insert(values))) };
  },
  refuseFailedCommit: async ({ org, input }) => missingAim(org, input),
});

const SCHEDULE_ONLY = ['priority', 'startDate', 'endDate', 'days', 'from', 'to'] as const;
const TAKEOVER_ONLY = ['startsAt', 'endsAt'] as const;

const updateEntry = defineTool({
  name: 'update_schedule_entry',
  description:
    "Change a schedule entry's or takeover's draft. Give only what changes: the playlist, whom it is aimed at (target with groupId or screenId), and for a schedule entry its priority, dates, weekdays and window (null clears one), or for a takeover its startsAt and endsAt (end it early, or extend it to at most 24 hours from its start). Screens keep the published version until the next publish. A takeover's new playlist reaches a screen at the end of the spot on screen; a new takeover (start_takeover) cuts in at once. Pass the version you read as ifVersion so a change made since is not overwritten. Returns { entry }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z
    .object({
      scheduleEntryId: id('schedule entry'),
      playlistId: id('playlist').optional(),
      target: scheduleTarget.optional(),
      groupId: aim.groupId,
      screenId: aim.screenId,
      priority: priority.optional(),
      ...when,
      startsAt: instant("The takeover's start").optional(),
      endsAt: instant("The takeover's end").optional(),
      ifVersion,
    })
    .refine(aimed, AIMED),
  output: outputs.update_schedule_entry,
  example: { scheduleEntryId: 'sch_example', playlistId: 'pls_example', ifVersion: 1 },
  target: entryTarget,
  handler: async ({ org, input, write }) => {
    const current = await requireEntry(org, input.scheduleEntryId);
    const takeover = current.endsAt !== null;
    const wrong = (takeover ? SCHEDULE_ONLY : TAKEOVER_ONLY).filter((k) => input[k] !== undefined);
    if (wrong.length)
      throw new ToolError(
        'invalid_input',
        `${wrong.join(', ')} ${takeover ? 'belong to a schedule entry, not a takeover' : 'belong to a takeover: use start_takeover'}`,
      );
    const playlistId = input.playlistId ?? current.playlistId;
    const aimedAt = input.target
      ? await requireAim(org, { playlistId, target: input.target, groupId: input.groupId, screenId: input.screenId })
      : await requireAim(org, { playlistId, target: current.target, groupId: current.groupId ?? undefined, screenId: current.screenId ?? undefined });
    const next: Stored = {
      playlistId,
      ...aimedAt,
      priority: input.priority ?? current.priority,
      startDate: input.startDate === undefined ? current.startDate : input.startDate,
      endDate: input.endDate === undefined ? current.endDate : input.endDate,
      daysJson: input.days === undefined ? current.daysJson : daysJson(input.days),
      fromTime: input.from === undefined ? current.fromTime : input.from,
      toTime: input.to === undefined ? current.toTime : input.to,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
    };
    // A takeover's bounds are both set by start_takeover.
    if (takeover && (input.startsAt !== undefined || input.endsAt !== undefined))
      Object.assign(next, takeoverBounds(input.startsAt ?? iso(current.startsAt)!, input.endsAt ?? iso(current.endsAt)!, Date.now()));
    check(current.id, next);
    return { entry: entryView(write(org.scheduleEntries.stage.update(current, next, input.ifVersion))) };
  },
  refuseFailedCommit: async ({ org, input }) =>
    (await org.scheduleEntries.get(input.scheduleEntryId)) ? missingAim(org, input) : notFound('schedule entry', input.scheduleEntryId),
});

const deleteEntry = defineTool({
  name: 'delete_schedule_entry',
  description:
    'Delete a schedule entry or takeover. Pass the version you read as ifVersion so one changed since is not deleted. One never published goes at once. A published one needs the right to publish (refused to editors where only owners publish), and waits like an edit: screens keep it until a publish of every change, or one that pins it (kind schedule_entry at the version returned), applies the deletion; until then it is listed with deleted: true. To end a takeover now, use end_takeover. Returns { deleted: scheduleEntryId, version }, version null when it went at once.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ scheduleEntryId: id('schedule entry'), ifVersion }),
  output: outputs.delete_schedule_entry,
  example: { scheduleEntryId: 'sch_example' },
  target: entryTarget,
  handler: async ({ org, input, write, scopes }) => {
    const row = await requireEntry(org, input.scheduleEntryId);
    if (input.ifVersion !== undefined && row.rowVersion !== input.ifVersion) throw new StaleVersionError(row.id, row.rowVersion);
    if (!published(row)) {
      write(org.scheduleEntries.stage.remove(row));
      return { deleted: row.id, version: null };
    }
    if (!scopes.includes('content:publish')) throw new ToolError('forbidden', 'Screens play this entry: deleting it needs the right to publish');
    const marked = write(org.scheduleEntries.stage.update(row, { deletedAt: Date.now() }, row.rowVersion));
    return { deleted: row.id, version: marked.rowVersion };
  },
});

export const scheduleTools = [listEntries, createEntry, startTakeover, updateEntry, deleteEntry];
