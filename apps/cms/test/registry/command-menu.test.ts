import { describeTools, registry, TOOLS, type Role } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import {
  commandEntries,
  foundValues,
  movesSelection,
  needsInput,
  NULL_CHOICE,
  parseToolList,
  pointerMovesSelection,
  resultText,
  selectedItem,
  targetActions,
  targetItemKey,
  toolInput,
  withKey,
} from '../../src/lib/command-menu';
import type { GroupView, ScreenView } from '../../src/lib/screen-types';
import { SECTIONS } from '../../src/lib/sections';

// What `GET /api/tools` sends: `describeTools` for the member's role, in an org where editors publish (the default).
const listed = (role: Role) => parseToolList(JSON.parse(JSON.stringify({ tools: describeTools(registry, { role, editorsPublish: true }) })));
const toolNames = (role: Role) => commandEntries(listed(role)).flatMap((e) => (e.kind === 'tool' || e.kind === 'takeover' ? [e.tool.name] : []));

describe('command menu entries', () => {
  // Restart goes only to a screen in touch: it is each found screen's action, with that check, never a plain tool (#253 review).
  const PER_SCREEN = ['restart_screen'];

  it('lists every tool an owner may use: the whole registry, but for Restart', () => {
    expect(toolNames('owner').sort()).toEqual(
      TOOLS.map((t) => t.name)
        .filter((n) => !PER_SCREEN.includes(n))
        .sort(),
    );
  });

  it('offers Restart only on a found screen, where it is checked: never as a tool whose form takes any screen id', () => {
    for (const role of ['owner', 'editor'] as const) {
      expect(listed(role).map((t) => t.name)).toContain('restart_screen');
      expect(toolNames(role)).not.toContain('restart_screen');
    }
  });

  it('lists every tool an editor may use, and none of the owner-only ones', () => {
    const editorTools = TOOLS.filter((t) => t.minRole !== 'owner' && !PER_SCREEN.includes(t.name)).map((t) => t.name);
    expect(toolNames('editor').sort()).toEqual(editorTools.sort());
    expect(toolNames('editor')).not.toContain('revoke_screen_credential');
  });

  it('lists only the read tools for a viewer, and the people-only ones for their own agents', () => {
    // A viewer changes nothing in the org, but may change or disconnect the agents they connected (M4-07).
    const reads = TOOLS.filter((t) => (!t.mutates || t.people) && t.minRole === 'viewer').map((t) => t.name);
    expect(toolNames('viewer').sort()).toEqual(reads.sort());
    expect(toolNames('viewer')).toEqual(expect.arrayContaining(['list_screens', 'get_screen']));
    expect(toolNames('viewer')).not.toContain('rename_screen');
  });

  it('starts with a navigation entry for every section of the sidebar', () => {
    const go = commandEntries([]).flatMap((e) => (e.kind === 'go' ? [e.to] : []));
    expect(go).toEqual(SECTIONS.map((s) => s.to));
  });

  it('names a tool from the first sentence of its description, up to a colon, a semicolon or ", so"', () => {
    const byName = new Map(commandEntries(listed('owner')).flatMap((e) => (e.kind === 'tool' ? [[e.tool.name, e.label]] : [])));
    expect(byName.get('rename_screen')).toBe('Rename a screen');
    expect(byName.get('claim_screen')).toBe('Pair a screen');
    expect(byName.get('revoke_screen_credential')).toBe("Revoke one of a screen's credentials");
    expect(byName.get('list_screens')).toBe('List the screens in the organization with their settings, labels, status and manifests');
  });

  it('opens the takeover dialog, sent at once, for a member who may publish, as the Schedule page does (#253)', () => {
    const takeover = commandEntries(listed('owner')).find((e) => e.id === 'tool:start_takeover');
    expect(takeover).toMatchObject({ kind: 'takeover', label: 'Take over screens now…' });
    // An editor where only owners publish can only draft one, as the tool says.
    const drafts = parseToolList(JSON.parse(JSON.stringify({ tools: describeTools(registry, { role: 'editor', editorsPublish: false }) })));
    expect(commandEntries(drafts).find((e) => e.id === 'tool:start_takeover')).toMatchObject({
      kind: 'tool',
      label: 'Take over screens with a playlist, as a draft',
    });
  });
});

