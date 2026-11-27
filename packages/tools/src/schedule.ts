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
 * `takeover` (./publish.ts) ends a takeover, deleting it and publishing that alone, in one batch. A
 * takeover that has ended is left out of every compile, and its row goes at the next publish
 * (`ended`). Deletes and creates go through `packages/db`'s repository, so an entry made again
 * with a deleted one's id continues its versions (`draft_tombstones`).
 */
import { scheduleEntryProblems, type ScheduleEntry } from '@signforge/contract';
import { draftChanged, published, StaleVersionError, type OrgScope, type ScheduleEntryRow } from '@signforge/db';
import { z } from 'zod';
import { id, idempotencyKey, ifVersion } from './fields';
import { page, pageInput } from './paging';
import { defineTool, invalidFields, notFound, ToolError, type ToolContext } from './tool';
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
export const aimed = (v: { target?: string; groupId?: string; screenId?: string }) =>
  v.target === undefined
    ? v.groupId === undefined && v.screenId === undefined
    : (v.target === 'group') === (v.groupId !== undefined) && (v.target === 'screen') === (v.screenId !== undefined);
export const AIMED = 'give groupId for a group entry and screenId for a screen entry, nothing for org';

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

/** A takeover's fields as its tools take them: the playlist, whom it plays on, and when (`start_takeover`, `takeover`). */
export const takeoverFields = {
  playlistId: id('playlist'),
  ...aim,
  startsAt: instant('When it starts; default now').optional(),
  endsAt: instant('When it ends, at most 24 hours after it starts'),
};

/** A new takeover as stored, checked: the playlist and whom it plays on exist, its bounds hold, and a screen would take it. */
export async function takeoverOf(org: OrgScope, input: z.output<z.ZodObject<typeof takeoverFields>>, now: number): Promise<Stored> {
  const aimedAt = await requireAim(org, input);
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
  return values;
}

/** The same refusals after a failed commit: a playlist, group or screen deleted meanwhile fails the batch's foreign keys. */
export async function missingAim(org: OrgScope, e: { playlistId?: string; groupId?: string; screenId?: string }) {
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

const listEntries = defineTool({
  name: 'list_schedule_entries',
  description:
    "List the organization's schedule entries and takeovers, the drafts as last edited, ordered by id, a page at a time: which playlist each plays where and when. Each says whether it is published and whether its draft differs. Filtered to the unpublished ones (removals waiting for a publish included), they come most recently edited first. Returns { entries: ScheduleEntry[], next, total }: total counts every entry the filter matches; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({
    ...pageInput,
    unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'),
  }),
  output: outputs.list_schedule_entries,
  example: {},
  handler: async ({ org, input }) => {
    const views = (await org.scheduleEntries.list()).map(entryView).filter((e) => !input.unpublished || e.draftChanged);
    const { rows, next } = page(views, (e) => (input.unpublished ? [-e.updatedAt, e.id] : [e.id]), input);
    return { entries: rows, next, total: views.length };
  },
});

const startTakeover = defineTool({
  name: 'start_takeover',
  description:
    "Take over screens with a playlist, as a draft: from startsAt (default now) until endsAt, at most 24 hours later, on every screen (target org), a group's screens or one screen, above every schedule entry. Publish it to send it; describe(schedule_entry) says how it cuts in, which wins and when it goes. End one now with takeover (action end), or early with save_schedule_entry (endsAt) and publish. Pass an idempotencyKey so a retry cannot create it twice. Returns { entry }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({ ...takeoverFields, idempotencyKey }).refine(aimed, AIMED),
  output: outputs.start_takeover,
  example: { playlistId: 'pls_example', target: 'org', endsAt: '2026-11-17T20:00:00Z' },
  target: (_input, output) => (output ? { kind: 'schedule_entry', id: output.entry.id } : undefined),
  handler: async ({ org, input, write }) => ({ entry: entryView(write(await org.scheduleEntries.stage.insert(await takeoverOf(org, input, Date.now())))) }),
  refuseFailedCommit: async ({ org, input }) => missingAim(org, input),
});

const SCHEDULE_ONLY = ['priority', 'startDate', 'endDate', 'days', 'from', 'to'] as const;
const TAKEOVER_ONLY = ['startsAt', 'endsAt'] as const;

