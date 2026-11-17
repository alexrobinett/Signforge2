// Generated from the registry: every tool that changes data writes only through the dispatcher's
// one batch (staged with `ctx.write`), never straight to D1, so a change cannot land without its
// audit row. Each tool runs its example, with ids pointing at its own org's rows, on a D1 that
// records every statement run outside `batch()`.
import { scoped, startPairing } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, dispatch, manifestKey, r2Presigner, TOOLS, uploadKey, type AnyTool, type Caller } from '../src';

const WRITE_SQL = /^\s*(insert|update|delete|replace)\b/i;

/** A D1 that passes everything through, and notes each write run on its own instead of in a batch. */
function recordingD1(real: D1Database) {
  const outside: string[] = [];
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const note = () => {
      if (WRITE_SQL.test(sql)) outside.push(sql);
    };
    const call =
      (method: 'run' | 'all' | 'raw' | 'first') =>
      (...args: unknown[]) => {
        note();
        return (stmt[method] as (...a: unknown[]) => unknown).apply(stmt, args);
      };
    const w = {
      real: stmt,
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql),
      run: call('run'),
      all: call('all'),
      raw: call('raw'),
      first: call('first'),
    };
    return w as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql),
    batch: (stmts: D1PreparedStatement[]) => real.batch(stmts.map((s) => (s as unknown as { real: D1PreparedStatement }).real)),
    exec: (sql: string) => {
      outside.push(sql);
      return real.exec(sql);
    },
  };
  return { db: db as unknown as D1Database, outside };
}

/** The org's own row for each kind of id a tool input can name, so the tool gets as far as writing. */
const OWN_IDS: Record<string, (o: SeededOrg) => string> = {
  screen: (o) => o.screen,
  group: (o) => o.group,
  credential: (o) => o.credential,
  manifest: () => 'a'.repeat(64),
  template: (o) => o.template,
  templateVersion: (o) => o.templateVersion,
  bundle: () => 'b'.repeat(64),
  sources: () => 'c'.repeat(64),
  asset: (o) => o.asset,
  brandKit: (o) => o.brandKit,
  logoOnDarkAsset: (o) => o.asset,
  logoOnLightAsset: (o) => o.asset,
  // Catalogue ids, the same for every org.
  displayFont: () => 'base/oswald',
  bodyFont: () => 'base/inter',
};

function withOwnIds(example: unknown, o: SeededOrg): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => {
        const kind = k.endsWith('Ids') ? k.slice(0, -3) : k.endsWith('Id') ? k.slice(0, -2) : undefined;
        if (kind && OWN_IDS[kind] === undefined) throw new Error(`input field "${k}" names ids of kind "${kind}": add it to OWN_IDS`);
        if (kind && Array.isArray(val)) return [k, val.map(() => OWN_IDS[kind]!(o))];
        if (kind && typeof val === 'string') return [k, OWN_IDS[kind]!(o)];
        return [k, walk(val)];
      }),
    );
  };
  return walk(example);
}

/** Clear what would make a tool's example refuse before it writes. */
const PREPARE: Record<string, (o: SeededOrg) => Promise<unknown>> = {
  // Its example code, open to claim.
  claim_screen: () => startPairing(env.DB, { code: 'ABC234', pollTokenHash: 'a'.repeat(64), now: Date.now() }),
  delete_group: (o) => o.scope.scheduleEntries.delete(o.scheduleEntry),
  delete_asset: async (o) => {
    await o.scope.playlists.setItems(o.playlist, [o.templateSpot]);
    await o.scope.spots.delete(o.imageSpot);
    await o.scope.brandKits.update(o.brandKit, { logoOnDarkAssetId: null });
  },
  // Pending, both renditions, and an upload whose bytes do not hash to the claim: finalize rejects it.
  finalize_asset: async (o) => {
    await o.scope.assets.update(o.asset, { status: 'pending' });
    await o.scope.assets.renditions.insert({
      assetId: o.asset,
      orientation: 'portrait',
      sha256: 'b'.repeat(64),
      type: 'image/jpeg',
      size: 900,
      width: 1080,
      height: 1920,
    });
    await env.BLOBS.put(uploadKey(o.orgId, o.asset, 'b'.repeat(64)), 'not the claimed bytes');
  },
};
/** Tools whose example still cannot get as far as writing: their bundle is not uploaded. They are covered in templates.test.ts. */
const STOPS_SHORT = new Set(['register_template_version']);

