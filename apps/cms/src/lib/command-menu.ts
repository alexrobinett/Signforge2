/**
 * The command menu's entries (#358): actions for people, each opening the page's own dialog, those the
 * member's role allows (`GET /api/tools`, the registry's `describeTools`, read for permissions only);
 * the pages, found when typed; and the agent. It opens on the page's own actions and questions. Typing
 * also finds screens and groups by name (#180), each with its own actions (`targetActions`). The raw tool
 * registry is the agents' and the API's, not the menu's.
 */
import type { GroupView, ScreenView } from './screen-types';
import { reachable } from './screen-status';
import { SECTIONS, type Section } from './sections';
import { findTargets } from './targets';

/** A tool as the menu needs it: what the member's role may call, for which actions to offer. */
export interface ToolListing {
  name: string;
  description: string;
  mutates: boolean;
}

/** What a person does from ⌘K, each the page's own dialog (#358). */
export type PeopleAction = 'pair' | 'new-spot' | 'new-playlist' | 'new-entry' | 'take-over' | 'publish-all';

export type CommandEntry =
  /** A page: listed only when typed, as the sidebar lists them (#358). */
  | { kind: 'go'; id: string; label: string; to: Section['to']; keywords: string[] }
  | { kind: 'action'; id: string; label: string; action: PeopleAction; keywords: string[] }
  | { kind: 'org'; id: string; label: string; action: 'switch' | 'create'; keywords: string[] }
  /** The agent's drawer (#267). */
  | { kind: 'agent'; id: string; label: string; keywords: string[] }
  /** A question for the agent (#270): what was typed, or one suggested for the page. */
  | { kind: 'ask'; id: string; label: string; question: string; keywords: string[] };

/** Words a question or a request to the agent starts with. */
const ASKING =
  /^(why|what|which|who|whose|when|where|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|tell|show|explain|help|please|find out|list)\b/i;

/**
 * Whether what was typed reads as a question or a request for the agent rather than a page, record or
 * tool to find (#270): two words or more ending with a question mark, or three or more starting as a
 * question or a request ("why are two screens behind", "show me what plays"). A short command ("pair a
 * screen", "take over Bayside now") does not, however long.
 */
export function readsAsSentence(query: string): boolean {
  const q = query.trim();
  const words = q.split(/\s+/).filter(Boolean).length;
  return (words >= 2 && q.endsWith('?')) || (words >= 3 && ASKING.test(q));
}

/**
 * Whether the agent's row goes first (#270, review of #406): only when what was typed reads as a question
 * or a request and nothing listed matches it well, none of `names` (screens, groups, spots, playlists and
 * the menu's own rows) being it or starting with it. A five-word screen name is found, not asked about.
 */
export function asksFirst(query: string, names: readonly string[]): boolean {
  const q = query.trim().toLowerCase();
  return readsAsSentence(query) && !names.some((n) => n.toLowerCase().startsWith(q));
}

/** The row that asks the agent what was typed: `first` above what was found, else below it (`asksFirst`). */
export const askEntry = (query: string, first: boolean): CommandEntry => ({
  kind: 'ask',
  id: first ? 'ask:typed' : 'ask:typed:last',
  label: `Ask agent: ${query.trim()}`,
  question: query.trim(),
  keywords: [query],
});

/** Three questions the empty menu suggests for the page shown (#270), by its section. */
const QUESTIONS: Record<string, readonly [string, string, string]> = {
  '/': ['Which screens need me, and why?', 'What changed since the last publish?', 'What is on screen now?'],
  '/screens': ['Which screens need me, and why?', 'Which screens went quiet today?', 'Which screens are behind the last publish?'],
  '/spots': ['Which spots have unpublished changes?', 'Which spots play nowhere?', 'Which spots still show sample text?'],
  '/playlists': ['Which playlists play nowhere?', 'Which playlists have unpublished changes?', 'What does the default playlist play?'],
  '/schedule': ['What plays on each screen now?', 'Which takeovers are running?', 'What changes on screens tomorrow?'],
  '/assets': ['Which images play nowhere?', 'Which assets are the largest?', 'Which spots use this week’s photos?'],
  '/integrations': ['Which data sources failed their last read?', 'Which spots use each data source?', 'When did each feed last update?'],
  '/audit': ['Who changed what today?', 'What did the agent do this week?', 'Who published last, and what?'],
  '/publishes': ['Did the last publish reach every screen?', 'What changed in the last publish?', 'Which screens missed a publish?'],
  '/settings': ['Who can publish in this organization?', 'What are the display hours?', 'Which alerts are set up?'],
};

