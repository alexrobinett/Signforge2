/**
 * What a change the drawer drafts would do (#268), in words for its summary card: a line per change,
 * before → after, a link field's new value in full and marked to check (people scan a QR code's
 * link; SignForge never fetches it), and how many screens it reaches at the next publish. Reach comes
 * from the schedule's own targeting (`howItReaches`, `entryPreview`), never from the model.
 *
 * It shows all a draft writes or says why it cannot: a spot's data on a template version not read,
 * so its fields are unknown. A data key no field of the template names is shown too, to check.
 */
import type { ProposedCall } from '@signforge/api/agent-chat';
import type { FieldDef } from '@signforge/contract';
import { fillChanges } from './fill-changes';
import { aimedAt, describeWhen, entryPreview, howItReaches, type ScheduleEntryView } from './schedule';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

interface DraftLine {
  label: string;
  before: string;
  after: string;
  /** A link people will scan: shown in full, to check. */
  check: boolean;
}

export interface DraftSummary {
  title: string;
  lines: DraftLine[];
  reach: string;
}

/** What reach and the lines are read from: the org's screens, groups, schedule, playlists and spots, as the pages read them. */
export interface DraftContext {
  screens: readonly { id: string; name: string; timezone: string }[];
  groups: readonly { id: string; name: string; screenIds: readonly string[] }[];
  entries: readonly ScheduleEntryView[];
  playlists: readonly { id: string; name: string; spotIds: readonly string[]; isDefault: boolean }[];
  spots: readonly { id: string; name: string }[];
  /** A template version's fields, by its id. */
  fieldsOf: (templateVersionId: string) => Record<string, FieldDef> | undefined;
  at: Date;
}

const shown = (v: unknown) => (v === undefined || v === null || v === '' ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** Whom an entry is aimed at, from a tool's input or a read entry. */
const aimOf = (e: Row): { target: 'org' | 'group' | 'screen'; groupId: string | null; screenId: string | null } => ({
  target: e.target === 'group' ? 'group' : e.target === 'screen' ? 'screen' : 'org',
  groupId: str(e.groupId) || null,
  screenId: str(e.screenId) || null,
});

const screensWord = (n: number) => `${n} ${n === 1 ? 'screen' : 'screens'}`;

/** The screens that play `playlistId` as drafted: as the default playlist, or through an entry that reaches them. */
function playing(playlistId: string, d: DraftContext): number {
  const isDefault = d.playlists.some((p) => p.id === playlistId && p.isDefault);
  if (isDefault) return d.screens.length;
  const entries = d.entries.filter((e) => !e.deleted && e.playlistId === playlistId);
  return d.screens.filter((s) => entries.some((e) => howItReaches(e, s.id, d.groups) !== undefined)).length;
}

/** "Wins on N of M screens": where an entry as drafted would play, by the entry preview each screen's schedule gives. */
function wins(entry: Row, replaces: string | null, d: DraftContext): string {
  const reached = d.screens.filter((s) => howItReaches(aimOf(entry), s.id, d.groups) !== undefined);
  const names = (id: string) => d.playlists.find((p) => p.id === id)?.name ?? 'a playlist';
  const defaultPlaylistId = d.playlists.find((p) => p.isDefault)?.id ?? '';
  const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? v : null);
  const won = reached.filter((screen) => {
    const { text } = entryPreview({
      screen,
      groups: d.groups,
      entries: d.entries,
      draft: {
        playlistId: str(entry.playlistId),
        priority: typeof entry.priority === 'number' ? entry.priority : 0,
        days: list(entry.days),
        from: str(entry.from) || null,
        to: str(entry.to) || null,
        startDate: str(entry.startDate) || null,
        endDate: str(entry.endDate) || null,
        replaces,
      },
      defaultPlaylistId,
      names,
      at: d.at,
    });
    return !text.includes('would not play') && !text.includes('does not play');
  });
  return reached.length ? `Wins on ${won.length} of ${screensWord(reached.length)} at the next publish` : 'Reaches no screen';
}

