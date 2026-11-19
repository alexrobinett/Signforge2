// list_audit_log (#82): the org's audit rows newest first, a page at a time, filtered.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller } from '../src';
import { member } from './member';

let o: SeededOrg;
const as = (role: Caller['role']) => member(o.orgId, role);

interface Entry {
  at: number;
  actor: { kind: string; id: string; clientId: string | null };
  action: string;
  target: { kind: string; id: string } | null;
  detail: Record<string, unknown>;
}

async function list(input: Record<string, unknown>, role: Caller['role'] = 'viewer') {
  const r = await dispatch(registry, 'list_audit_log', input, as(role));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.output as { entries: Entry[]; next: string | null };
}

/** Every page of the log for `input`, in order. */
async function all(input: Record<string, unknown>) {
  const out: Entry[] = [];
  let cursor: string | undefined;
  do {
    const p = await list({ ...input, ...(cursor ? { cursor } : {}) });
    out.push(...p.entries);
    cursor = p.next ?? undefined;
  } while (cursor);
  return out;
}

const T = Date.UTC(2026, 10, 18, 9);

beforeAll(async () => {
  o = await seedOrg(env.DB, 'audit-org');
  const log = scoped(env.DB, o.orgId).auditLog;
  // Three rows in one millisecond, so paging must break ties; and an agent's limit refusal, whose id is long (#77).
  for (const [i, name] of ['First', 'Second', 'Third'].entries())
    await log.append({
      at: T,
      actorKind: 'user',
      actorId: 'usr_jun',
      clientId: 'cms',
      action: 'rename_screen',
      targetKind: 'screen',
      targetId: o.screen,
      detailJson: JSON.stringify({ input: { screenId: o.screen, name: `${name} ${i}` } }),
    });
  await log.appendOnce(`rate_limited_${'g'.repeat(40)}_minute_${T + 1000}`, {
    at: T + 1000,
    actorKind: 'agent',
    actorId: 'grt_price_bot',
    clientId: 'price-bot',
    action: 'rate_limited',
    detailJson: JSON.stringify({ tool: 'update_spot', refused: { error: 'rate_limited', message: 'over' } }),
  });
});

describe('list_audit_log', () => {
  it('lists the newest first, a page at a time, with no row repeated or skipped', async () => {
    const pages = await all({ limit: 2 });
    expect(pages.map((e) => e.action)).toEqual(['rate_limited', 'rename_screen', 'rename_screen', 'rename_screen', 'seed']);
    // Rows of one millisecond: the latest written first.
    expect(pages.slice(1, 4).map((e) => e.detail.input)).toEqual([
      { screenId: o.screen, name: 'Third 2' },
      { screenId: o.screen, name: 'Second 1' },
      { screenId: o.screen, name: 'First 0' },
    ]);
    expect(pages[0]).toEqual({
      at: T + 1000,
      actor: { kind: 'agent', id: 'grt_price_bot', clientId: 'price-bot' },
      action: 'rate_limited',
      target: null,
      detail: { tool: 'update_spot', refused: { error: 'rate_limited', message: 'over' } },
    });
  });

  it('filters by actor, action, target, time and text', async () => {
    const actions = async (input: Record<string, unknown>) => (await all(input)).map((e) => `${e.action}@${e.at}`);
    expect(await actions({ actor: { kind: 'agent' } })).toEqual([`rate_limited@${T + 1000}`]);
    expect(await actions({ actor: { id: 'usr_jun' } })).toHaveLength(3);
    expect(await actions({ actor: { kind: 'device', id: 'usr_jun' } })).toEqual([]);
    expect(await actions({ action: 'seed' })).toHaveLength(1);
    expect(await actions({ target: { kind: 'screen' } })).toHaveLength(3);
    expect(await actions({ target: { kind: 'screen', id: o.screen } })).toHaveLength(3);
    // A target that is gone, or never was, still filters: its history, if any.
    expect(await actions({ target: { kind: 'screen', id: 'scr_deleted' } })).toEqual([]);
    expect(await actions({ from: T, to: T + 1000 })).toEqual([`rename_screen@${T}`, `rename_screen@${T}`, `rename_screen@${T}`]);
    expect(await actions({ from: T + 1 })).toEqual([`rate_limited@${T + 1000}`]);
    // Text: in the recorded input, any case; LIKE's wildcards are plain characters.
    expect((await all({ query: 'second' })).map((e) => e.detail.input)).toEqual([{ screenId: o.screen, name: 'Second 1' }]);
    expect(await actions({ query: 'price_bot' })).toEqual([`rate_limited@${T + 1000}`]);
    expect(await actions({ query: '%' })).toEqual([]);
    expect(await actions({ query: '_' })).toHaveLength(4);
  });

  it('pages a filtered list with the same filters', async () => {
    const first = await list({ actor: { id: 'usr_jun' }, limit: 2 });
    expect(first.entries).toHaveLength(2);
    const second = await list({ actor: { id: 'usr_jun' }, limit: 2, cursor: first.next });
    expect(second).toMatchObject({ entries: [{ detail: { input: { name: 'First 0' } } }], next: null });
  });

  it('returns inputs as they were recorded, secrets redacted', async () => {
    const editor: Caller = { ...as('editor'), feedUrls: { seal: async (_source, url) => `sealed:${url}` } };
    const made = await dispatch(
      registry,
      'create_data_source',
      { name: 'Menu feed', format: 'json', feedUrl: 'https://feeds.example.com/menu?key=hunter2' },
      editor,
    );
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const [entry] = await all({ action: 'create_data_source' });
    expect(entry).toMatchObject({ actor: { kind: 'user', id: 'user-editor', clientId: 'cms' }, target: { kind: 'data_source' } });
    expect(entry!.detail.input).toMatchObject({ name: 'Menu feed', feedUrl: '[redacted]' });
    expect(JSON.stringify(await all({}))).not.toContain('hunter2');
    // Search reads what was stored, so a secret cannot be found by guessing it either.
    expect(await all({ query: 'hunter2' })).toEqual([]);
  });

  it('refuses a cursor it did not make', async () => {
    const forged = btoa(JSON.stringify(['a', 'b'])).replace(/=+$/, '');
    expect(await dispatch(registry, 'list_audit_log', { cursor: forged }, as('viewer'))).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('searches with the longest text it takes, in any script and with wildcard characters', async () => {
    // D1 refuses a LIKE pattern over 50 bytes; this text is 200 bytes in UTF-8.
    const long = `${'Ä_%'.repeat(33)}Ä`;
    expect(long).toHaveLength(100);
    await scoped(env.DB, o.orgId).auditLog.append({
      at: T + 2000,
      actorKind: 'user',
      actorId: 'usr_jun',
      clientId: 'cms',
      action: 'rename_spot',
      detailJson: JSON.stringify({ input: { name: `Menu ${long}` } }),
    });
    expect((await all({ query: long })).map((e) => e.action)).toEqual(['rename_spot']);
    expect(await all({ query: 'z'.repeat(100) })).toEqual([]);
  });
});
