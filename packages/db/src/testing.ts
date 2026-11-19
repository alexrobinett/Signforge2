/**
 * Test helpers: `@signforge/db/testing`. Not for production code.
 *
 * `seedTwoOrgs(db)` fills a migrated D1 with two orgs holding one of everything, plus one base
 * template, so an isolation test can call org B's scope with org A's ids and expect nothing.
 */
import { drizzle } from 'drizzle-orm/d1';
import { scoped, type OrgScope } from './scoped';
import { organization, screens, templates, templateVersions } from './schema';

const MANIFEST = (key: string) =>
  JSON.stringify({
    id: key,
    version: '1.0.0',
    name: key,
    fields: { title: { type: 'text', label: 'Title' } },
    duration: { defaultMs: 10_000, minMs: 5_000, maxMs: 30_000 },
    orientations: ['landscape', 'portrait'],
    uses: [],
    background: '#000',
  });

/** Ids of everything seeded for one org. */
export interface SeededOrg {
  orgId: string;
  scope: OrgScope;
  screen: string;
  group: string;
  credential: string;
  asset: string;
  rendition: string;
  template: string;
  templateVersion: string;
  templateSpot: string;
  imageSpot: string;
  playlist: string;
  scheduleEntry: string;
  publish: string;
  dataSource: string;
  /** A connected account, with its sealed credentials stand-in. */
  connection: string;
  auditEntry: string;
  /** A brand kit, the org's default. Its id is the server's. */
  brandKit: string;
  /** Start of the hour the seeded play count is in. */
  hour: number;
}

export interface Seeded {
  a: SeededOrg;
  b: SeededOrg;
  base: { template: string; templateVersion: string };
}

export const SEED_HOUR = Date.UTC(2026, 10, 17, 13);

/** An `organization` row, as Better Auth would write it. Tenant rows reference it. */
export async function seedOrganization(db: D1Database, orgId: string) {
  await drizzle(db).insert(organization).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
}

/**
 * A screen with an id the test chooses, such as a golden manifest's. The repositories never let a
 * caller choose a screen's id (it must be unique across orgs); a test fixture may, written around them.
 */
