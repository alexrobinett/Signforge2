// Single-row versioned records (the org's settings, an alert channel): one upsert and one batch
// guard serve both, so each is checked on both sides of a version conflict.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type OrgScope, scoped, StaleVersionError } from '../src';
import { seedOrg } from '../src/testing';

interface VersionedRecord {
  name: string;
  /** The id a refusal names. */
  id: string;
  /** The version of a record with no row. */
  absent: number;
  /** Stage a change setting the record's one text field to `value`. */
  put: (org: OrgScope, value: string, ifVersion?: number) => Promise<{ writes: Parameters<OrgScope['commit']>[0] }>;
  /** The record's version and that field, as stored. */
  read: (org: OrgScope) => Promise<{ rowVersion: number; value: string | null } | undefined>;
}

const records: VersionedRecord[] = [
  {
    name: 'org settings',
    id: 'settings',
    absent: 1,
    put: (org, value, ifVersion) => org.settings.stage.set({ locale: value }, ifVersion),
    read: async (org) => {
      const r = await org.settings.get();
      return r && { rowVersion: r.rowVersion, value: r.locale };
    },
  },
  {
    name: 'an alert channel',
    id: 'slack channel',
    absent: 0,
    put: (org, value, ifVersion) =>
      org.alertChannels.stage.put('slack', { host: value, urlEncrypted: 'sealed:url', secretEncrypted: null, secretSetAt: null, connectedBy: 'u' }, ifVersion),
    read: async (org) => {
      const r = await org.alertChannels.get('slack');
      return r && { rowVersion: r.rowVersion, value: r.host };
    },
  },
];

describe.each(records)('$name', (record) => {
  const fresh = async (tag: string) => scoped(env.DB, (await seedOrg(env.DB, `vrec-${record.absent}-${tag}`)).orgId);

  it('is at its absent version with no row, and the first change made from it makes the row one above', async () => {
    const org = await fresh('first');
    expect(await record.read(org)).toBeUndefined();
    await org.commit((await record.put(org, 'one', record.absent)).writes);
    expect(await record.read(org)).toEqual({ rowVersion: record.absent + 1, value: 'one' });
  });

  it('commits a change made from the version stored, and moves the version on', async () => {
    const org = await fresh('ok');
    await org.commit((await record.put(org, 'one')).writes);
    await org.commit((await record.put(org, 'two', record.absent + 1)).writes);
    expect(await record.read(org)).toEqual({ rowVersion: record.absent + 2, value: 'two' });
  });

  it('refuses at once a change made from a version that is not the one stored', async () => {
    const org = await fresh('old');
    await org.commit((await record.put(org, 'one')).writes);
    const err = await record.put(org, 'late', record.absent).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: record.id, version: record.absent + 1 });
  });

  it('refuses in the batch a change whose record moved on after it was read, writing nothing of the batch', async () => {
    const org = await fresh('race');
    // Two changes made from the same read; the one committed second loses.
    const mine = await record.put(org, 'mine', record.absent);
    await org.commit((await record.put(org, 'theirs', record.absent)).writes);
    const audit = org.auditLog.stage({ actorKind: 'user', actorId: 'u', action: 'vrec_race' });

    const err = await org.commit([...mine.writes, ...audit.writes]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: record.id, version: record.absent + 1 });
    expect(await record.read(org)).toEqual({ rowVersion: record.absent + 1, value: 'theirs' });
    expect((await org.auditLog.list()).filter((a) => a.action === 'vrec_race')).toEqual([]);
  });

  it('without a version to check, a later change wins', async () => {
    const org = await fresh('unguarded');
    const first = await record.put(org, 'first');
    const second = await record.put(org, 'second');
    await org.commit(second.writes);
    await org.commit(first.writes);
    expect(await record.read(org)).toEqual({ rowVersion: record.absent + 2, value: 'first' });
  });
});
