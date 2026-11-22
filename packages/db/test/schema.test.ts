// The plan's schema rules, checked against the migrated database, so a later migration that
// breaks one fails here. See docs/backend-plan.md#data-model-d1.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** Tables whose rows exist before or outside any org: pairing codes, the platform audit log and Better Auth's own. */
const AUTH_TABLES = ['account', 'invitation', 'member', 'organization', 'rateLimit', 'session', 'user', 'verification'];
const NOT_TENANT = new Set(['pairing_codes', 'platform_audit_log', ...AUTH_TABLES]);
/** Tables where a null org means a base row shared by every org. */
const NULLABLE_ORG = new Set(['templates', 'template_versions']);
/** Indexes that deliberately do not lead with org_id. The due deliveries are found across orgs, from pending rows only. */
const INDEX_EXCEPTIONS = new Set(['templates_base_key_uq', 'template_versions_base_version_uq', 'alert_deliveries_due_idx']);
/** Foreign keys that deliberately do not include org_id. */
const FK_EXCEPTIONS = new Set(['spots.template_version_id']);

const all = async <T>(sql: string) => (await env.DB.prepare(sql).all<T>()).results;

async function tables() {
  const rows = await all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
  );
  return rows.map((r) => r.name).filter((n) => !NOT_TENANT.has(n));
}

describe('schema', () => {
  it("has Better Auth's tables", async () => {
    const names = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
    for (const t of AUTH_TABLES) expect(names, t).toContain(t);
  });

  it('has the tables in the plan', async () => {
    expect(await tables()).toEqual([
      'alert_channels',
      'alert_deliveries',
      'asset_renditions',
      'assets',
      'audit_log',
      'brand_assignments',
      'brand_kits',
      'connection_authorizations',
      'connections',
      'data_snapshots',
      'data_sources',
      'draft_tombstones',
      'feed_image_deletes',
      'feed_images',
      'idempotency_keys',
      'org_settings',
      'play_counts',
      'playlist_items',
      'playlists',
      'publish_screens',
      'publishes',
      'schedule_entries',
      'screen_credentials',
      'screen_group_members',
      'screen_groups',
      'screen_incidents',
      'screen_labels',
      'screens',
      'spots',
      'sync_epochs',
      'template_versions',
      'templates',
    ]);
  });

  it('gives every tenant table org_id NOT NULL', async () => {
    for (const t of await tables()) {
      const col = (await all<{ name: string; notnull: number }>(`PRAGMA table_info(${t})`)).find((c) => c.name === 'org_id');
      expect(col, t).toBeDefined();
      if (!NULLABLE_ORG.has(t)) expect(col!.notnull, t).toBe(1);
    }
  });

  it('leads every index with org_id, and makes (org_id, id) unique', async () => {
    for (const t of await tables()) {
      const indexes = await all<{ name: string; unique: number; origin: string }>(`PRAGMA index_list(${t})`);
      const columns = async (i: string) => (await all<{ name: string }>(`PRAGMA index_info('${i}')`)).map((c) => c.name);
      let orgIdUnique = false;
      for (const i of indexes) {
        const cols = await columns(i.name);
        // The single-column primary key on `id` is the global lookup; everything else leads with org_id.
        if (i.origin === 'pk' && cols.length === 1 && cols[0] === 'id') continue;
        if (INDEX_EXCEPTIONS.has(i.name)) continue;
        expect(cols[0], `${t}.${i.name} (${cols.join(', ')})`).toBe('org_id');
        if (i.unique && cols.join() === 'org_id,id') orgIdUnique = true;
      }
      const hasId = (await all<{ name: string }>(`PRAGMA table_info(${t})`)).some((c) => c.name === 'id');
      if (hasId) expect(orgIdUnique, `${t} needs a unique (org_id, id)`).toBe(true);
    }
  });

  it('makes every foreign key between tenant rows composite on org_id', async () => {
    for (const t of await tables()) {
      const fks = await all<{ id: number; table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${t})`);
      const byId = Map.groupBy(fks, (f) => f.id);
      for (const parts of byId.values()) {
        const from = parts.map((p) => p.from);
        if (FK_EXCEPTIONS.has(`${t}.${from.join()}`)) continue;
        if (parts[0]!.table === 'organization') continue;
        expect(parts.find((p) => p.from === 'org_id')?.to, `${t}(${from.join()}) -> ${parts[0]!.table}`).toBe('org_id');
      }
    }
  });

  it("references the organization from every tenant table's org_id", async () => {
    for (const t of await tables()) {
      const fks = await all<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${t})`);
      expect(fks.find((f) => f.from === 'org_id' && f.table === 'organization')?.to, t).toBe('id');
    }
  });

  it('runs with foreign keys enforced locally', async () => {
    expect(await all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });
});
