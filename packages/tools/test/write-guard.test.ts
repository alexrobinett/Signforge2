// Generated from the registry: every tool that changes data writes only through the dispatcher's
// one batch (staged with `ctx.write`), never straight to D1, so a change cannot land without its
// audit row. Each tool runs its example, with ids pointing at its own org's rows, on a D1 that
// records every write run outside the dispatcher's commit: a statement on its own, or a batch of
// its own. The dispatcher commits only after the handler returns, so a batch run while the handler
// runs is the tool's own, whatever it ends with.
import { contentJson, scoped, startPairing } from '@signforge/db';
import { seedOrg, seedTeam, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, dispatch, manifestKey, registry, TOOLS, uploadKey, type AnyTool, type Caller } from '../src';
import { pendingFor } from './connectors-stub';
import { fakeServices } from './services';

const WRITE_SQL = /^\s*(insert|update|delete|replace)\b/i;
/** The dispatcher's commit ends with the call's audit row (`dispatch`, src/dispatch.ts). */
const AUDIT_SQL = /^\s*insert\s+into\s+"audit_log"/i;

/**
 * A D1 that passes everything through, and notes each write run outside the dispatcher's commit:
 * one run on its own (`outside`), or a batch that writes and is not that commit (`batches`): one
 * run while the tool's handler runs (`handling`), or one that does not end with the audit row.
 */
function recordingD1(real: D1Database) {
  const outside: string[] = [];
  const batches: string[][] = [];
  let inHandler = false;
  const handling = async <T>(run: () => Promise<T>): Promise<T> => {
    inHandler = true;
    try {
      return await run();
    } finally {
      inHandler = false;
    }
  };
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
      sql,
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
    batch: (stmts: D1PreparedStatement[]) => {
      const recorded = stmts as unknown as { real: D1PreparedStatement; sql: string }[];
      const sqls = recorded.map((s) => s.sql);
      if (sqls.some((s) => WRITE_SQL.test(s)) && (inHandler || !AUDIT_SQL.test(sqls.at(-1)!))) batches.push(sqls);
      return real.batch(recorded.map((s) => s.real));
    },
    exec: (sql: string) => {
      outside.push(sql);
      return real.exec(sql);
    },
  };
  return { db: db as unknown as D1Database, outside, batches, handling };
}

