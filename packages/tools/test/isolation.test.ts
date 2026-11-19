// Generated from the registry: every tool, called as org B's owner with one of org A's ids, finds
// nothing and changes nothing. The id fields come from each tool's input schema, optional ones and
// those of one branch included; each is tried on its own, the rest of the input naming org B's
// own rows, so a check on one id cannot hide a missing check on another. A new tool is covered as
// soon as it is registered; a new kind of id field fails here until it is mapped below.
import { scoped, startPairing } from '@signforge/db';
import { seedTwoOrgs, type Seeded, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatch, manifestKey, orgBlobKey, r2Presigner, registry, TOOLS, type AnyTool, type Caller } from '../src';
import { connectors, pendingFor } from './connectors-stub';

/** Each org's manifest for its screen, and its uploaded template bundle and sources. */
const FILES = {
  'org-a': { manifest: 'a'.repeat(64), bundle: 'b'.repeat(64), sources: 'c'.repeat(64) },
  'org-b': { manifest: 'd'.repeat(64), bundle: 'e'.repeat(64), sources: 'f'.repeat(64) },
} as const;

/** An org's row for each kind of id a tool input can name (`screenId` → `screen`). */
const ORG_IDS: Record<string, (o: SeededOrg) => string> = {
  screen: (o) => o.screen,
  group: (o) => o.group,
  credential: (o) => o.credential,
  manifest: (o) => files(o).manifest,
  template: (o) => o.template,
  templateVersion: (o) => o.templateVersion,
  spot: (o) => o.templateSpot,
  playlist: (o) => o.playlist,
  bundle: (o) => files(o).bundle,
  sources: (o) => files(o).sources,
  asset: (o) => o.asset,
  brandKit: (o) => o.brandKit,
  logoOnDarkAsset: (o) => o.asset,
  logoOnLightAsset: (o) => o.asset,
  dataSource: (o) => o.dataSource,
  connection: (o) => o.connection,
};
const files = (o: SeededOrg) => FILES[o.orgId as keyof typeof FILES];

/** Ids that name a catalogue every org shares, not an org's row: any org may use them. */
const CATALOGUE_IDS: Record<string, string> = { displayFont: 'base/oswald', bodyFont: 'base/inter' };

/** Ids that name no row at all, so no org has one to lend: an R2 multipart upload's (finalize_video_upload finds the asset first). */
const NOT_ROWS = new Set(['upload']);

/** The kind of id a field names, if it names one: `screenId` → `screen`, `groupIds` → `group`. */
const kindOf = (key: string) => (key.endsWith('Ids') ? key.slice(0, -3) : key.endsWith('Id') ? key.slice(0, -2) : undefined);

interface IdField {
  path: string[];
  kind: string;
  many: boolean;
  optional: boolean;
}

/** Every id field of an input schema (as JSON Schema), at any depth, optional or not, in every branch. */
function idFields(schema: unknown, path: string[] = []): IdField[] {
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown[]; items?: { properties?: unknown } };
  if (s.anyOf) return s.anyOf.flatMap((b) => idFields(b, path));
  if (s.items?.properties && idFields(s.items, path).length) throw new Error(`${path.join('.')}: ids inside a list of objects; teach idFields to reach them`);
  return Object.entries(s.properties ?? {}).flatMap(([key, prop]) => {
    const kind = kindOf(key);
    if (kind && !CATALOGUE_IDS[kind] && !NOT_ROWS.has(kind)) {
      if (!ORG_IDS[kind]) throw new Error(`input field "${key}" names ids of kind "${kind}": add it to ORG_IDS`);
      return [{ path: [...path, key], kind, many: key.endsWith('Ids'), optional: !s.required?.includes(key) }];
    }
    return idFields(prop, [...path, key]);
  });
}

const unique = (fields: IdField[]) => [...new Map(fields.map((f) => [f.path.join('.'), f])).values()];

/** A copy of `v` with `value` at `path` (undefined removes it). */
function setPath(v: unknown, path: string[], value: unknown): unknown {
  const [key, ...rest] = path;
  const obj = { ...((v ?? {}) as Record<string, unknown>) };
  if (rest.length) obj[key!] = setPath(obj[key!], rest, value);
  else if (value === undefined) delete obj[key!];
  else obj[key!] = value;
  return obj;
}
const getPath = (v: unknown, path: string[]): unknown => path.reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], v);

