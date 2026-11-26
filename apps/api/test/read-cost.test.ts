// What a read by ids costs (#345, review of #478; the Free plan: 50 D1 queries an invocation): read runs a type's get
// once an id, so each type caps its ids (`maxIds`) for one call to stay within 40 statements, a drawer turn's own
// budget. Measured at the cap, as an owner through the API, the same id read again costing what another would.
import { READ_TYPES } from '@signforge/tools';
import { seedOrg } from '@signforge/db/testing';
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
  for (const { type, maxIds } of types) {
    const id = ids[type] ?? '';
    const cost = await measure((b) => as(owner, b).ok('/api/tools/read', { type, ids: Array(maxIds).fill(id) }));
    expect(cost.statements, type).toBeLessThanOrEqual(40);
    expect(cost.queries, type).toBeLessThan(50);
    costs[type] = `${maxIds} ids: ${cost.queries} queries`;
  }
  // Measured, as the most each may take: a new statement fails this on purpose. Look at the cap, then raise it.
  expect(costs).toEqual({
    asset: '12 ids: 38 queries',
    brand_kit: '9 ids: 38 queries',
    data_source: '18 ids: 38 queries',
    playlist: '12 ids: 38 queries',
    publish: '7 ids: 37 queries',
    publish_request: '12 ids: 38 queries',
    screen: '5 ids: 37 queries',
    spot: '30 ids: 32 queries',
    template: '18 ids: 38 queries',
  });
});