describe('a tool form’s input', () => {
  const fieldsOf = (name: string) => listed('owner').find((t) => t.name === name)!.fields;
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(values)) data.set(k, v);
    return data;
  };

  it('reads text fields and leaves out empty optional ones', () => {
    expect(toolInput(fieldsOf('rename_screen'), form({ screenId: 'scr_1', name: 'Lobby' }))).toEqual({ ok: true, input: { screenId: 'scr_1', name: 'Lobby' } });
    expect(toolInput(fieldsOf('list_assets'), form({ query: '', status: '', limit: '' }))).toEqual({ ok: true, input: {} });
  });

  it('offers a nullable choice with null as an option', () => {
    const state = fieldsOf('set_display_override').find((f) => f.name === 'state')!;
    expect(state).toMatchObject({ type: 'choice', options: ['on', 'off'], nullable: true, required: true });
    expect(toolInput(fieldsOf('set_display_override'), form({ screenId: 's', state: NULL_CHOICE }))).toEqual({
      ok: true,
      input: { screenId: 's', state: null },
    });
    expect(toolInput(fieldsOf('set_display_override'), form({ screenId: 's', state: 'off' }))).toEqual({ ok: true, input: { screenId: 's', state: 'off' } });
  });

  it('reads numbers, and refuses one that is not a number', () => {
    expect(toolInput(fieldsOf('list_screens'), form({ limit: '20', cursor: '' }))).toEqual({ ok: true, input: { limit: 20 } });
    expect(toolInput(fieldsOf('list_screens'), form({ limit: 'many' }))).toEqual({ ok: false, field: 'limit', message: 'limit must be a number.' });
  });

  it('reads JSON fields, and refuses JSON that does not parse', () => {
    const fields = fieldsOf('create_group');
    expect(fields.map((f) => f.type)).toEqual(['text', 'json', 'key']);
    expect(toolInput(fields, form({ name: 'Downtown', screenIds: '["s1","s2"]' }))).toEqual({ ok: true, input: { name: 'Downtown', screenIds: ['s1', 's2'] } });
    expect(toolInput(fields, form({ name: 'x', screenIds: '[s1' }))).toEqual({
      ok: false,
      field: 'screenIds',
      message: 'screenIds must be JSON, such as ["a", "b"] or {"key": "value"}.',
    });
  });

  it('keeps one idempotency key per call across retries, and makes a new one for a new call', () => {
    const tool = listed('owner').find((t) => t.name === 'create_group')!;
    const first = withKey(tool, { name: 'Downtown' }, null);
    const key = first.input.idempotencyKey;
    expect(typeof key === 'string' && key.length >= 8).toBe(true);
    // The answer was lost: the same form sent again is the same call.
    expect(withKey(tool, { name: 'Downtown' }, first.pending).input).toEqual({ name: 'Downtown', idempotencyKey: key });
    // Changed input, or another tool, is a new call.
    expect(withKey(tool, { name: 'Uptown' }, first.pending).input.idempotencyKey).not.toBe(key);
    const rename = listed('owner').find((t) => t.name === 'rename_screen')!;
    expect(withKey(rename, { screenId: 's', name: 'Downtown' }, first.pending)).toEqual({ input: { screenId: 's', name: 'Downtown' }, pending: null });
  });

  it('runs at once only when the tool needs no input', () => {
    expect(needsInput(listed('owner').find((t) => t.name === 'list_screens')!)).toBe(false);
    expect(needsInput(listed('owner').find((t) => t.name === 'identify_screen')!)).toBe(true);
  });
});

describe('a result toast', () => {
  it('counts lists, names what was changed, and says when nothing changed', () => {
    expect(resultText({ screens: [{}, {}], next: null })).toBe('2 screens');
    expect(resultText({ screen: { id: 's', name: 'Lobby' } })).toBe('Lobby');
    expect(resultText({ screenId: 's', seconds: 10 })).toBe('Done');
    expect(resultText({ screenId: 's', manifestId: 'm', changed: false })).toBe('Nothing changed: it was already so');
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
