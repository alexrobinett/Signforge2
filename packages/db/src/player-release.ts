/**
 * A player release's row (#628), and the SQL the release workflows run on D1 (`.github/workflows/player-release.yml`,
 * `player-promote.yml`). CI holds a D1 token, not the Worker's binding, so it writes with `wrangler d1 execute`; the
 * SQL is written here, beside `platform(db).playerReleases`, so this package stays the only one that touches its
 * tables, and `test/device.test.ts` runs it on D1 and reads it back through `platform`. No import here needs a Worker,
 * so the workflows' script (packages/cli/src/player-release.ts) loads it in Node.
 */
import { MAX_RELEASE_MANIFEST_BYTES, parsePlayerReleaseManifest, RELEASE_SIGNATURE, type PlayerChannel } from '@signforge/contract';
import type * as s from './schema';

export type PlayerRelease = typeof s.playerReleases.$inferSelect;

/**
 * A release's row as CI made it: its manifest text exactly as signed, and the signature. `version`, `sha256` and `size`
 * come from that text, never from the caller, so the row cannot say other than what a device verifies. Refused
 * (`Error`, with every problem) for text past `MAX_RELEASE_MANIFEST_BYTES`, a manifest the contract does not read, or a
 * signature not in `RELEASE_SIGNATURE`'s form. The signature itself is the device's to check.
 */
export function releaseRow(manifest: string, signature: string, channel: PlayerChannel, now: number): PlayerRelease {
  const problems: string[] = [];
  if (new TextEncoder().encode(manifest).byteLength > MAX_RELEASE_MANIFEST_BYTES) problems.push('the manifest text is too long');
  if (!RELEASE_SIGNATURE.test(signature)) problems.push('the signature is not an Ed25519 signature in base64');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    problems.push('the manifest text is not JSON');
  }
  const read = problems.length ? undefined : parsePlayerReleaseManifest(parsed);
  if (read && !read.ok) problems.push(...read.problems);
  if (!read?.ok) throw new Error(`not a player release: ${problems.join('; ')}`);
  const { version, sha256, size } = read.value;
  return { version, sha256, size, manifest, signature, channel, createdAt: now, promotedAt: null };
}

/** The build number the next release takes: one above the newest registered on either channel. Its one column is `next`. */
export const NEXT_RELEASE_SQL = 'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM player_releases';

/**
 * `platform(db).playerReleases.register` as one statement: the same `releaseRow`, on `canary`. The manifest goes in as
 * hex and is cast back to text, so its bytes reach the row exactly and no character in it can end the literal; every
 * other value is a number or text the contract allows only digits, hex or base64 in.
 */
export function registerReleaseSql(manifest: string, signature: string, now: number): string {
  const r = releaseRow(manifest, signature, 'canary', now);
  const hex = Array.from(new TextEncoder().encode(r.manifest), (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    'INSERT INTO player_releases (version, sha256, size, manifest, signature, channel, created_at) ' +
    `VALUES (${r.version}, '${r.sha256}', ${r.size}, CAST(X'${hex}' AS TEXT), '${r.signature}', 'canary', ${now})`
  );
}

/**
 * Every canary screen, in every org, with what its last heartbeat said of releases: the release it runs, since when
 * (ms), the ones it rolled back (JSON, newest first), and when it was last seen (ms). `player-promote` shows it before
 * a release goes to every other screen. By id, not name: the repository is public, and so are its workflow runs.
 */
export const CANARY_SCREENS_SQL =
  'SELECT id, last_seen_at AS lastSeenAt, ' +
  "json_extract(heartbeat_json, '$.player.release') AS release, " +
  "json_extract(heartbeat_json, '$.releaseSince') AS releaseSince, " +
  "CASE WHEN json_type(heartbeat_json, '$.failedReleases') = 'array' THEN json_extract(heartbeat_json, '$.failedReleases') END AS failedReleases " +
  "FROM screens WHERE player_channel = 'canary' ORDER BY id";

/** Moves a canary release to `stable`, returning its version; no row when there is no such release on `canary`. */
export const promoteReleaseSql = (version: number, now: number) =>
  `UPDATE player_releases SET channel = 'stable', promoted_at = ${now} WHERE version = ${version} AND channel = 'canary' RETURNING version`;