const saveEntry = defineTool({
  name: 'save_schedule_entry',
  description:
    "Schedule a playlist, or change a schedule entry's or takeover's draft. Without scheduleEntryId it creates an entry: a playlistId and whom it plays on (target org for every screen, group with groupId, screen with screenId), on the dates, weekdays and daily window given (each in the screen's own time zone; omit them for always); pass an idempotencyKey so a retry cannot create it twice. Which entry wins where they overlap is describe(schedule_entry)'s rules. For a short interruption that cuts in at once, use start_takeover. With scheduleEntryId it changes what you give: the playlist, whom it is aimed at, and for a schedule entry its priority, dates, weekdays and window (null clears one), or for a takeover its startsAt and endsAt (end it early, or extend it to at most 24 hours from its start). Pass the version you read as ifVersion so a change made since is not overwritten. Returns { entry }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  // Strict, as every save is: a field it does not take is refused by name, not dropped (review of #499).
  input: z
    .strictObject({
      scheduleEntryId: id('schedule entry').optional().describe('The entry to change; omit to create one'),
      playlistId: id('playlist').optional(),
      target: scheduleTarget.optional(),
      groupId: aim.groupId,
      screenId: aim.screenId,
      priority: priority.optional(),
      ...when,
      startsAt: instant("A takeover's start").optional(),
      endsAt: instant("A takeover's end").optional(),
      ifVersion,
      idempotencyKey,
    })
    .refine(aimed, AIMED),
  output: outputs.save_schedule_entry,
  example: { playlistId: 'pls_example', target: 'group', groupId: 'grp_example', days: [1, 2, 3, 4, 5], from: '06:00', to: '10:30' },
  target: (input, output) => {
    const id = input.scheduleEntryId ?? output?.entry.id;
    return id === undefined ? undefined : { kind: 'schedule_entry', id };
  },
  handler: async ({ org, input, write }) => {
    const { scheduleEntryId } = input;
    if (scheduleEntryId === undefined) {
      if (input.ifVersion !== undefined) throw invalidFields('a new schedule entry has no version yet: ifVersion is for a change', 'ifVersion');
      const { playlistId, target } = input;
      if (playlistId === undefined || target === undefined)
        throw invalidFields(
          'a new entry needs a playlistId and a target; give scheduleEntryId to change one',
          ...(['playlistId', 'target'] as const).filter((k) => input[k] === undefined),
        );
      if (input.startsAt !== undefined || input.endsAt !== undefined)
        throw invalidFields(
          'startsAt and endsAt belong to a takeover: use start_takeover',
          ...(['startsAt', 'endsAt'] as const).filter((k) => input[k] !== undefined),
        );
      const aimedAt = await requireAim(org, { playlistId, target, groupId: input.groupId, screenId: input.screenId });
      const values: Stored = {
        playlistId,
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
    }
    const current = await requireEntry(org, scheduleEntryId);
    const takeover = current.endsAt !== null;
    const wrong = (takeover ? SCHEDULE_ONLY : TAKEOVER_ONLY).filter((k) => input[k] !== undefined);
    if (wrong.length)
      throw invalidFields(
        `${wrong.join(', ')} ${takeover ? 'belong to a schedule entry, not a takeover' : 'belong to a takeover: use start_takeover'}`,
        ...wrong,
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
    input.scheduleEntryId === undefined || (await org.scheduleEntries.get(input.scheduleEntryId))
      ? missingAim(org, input)
      : notFound('schedule entry', input.scheduleEntryId),
});

/**
 * Delete a schedule entry or takeover (the `delete` tool, ./delete.ts), unless it changed since `ifVersion`. One never
 * published goes at once (version null); a published one needs the right to publish, and is marked deleted until a
 * publish applies it (its new version).
 */
/**
 * A schedule entry `delete` can remove, and whether that needs the right to publish: one published waits for a publish
 * (#523). Undefined for one gone or already marked deleted, which `delete` refuses as not found. The drawer's delete card
 * asks this too, so it offers a press exactly where the tool would run it.
 */
export async function entryToDelete(org: OrgScope, scheduleEntryId: string) {
  const row = await org.scheduleEntries.get(scheduleEntryId);
  if (!row || row.deletedAt !== null) return undefined;
  return { row, needsPublish: published(row) !== undefined };
}

export async function deleteScheduleEntry(
  { org, write, publishRight }: Pick<ToolContext<unknown>, 'org' | 'write' | 'publishRight'>,
  scheduleEntryId: string,
  ifVersion: number | undefined,
): Promise<number | null> {
  const found = await entryToDelete(org, scheduleEntryId);
  if (!found) throw notFound('schedule entry', scheduleEntryId);
  const { row } = found;
  if (ifVersion !== undefined && row.rowVersion !== ifVersion) throw new StaleVersionError(row.id, row.rowVersion);
  if (!found.needsPublish) {
    write(org.scheduleEntries.stage.remove(row));
    return null;
  }
  // Held to the commit too (review of #419): a role or editors-publish changed meanwhile refuses it.
  publishRight('Screens play this entry: deleting it needs the right to publish');
  return write(org.scheduleEntries.stage.update(row, { deletedAt: Date.now() }, row.rowVersion)).rowVersion;
}

export const scheduleTools = [listEntries, saveEntry, startTakeover];
