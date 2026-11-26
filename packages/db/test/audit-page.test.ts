// `auditLog.page`'s `alsoAction` (#345, #507): another action's rows, by what their recorded input has, has not, or has
// one of; a row whose input has a key only nested deeper, or set to null, is not one.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { scoped } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
  const log = scoped(env.DB, s.a.orgId).auditLog;
  for (const [i, input] of [
    { spotId: 'spt_1', name: 'Changed' },
    { name: 'Created', data: { spotId: 'nested' } },
    { spotId: null, name: 'Null id' },
    { timezone: 'UTC' },
    { locale: 'en-GB' },
    { name: 'Renamed only' },
  ].entries())
    await log.append({ at: 1_000 + i, actorKind: 'user', actorId: 'usr_a', clientId: 'cms', action: 'save_x', detailJson: JSON.stringify({ input }) });
});

const names = async (alsoAction: Parameters<ReturnType<typeof scoped>['auditLog']['page']>[0]['alsoAction']) =>
  (await scoped(env.DB, s.a.orgId).auditLog.page({ limit: 50, action: 'old_x', alsoAction })).map((r) => JSON.parse(r.detailJson ?? '{}').input);

describe('auditLog.page with alsoAction', () => {
  it('finds rows whose input has a key, at the top of the input only and not null', async () => {
    expect(await names({ actions: ['save_x'], inputHas: { spotId: true } })).toEqual([{ spotId: 'spt_1', name: 'Changed' }]);
  });

  it('finds rows whose input lacks a key: a nested one or a null one counts as lacking', async () => {
    const lacking = await names({ actions: ['save_x'], inputHas: { spotId: false } });
    expect(lacking).toContainEqual({ name: 'Created', data: { spotId: 'nested' } });
    expect(lacking).toContainEqual({ spotId: null, name: 'Null id' });
    expect(lacking).not.toContainEqual({ spotId: 'spt_1', name: 'Changed' });
  });

  it('finds rows whose input has any of the keys', async () => {
    expect(await names({ actions: ['save_x'], inputHasAny: ['timezone', 'locale'] })).toEqual([{ locale: 'en-GB' }, { timezone: 'UTC' }]);
  });

  it("finds none of another org's rows", async () => {
    expect(
      (await scoped(env.DB, s.b.orgId).auditLog.page({ limit: 50, action: 'old_x', alsoAction: { actions: ['save_x'], inputHasAny: ['timezone'] } })).length,
    ).toBe(0);
  });
});
