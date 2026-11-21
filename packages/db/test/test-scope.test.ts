// testScope's direct writes say what D1 did, even when another write lands between the adapter's
// read and its commit: each test runs that other write just before the adapter's batch goes in.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { StaleVersionError } from '../src';
import { seedOrg, testScope } from '../src/testing';

/** `real`, except that `before` runs once, just before the first batch goes to D1. */
function racing(real: D1Database, before: () => Promise<unknown>): D1Database {
  let pending = true;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await before();
          }
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('testScope', () => {
  it('returns the version D1 stored for an update', async () => {
    const o = await seedOrg(env.DB, 'tscope-update');
    const org = testScope(env.DB, o.orgId);
    expect(await org.screens.update(o.screen, { name: 'One' })).toMatchObject({ name: 'One', rowVersion: 2 });
    expect(await org.screens.update(o.screen, { name: 'Two' })).toMatchObject({ name: 'Two', rowVersion: 3 });
    expect(await org.screens.get(o.screen)).toMatchObject({ name: 'Two', rowVersion: 3 });
  });

  it('refuses an update that another change overtook, rather than report a version D1 did not store', async () => {
    const o = await seedOrg(env.DB, 'tscope-race');
    const org = testScope(
      racing(env.DB, () => testScope(env.DB, o.orgId).screens.update(o.screen, { name: 'Theirs' })),
      o.orgId,
    );
    const err = await org.screens.update(o.screen, { name: 'Mine' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: o.screen, version: 2 });
    expect(await org.screens.get(o.screen)).toMatchObject({ name: 'Theirs', rowVersion: 2 });
  });

  it('says a delete deleted only when D1 deleted the row: the second of two deletes of one row is false', async () => {
    const o = await seedOrg(env.DB, 'tscope-delete');
    const org = testScope(
      racing(env.DB, () => testScope(env.DB, o.orgId).assets.renditions.delete(o.rendition)),
      o.orgId,
    );
    expect(await org.assets.renditions.delete(o.rendition)).toBe(false);
    expect(await org.assets.renditions.get(o.rendition)).toBeUndefined();

    const plain = testScope(env.DB, o.orgId);
    expect(await plain.screenGroups.delete(o.group)).toBe(true);
    expect(await plain.screenGroups.delete(o.group)).toBe(false);
  });

  it('changes nothing of a row the org does not own, an empty patch included', async () => {
    const a = await seedOrg(env.DB, 'tscope-own-a');
    const b = testScope(env.DB, (await seedOrg(env.DB, 'tscope-own-b')).orgId);
    expect(await b.screens.update(a.screen, { name: 'x' })).toBeUndefined();
    expect(await b.screens.update(a.screen, {})).toBeUndefined();
    expect(await b.screens.delete(a.screen)).toBe(false);
  });
});
