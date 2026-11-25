/**
 * The daily storage sweep (#235): what each org stores in R2 that nothing needs any more, past the 90-day grace period.
 * What the org keeps, and why a file may go, is decided in packages/db `storage.ts`; this is the run that deletes.
 *
 * Per org, the least recently swept first: take the org's lease with an owner token; index from R2 any manifest the org
 * keeps that is not indexed yet (one stored before the index, or one a screen reports); claim what is due (files only
 * while every kept manifest's files are known, checked in the claim itself); delete those objects while the lease still holds; then, in one batch held to the lease,
 * forget its own claims, delete the uploads still pending, audit the run and let the lease go. Every key it deletes is
 * built here under the org's own prefixes (`orgBlobKey`, `uploadKey`, from the org being swept): a row's hash or id fills
 * in only what follows, and R2 keys are flat strings, so a sweep reaches no other org's objects and none outside them.
 * Manifests are read, never deleted. A run that fails part-way leaves its rows and its claims, which expire with the
 * lease, and the next run takes them up: deleting an object twice is harmless.
 *
 * Bounded for Free D1's 50 queries and 50 subrequests an invocation: ORGS_PER_RUN orgs, each at most seven D1 queries
 * (the lease, the unindexed manifests, the index written, the claim's batch, the pending uploads, their renditions, the
 * last batch) and at most INDEX_PER_ORG manifest reads and one R2 delete.
 */
import { nothingDue, orgsWithStorageDue, scoped, STORAGE_LEASE_MS } from '@signforge/db';
import { manifestKey, orgBlobKey, uploadKey } from '@signforge/tools';

/** Orgs one run sweeps: the rest, the least recently swept first, the next day. */
export const ORGS_PER_RUN = 5;
/** Of each kind (files, uploads), the most one org's sweep claims. */
const DUE_PER_ORG = 90;
/** Manifests one org's sweep reads from R2 to index. */
export const INDEX_PER_ORG = 4;
/** Objects are deleted only while at least this much of the lease is left: a lease that ran out may have let a writer in. */
const LEASE_MARGIN_MS = 60_000;

/** The R2 the sweep reads manifests from and deletes from: R2 in production. */
export interface SweptBlobs {
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
  delete(keys: string[]): Promise<void>;
}

/** Sweeps up to ORGS_PER_RUN orgs, by `clock` (the run's start for what is due, the time now for the lease). Returns how many objects it deleted. */
export async function sweepStorage(db: D1Database, blobs: SweptBlobs, clock: () => number): Promise<number> {
  const now = clock();
  let deleted = 0;
  const errors: unknown[] = [];
  for (const orgId of await orgsWithStorageDue(db, now, ORGS_PER_RUN)) {
    try {
      deleted += await sweepOrg(db, blobs, clock, orgId);
    } catch (err) {
      // One org's failure stops no other's; its claims expire with its lease, and it is swept again.
      errors.push(err);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'storage sweep failed');
  return deleted;
}

async function sweepOrg(db: D1Database, blobs: SweptBlobs, clock: () => number, orgId: string): Promise<number> {
  const org = scoped(db, orgId);
  const owner = crypto.randomUUID();
  const now = clock();
  if (!(await org.storage.lease(owner, now))) return 0;
  // The manifests the org keeps that the index does not hold yet: read and indexed, a few a run.
  const unindexed = await org.storage.unindexed(now, INDEX_PER_ORG);
  const indexed = await Promise.all(
    unindexed.map(async (m) => {
      const object = await blobs.get(manifestKey(orgId, m.screenId, m.manifestId));
      // One not stored for that screen is unknown, never empty: a screen may report any id (review of #429, round 2).
      return {
        screenId: m.screenId,
        id: m.manifestId,
        files: object ? Object.keys((await object.json<{ files?: Record<string, unknown> }>()).files ?? {}) : null,
      };
    }),
  );
  if (indexed.length) await org.commit(org.storage.stage.index(indexed, now).writes);
  // Files only if every kept manifest's files are known as the claim runs: the rest are indexed on later runs.
  const due = await org.storage.claim(owner, now, DUE_PER_ORG);
  if (nothingDue(due)) {
    await org.commit(org.storage.stage.release(owner, now).writes);
    return 0;
  }
  const keys = [...due.files.map((sha) => orgBlobKey(orgId, sha)), ...due.uploads.flatMap((u) => u.files.map((sha) => uploadKey(orgId, u.assetId, sha)))];
  // Deleted only while the lease holds: past it, a writer may have taken the bytes up again. The claims then expire unforgotten.
  if (clock() > now + STORAGE_LEASE_MS - LEASE_MARGIN_MS) return 0;
  for (let i = 0; i < keys.length; i += 1000) await blobs.delete(keys.slice(i, i + 1000));
  await org.commit(org.storage.stage.forget(due, owner, clock()).writes);
  return keys.length;
}
