import { describeTools, registry, TOOLS, type Role } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import { commandEntries, needsInput, NULL_CHOICE, parseToolList, resultText, toolInput, withKey } from '../../src/lib/command-menu';
import { SECTIONS } from '../../src/lib/sections';

// What `GET /api/tools` sends: `describeTools` for the member's role, in an org where editors publish (the default).
const listed = (role: Role) => parseToolList(JSON.parse(JSON.stringify({ tools: describeTools(registry, { role, editorsPublish: true }) })));
const toolNames = (role: Role) => commandEntries(listed(role)).flatMap((e) => (e.kind === 'tool' ? [e.tool.name] : []));

describe('command menu entries', () => {
  it('lists every tool an owner may use: the whole registry', () => {
    expect(toolNames('owner').sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('lists every tool an editor may use, and none of the owner-only ones', () => {
    const editorTools = TOOLS.filter((t) => t.minRole !== 'owner').map((t) => t.name);
    expect(toolNames('editor').sort()).toEqual(editorTools.sort());
    expect(toolNames('editor')).not.toContain('revoke_screen_credential');
  });

  it('lists only the read tools for a viewer', () => {
    const reads = TOOLS.filter((t) => !t.mutates && t.minRole === 'viewer').map((t) => t.name);
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
    expect(byName.get('restart_screen')).toBe("Restart the screen's player now");
    expect(byName.get('revoke_screen_credential')).toBe("Revoke one of a screen's credentials");
    expect(byName.get('list_screens')).toBe('List the screens in the organization with their settings, status and manifests');
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
