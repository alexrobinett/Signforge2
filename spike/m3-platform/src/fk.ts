/**
 * Does D1 enforce foreign keys, including composite (org_id, id) ones, without any PRAGMA from
 * the app? Each attempt reports whether D1 accepted or rejected it.
 */
export async function probeForeignKeys(db: D1Database) {
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return { label, accepted: true };
    } catch (e) {
      return { label, accepted: false, error: String((e as Error).message).slice(0, 160) };
    }
  };
  await db.batch([
    db.prepare('DROP TABLE IF EXISTS fk_spots'),
    db.prepare('DROP TABLE IF EXISTS fk_assets'),
    db.prepare('CREATE TABLE fk_assets (org_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (org_id, id))'),
    db.prepare(
      'CREATE TABLE fk_spots (org_id TEXT NOT NULL, id TEXT NOT NULL, asset_id TEXT, PRIMARY KEY (org_id, id), FOREIGN KEY (org_id, asset_id) REFERENCES fk_assets (org_id, id) ON DELETE RESTRICT)',
    ),
    db.prepare("INSERT INTO fk_assets VALUES ('orgA', 'a1'), ('orgB', 'b1')"),
  ]);
  const pragma = await db.prepare('PRAGMA foreign_keys').first();
  const results = [
    await run('same-org reference', () => db.prepare("INSERT INTO fk_spots VALUES ('orgA', 's1', 'a1')").run()),
    await run('reference to a missing asset', () => db.prepare("INSERT INTO fk_spots VALUES ('orgA', 's2', 'nope')").run()),
    await run("cross-org reference (orgA spot -> orgB's asset id)", () => db.prepare("INSERT INTO fk_spots VALUES ('orgA', 's3', 'b1')").run()),
    await run('delete a referenced asset (RESTRICT)', () => db.prepare("DELETE FROM fk_assets WHERE org_id = 'orgA' AND id = 'a1'").run()),
    await run('batch: bad row rolls back the good one', () =>
      db.batch([db.prepare("INSERT INTO fk_spots VALUES ('orgA', 's4', 'a1')"), db.prepare("INSERT INTO fk_spots VALUES ('orgA', 's5', 'nope')")]),
    ),
  ];
  const s4 = await db.prepare("SELECT count(*) AS n FROM fk_spots WHERE id = 's4'").first<{ n: number }>();
  await db.batch([db.prepare('DROP TABLE fk_spots'), db.prepare('DROP TABLE fk_assets')]);
  return { pragmaForeignKeys: pragma, results, batchGoodRowKept: (s4?.n ?? 0) > 0 };
}