export function summarize(call: ProposedCall, d: DraftContext): DraftSummary | { problem: string } {
  const before = call.before ?? {};
  const input = call.input;
  const line = (label: string, a: unknown, b: unknown, check = false): DraftLine[] => (same(a, b) ? [] : [{ label, before: shown(a), after: shown(b), check }]);
  switch (call.tool) {
    case 'update_spot': {
      const data = isRow(input.data) ? input.data : undefined;
      const fields = d.fieldsOf(str(before.templateVersionId));
      if (data && !fields) return { problem: `The fields of spot ${str(before.name)}'s template could not be read, so its change cannot be shown.` };
      const was = isRow(before.data) ? before.data : {};
      const changes = data && fields ? fillChanges(fields, was, data) : [];
      // The data replaces the draft's whole: a key no field names, added, changed or dropped, is shown as it is.
      const unexplained = data ? [...new Set([...Object.keys(was), ...Object.keys(data)])].filter((k) => !Object.hasOwn(fields ?? {}, k)) : [];
      const lines = [
        ...line('Name', before.name, input.name ?? before.name),
        ...line(
          'Seconds on screen',
          Number(before.durationMs) / 1000,
          input.durationMs === undefined ? Number(before.durationMs) / 1000 : Number(input.durationMs) / 1000,
        ),
        ...changes.map(
          (c): DraftLine =>
            c.kind === 'value'
              ? { label: c.label, before: c.before, after: c.after, check: fields?.[c.field]?.type === 'url' }
              : {
                  label: c.label,
                  before: [...c.changed.map((r) => r.name), ...c.removed].join(', ') || '(none)',
                  after: [`${c.changed.length} changed`, `${c.added.length} added`, `${c.removed.length} removed`].join(', '),
                  check: false,
                },
        ),
        ...unexplained.flatMap((k) => line(`"${k}", which no field of the template names`, was[k], data?.[k], true)),
      ];
      const reach = d.playlists.filter((p) => p.spotIds.includes(call.target?.id ?? '')).reduce((n, p) => Math.max(n, playing(p.id, d)), 0);
      return { title: `Spot ${str(before.name)}`, lines, reach: `Reaches ${screensWord(reach)} at the next publish` };
    }
    case 'update_playlist': {
      const spotNames = (v: unknown) => (Array.isArray(v) ? v.map((id) => d.spots.find((s) => s.id === id)?.name ?? 'a spot').join(', ') : undefined);
      const lines = [
        ...line('Name', before.name, input.name ?? before.name),
        ...line('Spots', spotNames(before.spotIds), input.spotIds === undefined ? spotNames(before.spotIds) : spotNames(input.spotIds)),
        ...line('Transition', before.transition, input.transition ?? before.transition),
      ];
      return { title: `Playlist ${str(before.name)}`, lines, reach: `Reaches ${screensWord(playing(str(before.id), d))} at the next publish` };
    }
    case 'create_schedule_entry': {
      const name = d.playlists.find((p) => p.id === input.playlistId)?.name ?? 'a playlist';
      const when = describeWhen({
        days: Array.isArray(input.days) ? input.days.filter((x): x is number => typeof x === 'number') : null,
        from: str(input.from) || null,
        to: str(input.to) || null,
        startDate: str(input.startDate) || null,
        endDate: str(input.endDate) || null,
      });
      const lines = [
        { label: 'Plays', before: '(new)', after: name, check: false },
        { label: 'On', before: '(new)', after: aimedAt(aimOf(input), d.screens, d.groups), check: false },
        { label: 'When', before: '(new)', after: when, check: false },
        { label: 'Priority', before: '(new)', after: String(typeof input.priority === 'number' ? input.priority : 0), check: false },
      ];
      return { title: 'New schedule entry', lines, reach: wins(input, null, d) };
    }
    case 'update_schedule_entry': {
      const merged: Row = { ...before, ...input };
      const whenOf = (e: Row) =>
        describeWhen({
          days: Array.isArray(e.days) ? e.days.filter((x): x is number => typeof x === 'number') : null,
          from: str(e.from) || null,
          to: str(e.to) || null,
          startDate: str(e.startDate) || null,
          endDate: str(e.endDate) || null,
        });
      const name = (id: unknown) => d.playlists.find((p) => p.id === id)?.name ?? 'a playlist';
      const lines = [
        ...line('Plays', name(before.playlistId), name(merged.playlistId)),
        ...line('On', aimedAt(aimOf(before), d.screens, d.groups), aimedAt(aimOf(merged), d.screens, d.groups)),
        ...line('When', whenOf(before), whenOf(merged)),
        ...line('Priority', before.priority, merged.priority),
      ];
      return { title: `Schedule entry ${name(before.playlistId)}`, lines, reach: wins(merged, str(before.id), d) };
    }
    case 'rename_screen':
      return { title: `Screen ${str(before.name)}`, lines: line('Name', before.name, input.name), reach: 'This screen' };
    default:
      return { title: call.tool.replaceAll('_', ' '), lines: [], reach: '' };
  }
}