let n = 0;
async function runRecorded(tool: AnyTool, input: unknown) {
  const o = await seedOrg(env.DB, `guard-${++n}`);
  await env.BLOBS.put(manifestKey(o.orgId, o.screen, 'a'.repeat(64)), '{}');
  await PREPARE[tool.name]?.(o);
  const { db, outside } = recordingD1(env.DB);
  const caller: Caller = {
    org: scoped(db, o.orgId),
    role: 'owner',
    actor: { kind: 'user', id: 'user-g', clientId: 'test' },
    blobs: env.BLOBS,
    uploads: r2Presigner({ endpoint: 'https://r2.test', bucket: 'blobs', accessKeyId: 'k', secretAccessKey: 's' }),
    rateLimit: async () => true,
  };
  const reg = new Map([[tool.name, tool]]);
  const result = await dispatch(reg, tool.name, input ?? withOwnIds(tool.example, o), caller);
  if (tool.name === 'finalize_asset') expect((await o.scope.assets.get(o.asset))?.status).toBe('rejected');
  const audit = await scoped(env.DB, o.orgId).auditLog.list({ limit: 10 });
  return { result, outside, audited: audit.some((e) => e.action === tool.name) };
}

beforeAll(() => {
  expect(TOOLS.filter((t) => t.mutates).length).toBeGreaterThan(0);
});

describe('every tool that changes data', () => {
  for (const tool of TOOLS.filter((t) => t.mutates)) {
    it(`${tool.name}: writes nothing outside the batch`, async () => {
      const { result, outside } = await runRecorded(tool, undefined);
      expect(outside, `${tool.name} wrote straight to D1 (${JSON.stringify(result)})`).toEqual([]);
      // finalize_asset refuses the seeded files (their hashes are made up), marking the asset rejected: a write too.
      if (!STOPS_SHORT.has(tool.name) && tool.name !== 'finalize_asset') expect(result, tool.name).toMatchObject({ ok: true });
    });
  }

  it('is caught when it writes straight to D1', async () => {
    const rogue = defineTool({
      name: 'rogue_rename',
      description: 'A test tool that writes around the dispatcher, to show the guard catches it.',
      scope: 'screens:manage',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ screen: z.unknown() }),
      example: { screenId: 'scr_example' },
      handler: async ({ org, input }) => ({ screen: await org.screens.update(input.screenId, { name: 'rogue' }) }),
    });
    const { outside, audited } = await runRecorded(rogue, undefined);
    expect(outside).toHaveLength(1);
    // The change went in and nothing recorded it: what this guard exists to stop.
    expect(audited).toBe(false);
  });

  it('is not caught when it stages its change', async () => {
    const staged = defineTool({
      name: 'staged_rename',
      description: 'A test tool that stages its write, as every tool must, through ctx.write.',
      scope: 'screens:manage',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ screen: z.unknown() }),
      example: { screenId: 'scr_example' },
      handler: async ({ org, input, write }) => ({ screen: write(org.screens.stage.update((await org.screens.get(input.screenId))!, { name: 'staged' })) }),
    });
    const { result, outside, audited } = await runRecorded(staged, undefined);
    expect(result).toMatchObject({ ok: true, output: { screen: { name: 'staged' } } });
    expect(outside).toEqual([]);
    expect(audited).toBe(true);
  });
});