/** The value of an id field naming `o`'s row: a list names it once. */
const own = (f: IdField, o: SeededOrg) => (f.many ? [ORG_IDS[f.kind]!(o)] : ORG_IDS[f.kind]!(o));

/** `example` with every id field it has naming org B's own rows. */
function withOwnIds(tool: AnyTool, fields: IdField[], b: SeededOrg): unknown {
  let input: unknown = tool.example;
  for (const f of fields) if (getPath(input, f.path) != null) input = setPath(input, f.path, own(f, b));
  return input;
}

/**
 * An input naming org A's row in `field` and org B's own rows everywhere else, valid for the tool:
 * the example (B's ids), with the field and every other optional id field filled; failing that,
 * with only this field added; failing that, without the other optional id fields (a branch).
 */
function oneForeignId(tool: AnyTool, fields: IdField[], field: IdField, s: Seeded): unknown {
  const a = s.a;
  const foreign = field.many ? [ORG_IDS[field.kind]!(s.b), ORG_IDS[field.kind]!(a)] : ORG_IDS[field.kind]!(a);
  const base = withOwnIds(tool, fields, s.b);
  const others = fields.filter((f) => f !== field && f.optional);
  const candidates = [
    others.reduce((v, f) => (getPath(v, f.path) == null ? setPath(v, f.path, own(f, s.b)) : v), base),
    base,
    others.reduce((v, f) => setPath(v, f.path, undefined), base),
  ].map((v) => setPath(v, field.path, foreign));
  const valid = candidates.find((c) => tool.input.safeParse(c).success);
  if (!valid) throw new Error(`${tool.name}: no valid input names org A's ${field.path.join('.')}; give the tool an example that reaches it`);
  return valid;
}

/**
 * Fields whose tool ignores an id it does not find, as its description says, the same for org A's
 * row as for one that does not exist: the call works on org B's rows and says nothing of A's.
 */
const IGNORES_UNKNOWN = new Set(['remove_group_members.screenIds']);

/**
 * Tools that list what org B's own calls were given, which this test fills with org A's ids: the
 * audit log. Each must list exactly org B's own rows instead.
 */
const LISTS_CALLS: Record<string, (out: unknown) => unknown> = {
  list_audit_log: (out) => (out as { entries: { at: number; action: string; actor: { id: string } }[] }).entries.map((e) => [e.at, e.action, e.actor.id]),
};

/** Fields whose foreign id is refused by the check of another field, which the tool makes first. */
const REFUSED_BY_ANOTHER = new Set([
  // The credential is looked up first and must belong to the screen named.
  'revoke_screen_credential.screenId',
]);

/**
 * Fields the tool's one example cannot reach with every other optional id filled, because the
 * spot tools take a flat input whose fields belong to one kind of spot: the input that reaches
 * each, naming org A's row there and org B's own rows elsewhere.
 */
const REACHED_BY: Record<string, (s: Seeded) => unknown> = {
  'create_spot.templateVersionId': (s) => ({ name: 'Menu', kind: 'template', templateVersionId: s.a.templateVersion }),
  'create_spot.assetId': (s) => ({ name: 'Logo', kind: 'image', assetId: s.a.asset }),
  'update_spot.assetId': (s) => ({ spotId: s.b.imageSpot, assetId: s.a.asset }),
  // A provider source takes a resource with its connection, and no feed URL.
  'create_data_source.connectionId': (s) => ({ name: 'Rooms', format: 'provider', connectionId: s.a.connection, resource: 'calendar-1' }),
};

let s: Seeded;
let callerB: Caller;
let before: unknown;

