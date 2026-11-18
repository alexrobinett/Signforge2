/**
 * Pairing (docs/backend-plan.md#screens). A code exists before any org claims it, so `pairing_codes`
 * is not a tenant table, and the screen reaches its row by poll token alone. These are the narrow
 * functions that need: start a code, and collect the credential once the code is claimed. The
 * claim itself is the org's (`scoped(db, orgId).pairing`, `./scoped.ts`).
 *
 * Collecting writes the screen's credential through `scoped(db, org)`, where the org is the one
 * the claim stored on the code, never one the screen names.
 */
import type { ScreenKind } from '@signforge/contract';
import { newId } from './ids';
import { scoped } from './scoped';

/** How long a code can be claimed. */
export const PAIRING_TTL_MS = 15 * 60_000;
/** How long a claimed code waits to be collected before the next start sweeps it. */
const CLAIMED_KEEP_MS = 24 * 3_600_000;

export type PairingCollected = { status: 'waiting' } | { status: 'expired' } | { status: 'paired'; screenId: string; credential: string };

/**
 * Store a new code. Returns false if the code is already in use (pick another). Codes whose time is
 * up are swept first, in the same batch: an unclaimed one at expiry, a claimed one after a day.
 */
export async function startPairing(d1: D1Database, v: { code: string; pollTokenHash: string; kind?: ScreenKind; now: number }): Promise<boolean> {
  try {
    await d1.batch([
      d1.prepare('DELETE FROM pairing_codes WHERE (claimed_at IS NULL AND expires_at <= ?1) OR claimed_at <= ?2').bind(v.now, v.now - CLAIMED_KEEP_MS),
      d1
        .prepare('INSERT INTO pairing_codes (id, code, poll_token_hash, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(newId('pair'), v.code, v.pollTokenHash, v.kind ?? 'device', v.now + PAIRING_TTL_MS, v.now),
    ]);
    return true;
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err))) return false;
    throw err;
  }
}

/**
 * The screen's poll. Before a claim: waiting, or expired once its time is up. After one: mints a
 * credential with `mint(screenId)`, stores its hash for the claimed screen (through the claimed
 * org's scope) and returns it.
 *
 * A reply can be lost, and a screen that never got its credential would be orphaned: so a repeat
 * poll mints a fresh credential and replaces the earlier one, as long as that one was never used
 * (device auth marks first use) and the first collect was under `PAIRING_TTL_MS` ago. After that,
 * or for an unknown token, the answer is expired. At most one credential from a code is live.
 */
export async function collectPairing(
  d1: D1Database,
  pollTokenHash: string,
  now: number,
  mint: (screenId: string) => Promise<{ credential: string; secretHash: string }>,
): Promise<PairingCollected> {
  // Twice at most: a collect that lost a race to another poll of the same token tries as a repeat.
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await d1
      .prepare(
        `SELECT p.id, p.expires_at AS expiresAt, p.claimed_org_id AS orgId, p.claimed_screen_id AS screenId,
                p.collected_credential_id AS previous, p.collected_at AS collectedAt,
                c.id AS previousLive, c.last_used_at AS previousUsedAt
         FROM pairing_codes p LEFT JOIN screen_credentials c ON c.org_id = p.claimed_org_id AND c.id = p.collected_credential_id
         WHERE p.poll_token_hash = ?`,
      )
      .bind(pollTokenHash)
      .first<{
        id: string;
        expiresAt: number;
        orgId: string | null;
        screenId: string | null;
        previous: string | null;
        collectedAt: number | null;
        previousLive: string | null;
        previousUsedAt: number | null;
      }>();
    if (!row) return { status: 'expired' };
    if (!row.screenId || !row.orgId) return row.expiresAt > now ? { status: 'waiting' } : { status: 'expired' };
    if (row.previous && (!row.previousLive || row.previousUsedAt !== null || now - (row.collectedAt ?? 0) >= PAIRING_TTL_MS)) return { status: 'expired' };

    const { credential, secretHash } = await mint(row.screenId);
    const wrote = await scoped(d1, row.orgId).pairing.collect({
      codeId: row.id,
      screenId: row.screenId,
      previous: row.previous,
      credentialId: newId('crd'),
      secretHash,
      now,
    });
    if (wrote) return { status: 'paired', screenId: row.screenId, credential };
  }
  return { status: 'expired' };
}
