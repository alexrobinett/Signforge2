// The conventions every tool keeps: it declares what it returns, and a list pages.
import { scoped } from '@signforge/db';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  describeTools,
  dispatch,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PLATFORM_TOOLS,
  registry,
  setOutputChecks,
  TOOLS,
  type AnyTool,
  type Caller,
} from '../src';
import { seededMembers } from './member';

const { o, as } = seededMembers('conv-org');
let owner: Caller;

beforeAll(() => {
  owner = as('owner');
});

const shapeOf = (schema: z.ZodType) => (schema instanceof z.ZodObject ? schema.shape : undefined);

describe('every registered tool', () => {
  const all: AnyTool<any>[] = [...TOOLS, ...PLATFORM_TOOLS];

  it('declares an output schema, representable as JSON Schema', () => {
    for (const t of all) {
      expect(t.output, `${t.name} has no output schema`).toBeInstanceOf(z.ZodType);
      expect(() => z.toJSONSchema(t.output, { io: 'output', unrepresentable: 'any' }), t.name).not.toThrow();
    }
  });

  it('pages if it lists: limit and cursor in, next out', () => {
    const lists = all.filter((t) => t.name.startsWith('list_'));
    expect(lists.length).toBeGreaterThan(0);
    for (const t of lists) {
      const input = shapeOf(t.input);
      const output = shapeOf(t.output);
      expect(input && 'limit' in input && 'cursor' in input, `${t.name} input needs limit and cursor`).toBe(true);
      expect(output && 'next' in output, `${t.name} output needs next`).toBe(true);
    }
  });

  it('accepts ifVersion if it updates a row, and returns the version to pass', () => {
    // An update tool is named for the change (update_*, rename_*) or replaces a list (set_*_members).
    const updates = all.filter((t) => /^(update|rename)_|^set_\w+_members$/.test(t.name));
    expect(updates.map((t) => t.name)).toEqual(expect.arrayContaining(['rename_screen', 'update_screen_settings', 'set_group_members']));
    for (const t of updates) {
      expect(t.mutates, t.name).toBe(true);
      expect(shapeOf(t.input)?.ifVersion, `${t.name} input needs ifVersion (fields.ts)`).toBeDefined();
      const result = Object.values(shapeOf(t.output) ?? {})[0];
      expect(result && shapeOf(result)?.version, `${t.name} output needs the row's version`).toBeDefined();
    }
  });

  it('is listed with its output schema', () => {
    const listed = describeTools(registry, { role: 'owner', editorsPublish: true });
    expect(listed.every((t) => t.outputSchema && typeof t.outputSchema === 'object')).toBe(true);
  });
});

describe('the output check', () => {
  const liar = defineTool({
    name: 'liar',
    description: 'A tool whose handler returns something other than its output schema says, for this test only.',
    scope: 'content:read',
    minRole: 'viewer',
    mutates: false,
    input: z.object({}),
    output: z.object({ count: z.number() }),
    example: {},
    handler: async () => ({ count: 'three' }) as never,
  });
  const fake = new Map<string, AnyTool>([['liar', liar]]);

  it('fails a handler that returns the wrong shape, in tests', async () => {
    await expect(dispatch(fake, 'liar', {}, owner)).rejects.toThrow(/liar returned output its schema refuses/);
  });

  it('is off in production', async () => {
    setOutputChecks(false);
    try {
      expect(await dispatch(fake, 'liar', {}, owner)).toEqual({ ok: true, output: { count: 'three' } });
    } finally {
      setOutputChecks(true);
    }
  });
});

describe('paging', () => {
  it('defaults the limit, caps it, and walks every row once', async () => {
    const org = scoped(env.DB, o.orgId);
    for (let i = 0; i < 4; i++) await org.screens.insert({ name: `Page ${i}`, timezone: 'UTC', orientation: 'landscape' });
    const all = (await org.screens.list()).map((s) => s.id);
    expect(all.length).toBe(5);

    const first = await dispatch(registry, 'list_screens', {}, owner);
    expect(first).toMatchObject({ ok: true, output: { next: null } });
    expect(DEFAULT_PAGE_LIMIT).toBeGreaterThanOrEqual(5);
    expect(await dispatch(registry, 'list_screens', { limit: MAX_PAGE_LIMIT + 1 }, owner)).toMatchObject({ ok: false, error: 'invalid_input' });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const r = await dispatch(registry, 'list_screens', { limit: 2, cursor }, owner);
      if (!r.ok) throw new Error(r.message);
      const out = r.output as { screens: { id: string }[]; next: string | null };
      expect(out.screens.length).toBeLessThanOrEqual(2);
      seen.push(...out.screens.map((s) => s.id));
      if (!out.next) break;
      cursor = out.next;
    }
    expect(seen).toEqual(all);
  });

  it('gives every list tool the same rows, in the same order, one at a time as all at once', async () => {
    const org = scoped(env.DB, o.orgId);
    // Assets made back to back often share a millisecond; the id breaks the tie.
    for (const n of ['Tie a', 'Tie b', 'Tie c'])
      await org.assets.insert({ kind: 'image', name: n, sha256: 'a'.repeat(64), type: 'image/png', size: 1, width: 1, height: 1, status: 'verified' });
    for (const t of TOOLS.filter((t) => t.name.startsWith('list_'))) {
      const whole = await dispatch(registry, t.name, { limit: MAX_PAGE_LIMIT }, owner);
      if (!whole.ok) throw new Error(`${t.name}: ${whole.message}`);
      const [field] = Object.keys(whole.output as object).filter((k) => k !== 'next');
      const ids = (whole.output as Record<string, { id: string }[]>)[field!]!.map((r) => r.id);
      expect(ids.length, t.name).toBeGreaterThan(0);

      const walked: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i <= ids.length; i++) {
        const r = await dispatch(registry, t.name, { limit: 1, cursor }, owner);
        if (!r.ok) throw new Error(`${t.name}: ${r.message}`);
        const out = r.output as Record<string, unknown> & { next: string | null };
        walked.push(...(out[field!] as { id: string }[]).map((x) => x.id));
        if (!out.next) break;
        cursor = out.next;
      }
      expect(walked, t.name).toEqual(ids);
    }
  });

  it('refuses a cursor it did not make', async () => {
    expect(await dispatch(registry, 'list_screens', { cursor: 'not-a-cursor' }, owner)).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
