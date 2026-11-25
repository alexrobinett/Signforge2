import { describeTools, registry, type Role } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import {
  askEntry,
  asksFirst,
  foundValues,
  movesSelection,
  pageActions,
  pageEntries,
  pageQuestions,
  parseToolList,
  peopleActions,
  pointerMovesSelection,
  readsAsSentence,
  selectedItem,
  targetActions,
  targetItemKey,
} from '../../src/lib/command-menu';
import type { GroupView, ScreenView } from '../../src/lib/screen-types';
import { SECTIONS } from '../../src/lib/sections';

// What `GET /api/tools` sends: `describeTools` for the member's role, in an org where editors publish (the default).
const listed = (role: Role) => parseToolList(JSON.parse(JSON.stringify({ tools: describeTools(registry, { role, editorsPublish: true }) })));
const actions = (role: Role, drafts = true, editorsPublish = true) =>
  peopleActions(parseToolList(JSON.parse(JSON.stringify({ tools: describeTools(registry, { role, editorsPublish }) }))), drafts).map((e) =>
    e.kind === 'action' ? e.action : e.kind,
  );

describe("⌘K's actions for people (#358)", () => {
  it('offers an owner every action, each a page dialog, and no raw tool', () => {
    expect(actions('owner')).toEqual(['pair', 'new-spot', 'new-playlist', 'new-entry', 'take-over', 'publish-all']);
  });

  it('offers an editor what their role allows: no takeover or Publish all where only owners publish (#253)', () => {
    expect(actions('editor')).toEqual(['pair', 'new-spot', 'new-playlist', 'new-entry', 'take-over', 'publish-all']);
    expect(actions('editor', true, false)).toEqual(['pair', 'new-spot', 'new-playlist', 'new-entry']);
  });

  it('offers a viewer no action', () => {
    expect(actions('viewer')).toEqual([]);
  });

  it('offers Publish all only while there are unpublished changes', () => {
    expect(actions('owner', false)).not.toContain('publish-all');
  });

  it("opens on the page's own actions, then Publish all: Pair and Take over on Screens, New spot on Spots, and so on", () => {
    const allowed = peopleActions(listed('owner'), true);
    const on = (path: string) => pageActions(path, allowed).map((e) => (e.kind === 'action' ? e.action : ''));
    expect(on('/screens')).toEqual(['pair', 'take-over', 'publish-all']);
    expect(on('/screens/scr_1')).toEqual(['pair', 'take-over', 'publish-all']);
    expect(on('/spots')).toEqual(['new-spot', 'publish-all']);
    expect(on('/playlists/pl_1')).toEqual(['new-playlist', 'publish-all']);
    expect(on('/schedule')).toEqual(['new-entry', 'take-over', 'publish-all']);
    expect(on('/')).toEqual(['publish-all']);
    expect(pageActions('/screens', peopleActions(listed('viewer'), true))).toEqual([]);
  });

  it('finds every page of the sidebar when typed', () => {
    expect(pageEntries().flatMap((e) => (e.kind === 'go' ? [e.to] : []))).toEqual(SECTIONS.map((s) => s.to));
  });
});

describe("a found screen's and group's actions (#180)", () => {
  const screen = { id: 'scr_1', name: '0157 Drive-thru L', status: 'active', state: { kind: 'online', reason: null } } as ScreenView;
  const labels = (role: Role, s: ScreenView = screen, checked = true) =>
    targetActions({ kind: 'screen', screen: s }, listed(role), checked).map((a) => a.label);

  it('opens a screen, plays a playlist on it or takes it over, identifies and restarts it for an editor, Open first (#181)', () => {
    expect(labels('editor')).toEqual(['Open', 'Play a playlist here…', 'Take over…', 'Identify (10 s)', 'Restart player']);
    expect(targetActions({ kind: 'screen', screen }, listed('owner'), true)).toContainEqual(
      expect.objectContaining({ kind: 'tool', tool: 'identify_screen', screenId: 'scr_1', screenName: '0157 Drive-thru L' }),
    );
  });

  it('offers no Restart for a screen that cannot be reached: the restart would go nowhere (#253)', () => {
    const away = { ...screen, state: { ...screen.state, kind: 'unreachable' } } as ScreenView;
    expect(labels('editor', away)).toEqual(['Open', 'Play a playlist here…', 'Take over…', 'Identify (10 s)']);
  });

  it('offers no takeover to an editor where only owners publish: it would start, and its publish be refused', () => {
    const noPublish = parseToolList(JSON.parse(JSON.stringify({ tools: describeTools(registry, { role: 'editor', editorsPublish: false }) })));
    expect(noPublish.map((t) => t.name)).toContain('start_takeover');
    expect(targetActions({ kind: 'screen', screen }, noPublish, true).map((a) => a.label)).toEqual([
      'Open',
      'Play a playlist here…',
      'Identify (10 s)',
      'Restart player',
    ]);
  });

  it('only opens a screen for a viewer, whose role has neither tool, and a revoked screen for anyone', () => {
    expect(labels('viewer')).toEqual(['Open']);
    expect(labels('owner', { ...screen, status: 'revoked' })).toEqual(['Open']);
  });

  it('only opens a screen read from the cache before this opening: it may be revoked since, so commands wait for a fresh read', () => {
    expect(labels('owner', screen, false)).toEqual(['Open', 'Play a playlist here…', 'Take over…']);
  });

  it('keys an item by its keywords, so a name with a comma is not two names', () => {
    expect(targetItemKey('screen:scr_1', ['Lobby', 'North,East'])).not.toBe(targetItemKey('screen:scr_1', ['Lobby', 'North', 'East']));
    expect(targetItemKey('screen:scr_1', ['Lobby'])).toBe(targetItemKey('screen:scr_1', ['Lobby']));
  });

  it("shows a group's screens on the Screens page", () => {
    const group = { id: 'grp_1', name: 'North', screenIds: [], version: 1, createdAt: 0, updatedAt: 0 };
    expect(targetActions({ kind: 'group', group }, listed('viewer'), false)).toEqual([{ kind: 'open-group', label: 'Show its screens', groupId: 'grp_1' }]);
  });
});

