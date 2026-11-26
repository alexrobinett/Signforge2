// What a read by ids costs (#345, review of #478; the Free plan: 50 D1 queries an invocation): read runs a type's get
// once an id, so each type caps its ids (`maxIds`) for one call to stay within 40 statements, a drawer turn's own
// budget. Measured at the cap through the API, as an owner and as an editor (whose role check reads the settings too),
// the same id read again costing what another would, and a screen at its costliest: one that fell back from a manifest.
import { READ_TYPES, type ScreenHeartbeat } from '@signforge/tools';
import { seedOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Client, email, testApp } from './client';
import { as, measure } from './counting';

it('reads at most maxIds of each type by ids within 40 statements and under 50 queries', async () => {
  const t = testApp();
  const owner = new Client(t);
  await owner.signIn(email('read-cost'));
  const org = await owner.createOrg('Read Cost');
  const o = await seedOrg(env.DB, org.id);
  // A screen that fell back from a manifest: get_screen reads the publish that sent it, its eighth statement.
  const heartbeat: ScreenHeartbeat = {
    at: Date.now(),
    player: { version: '1.2.3', manifestSchemas: [2], protocols: [1, 2] },
    manifest: { active: 'a'.repeat(64), filesMissing: 0, fallbackFrom: 'e'.repeat(64) },
    display: { on: true },
    clock: { offsetMs: 0, trusted: true },
    driftMs: 0,
    dataRejected: {},
  };
  await testScope(env.DB, org.id).screens.update(o.screen, { heartbeatJson: JSON.stringify(heartbeat) });
  const editor = new Client(t);
  await editor.signIn(email('read-cost-editor'));
  const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', {
    email: (await editor.session()).body.user.email,
    role: 'editor',
    organizationId: org.id,
  });
  await editor.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
  await editor.setActive(org.id);
  const ids: Record<string, string> = {
    screen: o.screen,
    publish: o.publish,
    publish_request: o.publishRequest,
    template: o.template,
    asset: o.asset,
    brand_kit: o.brandKit,
    data_source: o.dataSource,
    spot: o.templateSpot,
    playlist: o.playlist,
  };
  const types = Object.entries(READ_TYPES).flatMap(([type, def]) => ('get' in def ? [{ type, maxIds: def.get.maxIds }] : []));
  expect(types.map((x) => x.type).sort()).toEqual(Object.keys(ids).sort());
  const costs: Record<string, string> = {};
  for (const [role, who] of [
    ['owner', owner],
    ['editor', editor],
  ] as const)
    for (const { type, maxIds } of types) {
      const id = ids[type] ?? '';
      const cost = await measure((b) => as(who, b).ok('/api/tools/read', { type, ids: Array(maxIds).fill(id) }));
      expect(cost.statements, `${role} ${type}`).toBeLessThanOrEqual(40);
      expect(cost.queries, `${role} ${type}`).toBeLessThan(50);
      costs[`${role} ${type}`] = `${maxIds} ids: ${cost.queries} queries`;
    }
  // Measured, as the most each may take: a new statement fails this on purpose. Look at the cap, then raise it.
  expect(costs).toEqual({
    'editor asset': '12 ids: 39 queries',
    'editor brand_kit': '9 ids: 14 queries',
    'editor data_source': '18 ids: 39 queries',
    'editor playlist': '12 ids: 39 queries',
    'editor publish': '7 ids: 38 queries',
    'editor publish_request': '12 ids: 39 queries',
    'editor screen': '4 ids: 32 queries',
    'editor spot': '30 ids: 33 queries',
    'editor template': '18 ids: 39 queries',
    'owner asset': '12 ids: 38 queries',
    'owner brand_kit': '9 ids: 13 queries',
    'owner data_source': '18 ids: 38 queries',
    'owner playlist': '12 ids: 38 queries',
    'owner publish': '7 ids: 37 queries',
    'owner publish_request': '12 ids: 38 queries',
    'owner screen': '4 ids: 31 queries',
    'owner spot': '30 ids: 32 queries',
    'owner template': '18 ids: 38 queries',
  });
});

it('costs no more by ids when a group chose a kit, and pins what smart groups made dearer (#186, review of #608)', async () => {
  const t = testApp();
  const owner = new Client(t);
  await owner.signIn(email('read-cost-groups'));
  const org = await owner.createOrg('Read Cost Groups');
  const o = await seedOrg(env.DB, org.id);
  const scope = testScope(env.DB, org.id);
  await scope.commit((await scope.screens.labels.stage.update([o.screen], { set: { store: 'harbor' }, remove: [] })).writes);
  const smart = await scope.screenGroups.insert({ name: 'Harbor', selectorJson: JSON.stringify({ all: [{ key: 'store', op: 'eq', values: ['harbor'] }] }) });
  await owner.ok('/api/tools/assign_brand_kit', { brandKitId: o.brandKit, target: 'group', groupId: smart.id });
  const cost = async (path: string, input: unknown) => (await measure((b) => as(owner, b).ok(path, input))).queries;
  const costs = {
    readKits: await cost('/api/tools/read', { type: 'brand_kit', ids: Array(9).fill(o.brandKit) }),
    listKits: await cost('/api/tools/list_brand_kits', {}),
    assign: await cost('/api/tools/assign_brand_kit', { brandKitId: o.brandKit, target: 'group', groupId: smart.id }),
    saveRule: await cost('/api/tools/save_group', { name: 'North', selector: { all: [{ key: 'store', op: 'exists' }] }, idempotencyKey: crypto.randomUUID() }),
    saveList: await cost('/api/tools/save_group', { name: 'List', screenIds: [o.screen], idempotencyKey: crypto.randomUUID() }),
  };
  expect(costs.readKits).toBeLessThan(50);
  // Measured, as the most each may take: a new statement fails this on purpose.
  expect(costs).toEqual({ readKits: 15, listKits: 7, assign: 11, saveRule: 7, saveList: 5 });
});

it('previews a publish within a request’s budget, reading the last publish’s record of whom its groups reached (#187)', async () => {
  const t = testApp();
  const owner = new Client(t);
  await owner.signIn(email('read-cost-preview'));
  const org = await owner.createOrg('Read Cost Preview');
  const o = await seedOrg(env.DB, org.id);
  await owner.ok('/api/tools/set_default_playlist', { playlistId: o.playlist });
  await owner.ok('/api/tools/publish', {});
  const cost = await measure((b) => as(owner, b).ok('/api/tools/preview_publish', {}));
  expect(cost.queries).toBeLessThan(50);
  // Measured, as the most it may take: a new statement fails this on purpose.
  expect(cost).toEqual({ statements: 17, queries: 17, rpcs: [] });
});