/** Everything of org A's that a tool could change. */
async function orgAState() {
  const a = scoped(env.DB, 'org-a');
  return {
    screens: await a.screens.list(),
    groups: await a.screenGroups.list(),
    members: await a.screenGroups.members(s.a.group),
    credentials: await a.screens.credentials.list(),
    templates: await a.templates.list(),
    templateVersions: await a.templates.versions.list(),
    assets: await a.assets.list(),
    renditions: await a.assets.renditions.list(),
    audit: await a.auditLog.list(),
    brandKits: await a.brandKits.list(),
    brandAssignments: await a.brandKits.assignments.list(),
    dataSources: await a.dataSources.list(),
    connections: await a.connections.list(),
    authorizations: await a.connections.authorizations.list(),
    snapshots: await a.dataSources.snapshots([s.a.dataSource]),
    spots: await a.spots.list(),
  };
}

beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
  for (const o of [s.a, s.b]) {
    await env.BLOBS.put(manifestKey(o.orgId, o.screen, files(o).manifest), '{}');
    await env.BLOBS.put(orgBlobKey(o.orgId, files(o).bundle), '<!doctype html>');
    await env.BLOBS.put(orgBlobKey(o.orgId, files(o).sources), '{}');
  }
  callerB = {
    org: scoped(env.DB, 'org-b'),
    role: 'owner',
    actor: { kind: 'user', id: 'user-b', clientId: 'test' },
    blobs: env.BLOBS,
    uploads: r2Presigner({ endpoint: 'https://r2.test', bucket: 'blobs', accessKeyId: 'k', secretAccessKey: 's' }),
    rateLimit: async () => true,
    feedUrls: { seal: async (_source, url) => `sealed:${url}` },
    connectors,
  };
  // finish_connection's example state, pending for org B's owner.
  await pendingFor('org-b', 'user-b');
  // claim_screen's example code, open to claim.
  await startPairing(env.DB, { code: 'ABC234', pollTokenHash: 'a'.repeat(64), now: Date.now() });
  before = await orgAState();
});

describe("every tool, as org B's owner with one of org A's ids", () => {
  it('covers the whole registry', () => {
    expect(TOOLS.length).toBe(registry.size);
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  it('finds the id fields that are optional or in one branch only', () => {
    const paths = (name: string) =>
      unique(idFields(z.toJSONSchema(registry.get(name)!.input, { io: 'input', unrepresentable: 'any' }))).map((f) => f.path.join('.'));
    expect(paths('assign_brand_kit')).toEqual(['brandKitId', 'screenId', 'groupId']);
    expect(paths('create_brand_kit')).toEqual(['logoOnDarkAssetId', 'logoOnLightAssetId']);
    expect(paths('create_group')).toEqual(['screenIds']);
  });

  for (const tool of TOOLS) {
    const fields = unique(idFields(z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' })));
    if (!fields.length) {
      it(`${tool.name}: names no ids, and works on org B alone`, async () => {
        const result = await dispatch(registry, tool.name, tool.example, callerB);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const calls = LISTS_CALLS[tool.name];
        if (calls && result.ok) {
          const own = await scoped(env.DB, 'org-b').auditLog.list({ limit: 200 });
          expect(calls(result.output)).toEqual(own.map((e) => [e.at, e.action, e.actorId]));
          return;
        }
        // Names and content ids say org-a; server ids (a screen's scr_…) do not, so look for each of org A's ids too.
        const out = JSON.stringify(result);
        expect(out).not.toContain('org-a');
        for (const id of Object.values(s.a).filter((v) => typeof v === 'string')) expect(out, id).not.toContain(id);
      });
    }
    for (const field of fields) {
      it(`${tool.name}: finds nothing of org A in ${field.path.join('.')}`, async () => {
        const name = `${tool.name}.${field.path.join('.')}`;
        const input = REACHED_BY[name]?.(s) ?? oneForeignId(tool, fields, field, s);
        const result = await dispatch(registry, tool.name, input, callerB);
        if (IGNORES_UNKNOWN.has(name)) {
          expect(result.ok, JSON.stringify(result)).toBe(true);
          expect(JSON.stringify(result)).not.toContain(ORG_IDS[field.kind]!(s.a));
        } else {
          // Refused for org A's id, not for another field.
          const named = REFUSED_BY_ANOTHER.has(name) ? expect.any(String) : expect.stringContaining(ORG_IDS[field.kind]!(s.a));
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: 'not_found', message: named });
        }
      });
    }
  }

  it("leaves org A's data and audit log as they were", async () => {
    expect(await orgAState()).toEqual(before);
  });
});
