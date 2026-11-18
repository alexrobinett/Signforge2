// Generated from the registry: every tool, called as org B's owner with org A's ids, finds
// nothing and changes nothing. A new tool is covered as soon as it is registered; a new kind of
// id field fails here until it is mapped to one of org A's rows below.
import { scoped, startPairing } from '@signforge/db';
import { seedTwoOrgs, type Seeded, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, manifestKey, orgBlobKey, r2Presigner, registry, TOOLS, type Caller } from '../src';

const MANIFEST = 'a'.repeat(64);
/** Org A's uploaded template bundle and sources. */
const BUNDLE = 'b'.repeat(64);
const SOURCES = 'c'.repeat(64);

/** Org A's row for each kind of id a tool input can name (`screenId` → `screen`). */
const ORG_A_IDS: Record<string, (a: SeededOrg) => string> = {
  screen: (a) => a.screen,
  group: (a) => a.group,
  credential: (a) => a.credential,
  manifest: () => MANIFEST,
  template: (a) => a.template,
  templateVersion: (a) => a.templateVersion,
  bundle: () => BUNDLE,
  sources: () => SOURCES,
  asset: (a) => a.asset,
  brandKit: (a) => a.brandKit,
  logoOnDarkAsset: (a) => a.asset,
  logoOnLightAsset: (a) => a.asset,
  dataSource: (a) => a.dataSource,
};

/** Ids that name a catalogue every org shares, not an org's row. */
const CATALOGUE_IDS: Record<string, string> = { displayFont: 'base/oswald', bodyFont: 'base/inter' };

/** `example` with every id field replaced by org A's id of that kind. Also says whether it named any. */
function withOrgAIds(example: unknown, a: SeededOrg): { input: unknown; ids: number } {
  let ids = 0;
  const pick = (key: string, kind: string) => {
    // Font ids name the shared catalogue, not an org's row: any org may use them.
    if (CATALOGUE_IDS[kind]) return CATALOGUE_IDS[kind];
    const get = ORG_A_IDS[kind];
    if (!get) throw new Error(`input field "${key}" names ids of kind "${kind}": add it to ORG_A_IDS`);
    ids++;
    return get(a);
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => {
        if (k.endsWith('Ids') && Array.isArray(val)) return [k, val.map(() => pick(k, k.slice(0, -3)))];
        if (k.endsWith('Id') && typeof val === 'string') return [k, pick(k, k.slice(0, -2))];
        return [k, walk(val)];
      }),
    );
  };
  return { input: walk(example), ids };
}

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
    snapshots: await a.dataSources.snapshots([s.a.dataSource]),
  };
}

beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
  await env.BLOBS.put(manifestKey('org-a', s.a.screen, MANIFEST), '{}');
  await env.BLOBS.put(orgBlobKey('org-a', BUNDLE), '<!doctype html>');
  await env.BLOBS.put(orgBlobKey('org-a', SOURCES), '{}');
  callerB = {
    org: scoped(env.DB, 'org-b'),
    role: 'owner',
    actor: { kind: 'user', id: 'user-b', clientId: 'test' },
    blobs: env.BLOBS,
    uploads: r2Presigner({ endpoint: 'https://r2.test', bucket: 'blobs', accessKeyId: 'k', secretAccessKey: 's' }),
    rateLimit: async () => true,
    feedUrls: { seal: async (_source, url) => `sealed:${url}` },
  };
  // claim_screen's example code, open to claim.
  await startPairing(env.DB, { code: 'ABC234', pollTokenHash: 'a'.repeat(64), now: Date.now() });
  before = await orgAState();
});

describe("every tool, as org B's owner with org A's ids", () => {
  it('covers the whole registry', () => {
    expect(TOOLS.length).toBe(registry.size);
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  for (const tool of TOOLS) {
    it(`${tool.name}: finds nothing of org A`, async () => {
      const { input, ids } = withOrgAIds(tool.example, s.a);
      const result = await dispatch(registry, tool.name, input, callerB);
      if (ids > 0) {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, error: 'not_found' });
      } else {
        // No ids to aim with (a list, a create with nothing to link): it works, on org B alone.
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(JSON.stringify(result)).not.toContain('org-a');
      }
    });
  }

  it("leaves org A's data and audit log as they were", async () => {
    expect(await orgAState()).toEqual(before);
  });
});