/** The empty menu's questions for `path`: its section's, a record's page by its section's, else Overview's. */
export function pageQuestions(path: string): CommandEntry[] {
  const section = Object.keys(QUESTIONS)
    .filter((to) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)))
    .sort((a, b) => b.length - a.length)[0];
  return (QUESTIONS[section ?? '/'] ?? []).map((question, i) => ({ kind: 'ask', id: `ask:page:${i}`, label: question, question, keywords: [question] }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses `GET /api/tools`' body: `{ tools: [{ name, description, mutates, inputSchema, ... }] }`. */
export function parseToolList(body: unknown): ToolListing[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) throw new Error('The tool list has no tools.');
  return body.tools.map((t: unknown) => {
    if (!isRecord(t) || typeof t.name !== 'string' || typeof t.description !== 'string' || typeof t.mutates !== 'boolean') {
      throw new Error('The tool list has a tool without a name, description or mutates.');
    }
    return { name: t.name, description: t.description, mutates: t.mutates };
  });
}

/** Each action's words, and the tools a member's role must have for it. */
const ACTIONS: Record<PeopleAction, { label: string; needs: readonly string[]; keywords: string[] }> = {
  pair: { label: 'Pair a screen…', needs: ['claim_screen'], keywords: ['add screen', 'new screen', 'code'] },
  'new-spot': { label: 'New spot…', needs: ['create_spot'], keywords: ['create', 'template', 'image', 'web page'] },
  'new-playlist': { label: 'New playlist…', needs: ['create_playlist'], keywords: ['create', 'loop'] },
  'new-entry': { label: 'Add to the schedule…', needs: ['create_schedule_entry'], keywords: ['schedule', 'play', 'plan'] },
  // A takeover is sent at once wherever the CMS offers it: one who may only draft it is not offered it (#253).
  'take-over': { label: 'Take over screens now…', needs: ['start_takeover', 'publish'], keywords: ['takeover', 'urgent', 'override'] },
  'publish-all': { label: 'Publish all changes…', needs: ['publish'], keywords: ['publish', 'unpublished', 'drafts'] },
};

/** The order the actions are listed in when typed. */
const ORDER: readonly PeopleAction[] = ['pair', 'new-spot', 'new-playlist', 'new-entry', 'take-over', 'publish-all'];

const actionEntry = (action: PeopleAction): CommandEntry => ({
  kind: 'action',
  id: `action:${action}`,
  action,
  label: ACTIONS[action].label,
  keywords: ACTIONS[action].keywords,
});

/** The actions the member's role allows (`tools`), Publish all only while there are `drafts`: every page's, when typed. */
export function peopleActions(tools: readonly ToolListing[], drafts: boolean): CommandEntry[] {
  const may = (a: PeopleAction) => ACTIONS[a].needs.every((n) => tools.some((t) => t.name === n)) && (a !== 'publish-all' || drafts);
  return ORDER.filter(may).map(actionEntry);
}

/** The actions the empty menu suggests on each page (#358), by its section; Publish all on every page. */
const PAGE_ACTIONS: Record<string, readonly PeopleAction[]> = {
  '/screens': ['pair', 'take-over'],
  '/spots': ['new-spot'],
  '/playlists': ['new-playlist'],
  '/schedule': ['new-entry', 'take-over'],
};

/** The empty menu's actions for `path`, of those `allowed` (`peopleActions`): its section's, then Publish all. */
export function pageActions(path: string, allowed: readonly CommandEntry[]): CommandEntry[] {
  const section = Object.keys(PAGE_ACTIONS).find((to) => path === to || path.startsWith(`${to}/`));
  const wanted: readonly PeopleAction[] = [...(section ? (PAGE_ACTIONS[section] ?? []) : []), 'publish-all'];
  return wanted.flatMap((a) => allowed.filter((e) => e.kind === 'action' && e.action === a));
}

/** The pages, in sidebar order: found when typed, never listed on opening (#358). */
export const pageEntries = (): CommandEntry[] =>
  SECTIONS.map((s) => ({ kind: 'go', id: `go:${s.to}`, label: `Go to ${s.label}`, to: s.to, keywords: [s.label] }));

/** The agent's drawer, listed with the page's questions. */
export const agentEntry: CommandEntry = { kind: 'agent', id: 'agent:ask', label: 'Ask the agent…', keywords: ['agent', 'ask', 'assistant', 'why', 'help'] };

/** The organization commands: switching only for a member of two or more orgs (#182). */
export function orgCommands(orgCount: number): CommandEntry[] {
  const create: CommandEntry = { kind: 'org', id: 'org:create', label: 'Create organization…', action: 'create', keywords: ['new organization'] };
  if (orgCount < 2) return [create];
  return [{ kind: 'org', id: 'org:switch', label: 'Switch organization…', action: 'switch', keywords: ['change organization'] }, create];
}

/** A screen or a group ⌘K found, whose actions are showing. */
export type CommandTarget = { kind: 'screen'; id: string } | { kind: 'group'; id: string };

/**
 * What ⌘K offers on a screen or a group it found. A new action is a case here, a line in
 * `targetActions`, and a case in the store's `runTargetAction` (src/state/command-menu.ts).
 */
export type TargetAction =
  | { kind: 'open-screen'; label: string; screenId: string }
  | { kind: 'open-group'; label: string; groupId: string }
  /** The schedule's entry dialog, aimed at the screen (#181). */
  | { kind: 'play-here'; label: string; screenId: string }
  /** The takeover dialog, aimed at the screen (#181). */
  | { kind: 'take-over'; label: string; screenId: string }
  | { kind: 'command'; label: string; command: 'identify' | 'restart'; screenId: string; screenName: string; done: string };

/**
 * A screen's or a group's actions, those the member's role allows (the tools the shell listed). A
 * screen gets commands only once `checked`, its record read since the menu opened: a cached one
 * may be revoked since. Playing a playlist on it or taking it over opens the schedule's dialogs
 * (#181). A revoked screen can only be opened, and one that cannot be reached is not restarted (#253).
 */
export function targetActions(
  target: { kind: 'screen'; screen: ScreenView } | { kind: 'group'; group: GroupView },
  tools: ToolListing[],
  checked: boolean,
): TargetAction[] {
  if (target.kind === 'group') return [{ kind: 'open-group', label: 'Show its screens', groupId: target.group.id }];
  const { id: screenId, name: screenName, status } = target.screen;
  const listed = (tool: string) => status !== 'revoked' && tools.some((t) => t.name === tool);
  const may = (tool: string) => checked && listed(tool);
  const actions: TargetAction[] = [{ kind: 'open-screen', label: 'Open', screenId }];
  // These open a dialog, sending nothing: they need no read of this opening, though not on a revoked screen.
  if (listed('create_schedule_entry')) actions.push({ kind: 'play-here', label: 'Play a playlist here…', screenId });
  // A takeover is started, then published at once: an editor where only owners publish keeps start_takeover, not publish.
  if (listed('start_takeover') && listed('publish')) actions.push({ kind: 'take-over', label: 'Take over…', screenId });
  if (may('screen_command'))
    actions.push({
      kind: 'command',
      label: 'Identify (10 s)',
      command: 'identify',
      screenId,
      screenName,
      done: 'Sent. The screen shows its name for 10 seconds, if it is connected.',
    });
  if (may('screen_command') && reachable(target.screen))
    actions.push({
      kind: 'command',
      label: 'Restart player',
      command: 'restart',
      screenId,
      screenName,
      done: 'Sent. The player restarts and plays from its cache at once.',
    });
  return actions;
}

/**
 * A found screen's or group's item key, from its keywords: cmdk reads an item's keywords only when
 * its value changes, so a change to them remounts it. JSON, as a join would make "North,East" one
 * group's name and two groups' the same.
 */
export const targetItemKey = (value: string, keywords: string[]) => `${value}:${JSON.stringify(keywords)}`;

/** The screens and groups ⌘K lists for a search, as its item values in the order it lists them: screens, then groups, each by name. */
export function foundValues(query: string, screens: readonly ScreenView[], groups: readonly GroupView[]): string[] {
  if (!query.trim()) return [];
  const found = findTargets(query, screens, groups);
  return [...found.screens.map((s) => `screen:${s.id}`), ...found.groups.map((g) => `group:${g.id}`)];
}

/** The item selected, and the found items it was selected among (`foundValues`, as JSON). */
export interface Selection {
  value: string;
  among: string;
}

/**
 * The item ⌘K shows selected. cmdk moves its selection only when the search changes, so a list read
 * that lands after typing would leave a tool selected over the screens it found: cmdk's own pick,
 * made among other found items, gives way to the first found. One the member `moved` to stays.
 * Empty lets cmdk select its first item.
 */
export function selectedItem(selection: Selection | null, found: readonly string[], moved: boolean): string {
  if (selection && (moved || selection.among === JSON.stringify(found))) return selection.value;
  return found[0] ?? selection?.value ?? '';
}

/** The keys cmdk 1.1.1 moves its selection with: arrows, Home and End, and its vim bindings (Ctrl+N, J, P, K). Not PageUp or PageDown, which it ignores. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Whether a key press is the member moving ⌘K's selection themselves (`moved`). With Alt, cmdk moves to the next or previous group. */
export const movesSelection = (e: { key: string; ctrlKey: boolean }) => MOVE_KEYS.has(e.key) || (e.ctrlKey && ['n', 'j', 'p', 'k'].includes(e.key));

/**
 * Whether a pointer move is the member moving ⌘K's selection: cmdk selects by pointer only over an
 * enabled item, so a move over the search, the footer or the item already selected is not one.
 */
export const pointerMovesSelection = (under: { value: string; disabled: boolean } | null, selected: string) =>
  under !== null && !under.disabled && under.value !== selected;