describe("⌘K's selection when the screens arrive after typing (#180)", () => {
  const deli = { id: 'scr_1', name: 'Deli counter' } as ScreenView;
  const front = { id: 'grp_1', name: 'Front of house', screenIds: ['scr_1'] } as GroupView;

  it('lists what a search found as item values: screens, then groups, each by name, and nothing for no search', () => {
    expect(foundValues('front', [deli], [front])).toEqual(['screen:scr_1', 'group:grp_1']);
    expect(foundValues('  ', [deli], [front])).toEqual([]);
  });

  it('selects the first screen found once the list lands, over the tool selected while it was on its way', () => {
    const typed = { value: 'tool:test_alert_channel', among: JSON.stringify([]) };
    expect(selectedItem(typed, [], false)).toBe('tool:test_alert_channel');
    expect(selectedItem(typed, foundValues('deli', [deli], []), false)).toBe('screen:scr_1');
  });

  it('keeps a selection the member moved to, though the list lands after: their choice, not cmdk’s pick', () => {
    const arrowed = { value: 'tool:retry_alert_delivery', among: JSON.stringify([]) };
    expect(selectedItem(arrowed, foundValues('deli', [deli], []), true)).toBe('tool:retry_alert_delivery');
  });

  it('keeps a selection made among the same found items, and lets cmdk choose before it has reported one', () => {
    const found = foundValues('front', [deli], [front]);
    expect(selectedItem({ value: 'group:grp_1', among: JSON.stringify(found) }, found, false)).toBe('group:grp_1');
    expect(selectedItem(null, [], false)).toBe('');
  });
});

describe("what counts as the member moving ⌘K's selection (#180)", () => {
  const key = (k: string, mods: { ctrlKey?: boolean; altKey?: boolean } = {}) => ({ key: k, ctrlKey: false, altKey: false, ...mods });

  it('counts the keys cmdk moves with: arrows, Home and End, and Ctrl with N, J, P or K', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'Home', 'End']) expect(movesSelection(key(k))).toBe(true);
    for (const k of ['n', 'j', 'p', 'k']) expect(movesSelection(key(k, { ctrlKey: true }))).toBe(true);
  });

  it('does not count PageUp or PageDown, which cmdk ignores, or a letter typed', () => {
    for (const k of ['PageUp', 'PageDown', 'n', 'Enter']) expect(movesSelection(key(k))).toBe(false);
  });

  it('counts Alt with an arrow or a vim binding: cmdk moves to the next or previous group', () => {
    expect(movesSelection(key('ArrowDown', { altKey: true }))).toBe(true);
    expect(movesSelection(key('j', { ctrlKey: true, altKey: true }))).toBe(true);
  });

  it('counts a pointer move only onto an enabled item other than the one selected', () => {
    expect(pointerMovesSelection({ value: 'tool:list_screens', disabled: false }, 'tool:test_alert_channel')).toBe(true);
    expect(pointerMovesSelection(null, 'tool:test_alert_channel')).toBe(false);
    expect(pointerMovesSelection({ value: 'tool:test_alert_channel', disabled: false }, 'tool:test_alert_channel')).toBe(false);
    expect(pointerMovesSelection({ value: 'tool:list_screens', disabled: true }, 'tool:test_alert_channel')).toBe(false);
  });
});

describe('Ask agent in ⌘K (#270)', () => {
  it('reads a question or a request as a sentence for the agent; one or two words, and a command however long, still find pages, records and tools first', () => {
    for (const q of ['screens', 'bayside door', '  rename   ', 'publish now', 'pair a screen', 'take over Bayside now', 'Bayside closes at 2 for the storm'])
      expect(readsAsSentence(q), q).toBe(false);
    for (const q of ['why are screens behind', 'Which screens need me?', 'behind screens?', 'show me what plays now']) expect(readsAsSentence(q), q).toBe(true);
    expect(askEntry('  why are screens behind ', true)).toMatchObject({
      kind: 'ask',
      id: 'ask:typed',
      label: 'Ask agent: why are screens behind',
      question: 'why are screens behind',
    });
    expect(askEntry('screens', false)).toMatchObject({ id: 'ask:typed:last' });
  });

  it('puts the agent first only when nothing listed matches what was typed well, by its name or the start of it (review of #406)', () => {
    const names = ['Why Not Bakery front window', 'Go to Screens', 'Breakfast'];
    expect(asksFirst('why are screens behind', names)).toBe(true);
    // A screen named as typed, or starting with it: found first.
    expect(asksFirst('Why not bakery front window', names)).toBe(false);
    expect(asksFirst('why not bakery', names)).toBe(false);
    // Not a question or a request: never first.
    expect(asksFirst('bakery front window lights', [])).toBe(false);
  });

  it("suggests three questions for the page shown: its section's, a record's page by its section's, else Overview's", () => {
    expect(pageQuestions('/screens/scr_1').map((q) => q.label)).toEqual([
      'Which screens need me, and why?',
      'Which screens went quiet today?',
      'Which screens are behind the last publish?',
    ]);
    expect(pageQuestions('/settings/ai')[0]?.label).toBe('Who can publish in this organization?');
    expect(pageQuestions('/')).toHaveLength(3);
    for (const s of SECTIONS) expect(pageQuestions(s.to), s.to).toHaveLength(3);
  });
});