export async function seedScreen(
  db: D1Database,
  orgId: string,
  screen: { id: string; name: string; timezone: string; orientation: 'landscape' | 'portrait'; locale?: string; displayHours?: unknown },
) {
  const now = Date.now();
  await drizzle(db)
    .insert(screens)
    .values({
      id: screen.id,
      orgId,
      name: screen.name,
      timezone: screen.timezone,
      orientation: screen.orientation,
      locale: screen.locale ?? null,
      displayHoursJson: screen.displayHours ? JSON.stringify(screen.displayHours) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return screen.id;
}

/**
 * Seed one org. Content ids (spots, playlists, schedule entries, data sources) are
 * `<orgId>-<thing>`, so a test failure names whose row leaked; the rest are the server's.
 */
export async function seedOrg(db: D1Database, orgId: string, baseTemplateVersion?: string): Promise<SeededOrg> {
  await seedOrganization(db, orgId);
  const o = scoped(db, orgId);
  const id = (thing: string) => `${orgId}-${thing}`;

  const screen = await o.screens.insert({ id: id('screen'), name: `${orgId} lobby`, timezone: 'Europe/London', orientation: 'landscape' });
  const group = await o.screenGroups.insert({ id: id('group'), name: `${orgId} group` });
  await o.screenGroups.addMember(group.id, screen.id);
  const credential = await o.screens.credentials.insert({ id: id('credential'), screenId: screen.id, secretHash: '0'.repeat(64) });

  const asset = await o.assets.insert({
    id: id('asset'),
    kind: 'image',
    name: 'logo.png',
    sha256: 'a'.repeat(64),
    type: 'image/png',
    size: 1000,
    width: 1920,
    height: 1080,
    status: 'verified',
  });
  const rendition = await o.assets.renditions.insert({
    id: id('rendition'),
    assetId: asset.id,
    orientation: 'landscape',
    sha256: 'b'.repeat(64),
    type: 'image/jpeg',
    size: 900,
    width: 1920,
    height: 1080,
  });

  const template = await o.templates.insert({ id: id('template'), key: 'menu', name: 'Menu' });
  const templateVersion = await o.templates.versions.insert({
    id: id('template-version'),
    templateId: template.id,
    version: '1.0.0',
    manifestJson: MANIFEST('menu'),
    bundleSha256: 'c'.repeat(64),
    status: 'approved',
  });

  const templateSpot = await o.spots.insert({
    id: id('spot-template'),
    name: 'Menu',
    kind: 'template',
    durationMs: 10_000,
    templateVersionId: baseTemplateVersion ?? templateVersion.id,
    dataJson: JSON.stringify({ title: 'Hello' }),
    assetMapJson: '{}',
  });
  const imageSpot = await o.spots.insert({ id: id('spot-image'), name: 'Logo', kind: 'image', durationMs: 8_000, assetId: asset.id, fit: 'cover' });

  const playlist = await o.playlists.insert({ id: id('playlist'), name: 'Main', transitionJson: JSON.stringify({ type: 'cut' }) });
  await o.playlists.setItems(playlist.id, [templateSpot.id, imageSpot.id]);
  const scheduleEntry = await o.scheduleEntries.insert({ id: id('schedule'), playlistId: playlist.id, target: 'group', groupId: group.id, priority: 1 });

  // At revision 0, the org's before any publish moves it: a publish the tests make is the org's first.
  const publish = await o.publishes.insert({ id: id('publish'), status: 'published', actorKind: 'user', actorId: id('user'), revision: 0 });
  await o.publishes.addScreens(publish.id, [{ screenId: screen.id, manifestId: 'd'.repeat(64) }]);

  const dataSource = await o.dataSources.insert({ id: id('source'), name: 'Weather', format: 'json', urlEncrypted: 'enc:xyz', refreshS: 300 });
  await o.dataSources.putSnapshot(dataSource.id, { version: 'v1', fetchedAt: SEED_HOUR, checkedAt: SEED_HOUR, dataJson: '{"t":12}' });
  const connection = await o.connections.insert({
    provider: 'fake',
    account: `facilities@${orgId}.test`,
    scopesJson: '["read"]',
    status: 'active',
    credentialsSealed: 'sealed:grant',
    createdBy: id('user'),
  });

  const auditEntry = await o.auditLog.append({ id: id('audit'), actorKind: 'system', actorId: 'seed', action: 'seed', at: SEED_HOUR });
  const kit = await o.brandKits.insert({
    name: `${orgId} brand`,
    colorsJson: JSON.stringify({ primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' }),
    shape: 'soft',
    displayFontId: 'base/inter',
    logoOnDarkAssetId: asset.id,
  });
  await o.commit((await o.brandKits.assignments.stage.set({ target: 'org' }, kit.id)).writes);
  await o.playCounts.add(screen.id, [{ hour: SEED_HOUR, spotId: templateSpot.id, plays: 3, ms: 30_000 }]);

  return {
    orgId,
    scope: o,
    screen: screen.id,
    group: group.id,
    credential: credential.id,
    asset: asset.id,
    rendition: rendition.id,
    template: template.id,
    templateVersion: templateVersion.id,
    templateSpot: templateSpot.id,
    imageSpot: imageSpot.id,
    playlist: playlist.id,
    scheduleEntry: scheduleEntry.id,
    publish: publish.id,
    dataSource: dataSource.id,
    connection: connection.id,
    auditEntry: auditEntry.id,
    brandKit: kit.id,
    hour: SEED_HOUR,
  };
}

/** A base template (null org) every org can use, with fixed ids. Production code writes base templates through `platform(db)`. */
export async function seedBaseTemplate(db: D1Database) {
  const d = drizzle(db);
  await d.insert(templates).values({ id: 'base-clock', orgId: null, key: 'clock', name: 'Clock' }).onConflictDoNothing().run();
  await d
    .insert(templateVersions)
    .values({
      id: 'base-clock-1',
      orgId: null,
      templateId: 'base-clock',
      version: '1.0.0',
      manifestJson: MANIFEST('clock'),
      bundleSha256: 'e'.repeat(64),
      status: 'approved',
    })
    .onConflictDoNothing()
    .run();
  return { template: 'base-clock', templateVersion: 'base-clock-1' };
}

/** Two orgs, `org-a` and `org-b`, each with one of everything; org B's template spot uses the base template. */
export async function seedTwoOrgs(db: D1Database): Promise<Seeded> {
  const base = await seedBaseTemplate(db);
  return { a: await seedOrg(db, 'org-a'), b: await seedOrg(db, 'org-b', base.templateVersion), base };
}