/** The org's own row for each kind of id a tool input can name, so the tool gets as far as writing. */
const OWN_IDS: Record<string, (o: SeededOrg) => string> = {
  screen: (o) => o.screen,
  group: (o) => o.group,
  credential: (o) => o.credential,
  manifest: () => 'a'.repeat(64),
  template: (o) => o.template,
  templateVersion: (o) => o.templateVersion,
  spot: (o) => o.templateSpot,
  playlist: (o) => o.playlist,
  scheduleEntry: (o) => o.scheduleEntry,
  bundle: () => 'b'.repeat(64),
  sources: () => 'c'.repeat(64),
  asset: (o) => o.asset,
  brandKit: (o) => o.brandKit,
  logoOnDarkAsset: (o) => o.asset,
  logoOnLightAsset: (o) => o.asset,
  dataSource: (o) => o.dataSource,
  alertDelivery: (o) => o.alertDelivery,
  connection: (o) => o.connection,
  publish: (o) => o.publish,
  // An agent grant (M4-07's tools): `grantId`.
  grant: (o) => o.agentGrant,
  publishRequest: (o) => o.publishRequest,
  // Better Auth's rows, as seedTeam names them (PREPARE seeds them).
  member: (o) => `${o.orgId}-member`,
  invitation: (o) => `${o.orgId}-invitation`,
  // An R2 multipart upload's id, not a row.
  upload: () => 'upload-id',
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

const savedKey = async (o: SeededOrg) =>
  o.scope.commit(
    (await o.scope.aiProvider.stage.put({ provider: 'anthropic', keySealed: 'sealed:key', keyLast4: 'abcd', keySavedBy: 'u', keySavedAt: 1 })).writes,
  );

/** An agent's proposal on the seeded spot or playlist (#116), at version 3, as their examples name it. */
async function proposed(o: SeededOrg, kind: 'spot' | 'playlist') {
  const id = kind === 'spot' ? o.templateSpot : o.playlist;
  await env.DB.prepare(`UPDATE ${kind === 'spot' ? 'spots' : 'playlists'} SET row_version = 3 WHERE org_id = ? AND id = ?`)
    .bind(o.orgId, id)
    .run();
  const row = kind === 'spot' ? await o.scope.spots.get(id) : await o.scope.playlists.get(id);
  const items = kind === 'playlist' ? await o.scope.playlists.items(id) : undefined;
  await o.scope.commit(o.scope.draftSnapshots.stage.keep(kind, id, { holds: 'person', contentJson: contentJson(row!, items), sampleFieldsJson: null }).writes);
}

/** Clear what would make a tool's example refuse before it writes. */
const PREPARE: Record<string, (o: SeededOrg) => Promise<unknown>> = {
  revert_spot_draft: (o) => proposed(o, 'spot'),
  keep_spot_draft: (o) => proposed(o, 'spot'),
  revert_playlist_draft: (o) => proposed(o, 'playlist'),
  keep_playlist_draft: (o) => proposed(o, 'playlist'),
  // Its example state, pending for the caller.
  finish_connection: (o) => pendingFor(o.orgId, 'user-g'),
  // Its example code, open to claim.
  claim_screen: () => startPairing(env.DB, { code: 'ABC234', pollTokenHash: 'a'.repeat(64), now: Date.now() }),
  delete_group: (o) => o.scope.scheduleEntries.delete(o.scheduleEntry),
  // The seeded entry, made a takeover.
  end_takeover: (o) => o.scope.scheduleEntries.update(o.scheduleEntry, { priority: 100, startsAt: Date.now(), endsAt: Date.now() + 3_600_000 }),
  delete_playlist: (o) => o.scope.scheduleEntries.delete(o.scheduleEntry),
  // The seeded playlist plays the spot its example names: it plays the other one alone.
  delete_spot: (o) => o.scope.playlists.setItems(o.playlist, [o.imageSpot]),
  delete_asset: async (o) => {
    await o.scope.playlists.setItems(o.playlist, [o.templateSpot]);
    await o.scope.spots.delete(o.imageSpot);
    await o.scope.brandKits.update(o.brandKit, { logoOnDarkAssetId: null });
  },
  renew_asset_upload: (o) => o.scope.assets.update(o.asset, { status: 'pending' }),
  // Its playlist published first, as it publishes only the takeover beside what it pins.
  publish_takeover: (o) =>
    dispatch(
      registry,
      'publish',
      {},
      { org: scoped(env.DB, o.orgId), role: 'owner', actor: { kind: 'user', id: 'user-g', clientId: 'test' }, blobs: env.BLOBS, services: fakeServices },
    ),
  // A saved key to test, or to remove.
  test_ai_provider: (o) => savedKey(o),
  remove_ai_provider: (o) => savedKey(o),
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
  // The member tools' rows. Their changes are Better Auth's, faked here: they write nothing of their own.
  cancel_invitation: (o) => seedTeam(env.DB, o.orgId),
  update_member_role: (o) => seedTeam(env.DB, o.orgId),
  remove_member: (o) => seedTeam(env.DB, o.orgId),
  // A pending video whose uploaded bytes are no MP4: finalize rejects it.
  finalize_video_upload: async (o) => {
    const asset = await o.scope.assets.update(o.asset, { kind: 'video', status: 'pending', type: 'video/mp4', size: 11 });
    await env.BLOBS.put(uploadKey(o.orgId, o.asset, asset!.sha256), 'not a video');
  },
};
/** Inputs a fixed example cannot give: a takeover must end in the future, whenever the test runs. */
const INPUT: Record<string, (o: SeededOrg, example: unknown) => unknown> = {
  start_takeover: (o, example) => ({ ...(withOwnIds(example, o) as object), endsAt: new Date(Date.now() + 3_600_000).toISOString() }),
  publish_takeover: (o, example) => ({ ...(withOwnIds(example, o) as object), endsAt: new Date(Date.now() + 3_600_000).toISOString() }),
  // A draft pinned at the version it is: the seeded spot's first.
  request_publish: (o) => ({ drafts: [{ kind: 'spot', id: o.templateSpot, version: 1 }], reason: 'Weekend opening hours' }),
};
/** Tools whose example is refused on purpose, changing the asset as it does so. */
const REJECTS = new Set(['finalize_asset', 'finalize_video_upload']);
/** Tools whose example still cannot get as far as writing: their bundle is not uploaded. They are covered in templates.test.ts. */
const STOPS_SHORT = new Set(['register_template_version']);

let n = 0;
async function runRecorded(tool: AnyTool, input: unknown) {
  const o = await seedOrg(env.DB, `guard-${++n}`);
  await env.BLOBS.put(manifestKey(o.orgId, o.screen, 'a'.repeat(64)), '{}');
  await PREPARE[tool.name]?.(o);
  const { db, outside, batches, handling } = recordingD1(env.DB);
  const caller: Caller = {
    org: scoped(db, o.orgId),
    role: 'owner',
    actor: { kind: 'user', id: 'user-g', clientId: 'test' },
    blobs: env.BLOBS,
    services: fakeServices,
  };
  const reg = new Map([[tool.name, { ...tool, handler: (ctx) => handling(() => tool.handler(ctx)) } satisfies AnyTool]]);
  const result = await dispatch(reg, tool.name, input ?? INPUT[tool.name]?.(o, tool.example) ?? withOwnIds(tool.example, o), caller);
  if (REJECTS.has(tool.name)) expect((await o.scope.assets.get(o.asset))?.status).toBe('rejected');
  const audit = await scoped(env.DB, o.orgId).auditLog.list({ limit: 10 });
  return { result, outside, batches, audited: audit.some((e) => e.action === tool.name) };
}

beforeAll(() => {
  expect(TOOLS.filter((t) => t.mutates).length).toBeGreaterThan(0);
});

describe('every tool that changes data', () => {
  for (const tool of TOOLS.filter((t) => t.mutates)) {
    it(`${tool.name}: writes nothing outside the batch`, async () => {
      const { result, outside, batches } = await runRecorded(tool, undefined);
      expect(outside, `${tool.name} wrote straight to D1 (${JSON.stringify(result)})`).toEqual([]);
      expect(batches, `${tool.name} committed a batch of its own (${JSON.stringify(result)})`).toEqual([]);
      // The finalize tools refuse the seeded files, marking the asset rejected: a write too.
      if (!STOPS_SHORT.has(tool.name) && !REJECTS.has(tool.name)) expect(result, tool.name).toMatchObject({ ok: true });
    });
  }

  it('is caught when it writes straight to D1', async () => {
    const rogue = defineTool({
      name: 'rogue_switch',
      description: 'A test tool that writes around the dispatcher, to show the guard catches it.',
      scope: 'screens:manage',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ switched: z.boolean() }),
      example: { screenId: 'scr_example' },
      handler: async ({ org, input }) => ({ switched: await org.screens.setDesiredManifest(input.screenId, 'f'.repeat(64)) }),
    });
    const { outside, batches, audited } = await runRecorded(rogue, undefined);
    expect(outside).toHaveLength(1);
    expect(batches).toEqual([]);
    // The change went in and nothing recorded it: what this guard exists to stop.
    expect(audited).toBe(false);
  });

  it('is caught when it commits a batch of its own', async () => {
    const rogue = defineTool({
      name: 'rogue_commit',
      description: 'A test tool that stages its write but commits it itself, outside the audited batch.',
      scope: 'screens:manage',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ screen: z.unknown() }),
      example: { screenId: 'scr_example' },
      handler: async ({ org, input }) => {
        const change = org.screens.stage.update((await org.screens.get(input.screenId))!, { name: 'rogue' });
        await org.commit(change.writes);
        return { screen: change.row };
      },
    });
    const { outside, batches, audited } = await runRecorded(rogue, undefined);
    expect(outside).toEqual([]);
    expect(batches).toHaveLength(1);
    expect(audited).toBe(false);
  });

  it('is caught when it commits its change with an audit row of its own', async () => {
    const rogue = defineTool({
      name: 'rogue_audited_commit',
      description: 'A test tool that commits its write and an audit row for it itself, a batch the dispatcher never ran.',
      scope: 'screens:manage',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ screen: z.unknown() }),
      example: { screenId: 'scr_example' },
      handler: async ({ org, actor, input }) => {
        const change = org.screens.stage.update((await org.screens.get(input.screenId))!, { name: 'rogue' });
        const audit = org.auditLog.stage({
          actorKind: actor.kind,
          actorId: actor.id,
          clientId: actor.clientId ?? null,
          action: 'rogue_audited_commit',
          targetKind: 'screen',
          targetId: input.screenId,
          detailJson: '{}',
        });
        await org.commit([...change.writes, ...audit.writes]);
        return { screen: change.row };
      },
    });
    const { outside, batches, audited } = await runRecorded(rogue, undefined);
    expect(outside).toEqual([]);
    expect(batches).toHaveLength(1);
    // Audited, and still outside the dispatcher: its checks, redaction and refusals never saw it.
    expect(audited).toBe(true);
  });

  it('is caught when it appends an audit row of its own', async () => {
    const rogue = defineTool({
      name: 'rogue_append',
      description: 'A test tool that writes an audit row itself, which no change of its commits with.',
      scope: 'screens:manage',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      example: { screenId: 'scr_example' },
      handler: async ({ org, input }) => {
        await org.auditLog.append({ actorKind: 'system', actorId: 'rogue', action: 'rogue_note', targetKind: 'screen', targetId: input.screenId });
        return { ok: true };
      },
    });
    const { outside, batches } = await runRecorded(rogue, undefined);
    expect([...outside, ...batches.flat()]).toHaveLength(1);
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
