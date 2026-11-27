/**
 * Play counts on the device: a `PlayLedger` (player-core) kept in Cache Storage beside the stored
 * manifests, so counts survive a reload or a power cut until a sync acknowledges them.
 *
 * A play is not a write: the whole ledger is rewritten at most every FLUSH_MS, when the page is
 * hidden or goes away, and at once for a batch or an acknowledgement. A power cut loses at most
 * FLUSH_MS of plays, never a batch's seq: one sent and acknowledged but not stored would be
 * reused under the same epoch after the restart, and the server ignores a seq it has stored.
 */
import { MAX_SYNC_PLAY_COUNTS } from '@signforge/contract';
import { PlayLedger, type PlayBatch } from '@signforge/player-core';

const STATE = 'sf-state-v1';
const KEY = '/_sf/plays';
/** The longest a counted play waits to be stored. */
const FLUSH_MS = 60_000;

/** A random id for a new run of seq numbers; never from the clock, which may be wrong. */
const randomEpoch = () => `e${Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join('')}`;

let ledger = PlayLedger.fresh(randomEpoch());
/** The ledger has changed since it was last stored. */
let dirty = false;
let saving: Promise<void> = Promise.resolve();

/** Read the stored ledger. Plays recorded before it loads would be lost, so call it before playback starts. */
export async function loadPlays(): Promise<void> {
  try {
    const res = await (await caches.open(STATE)).match(KEY);
    ledger = PlayLedger.restore(res ? await res.json() : undefined, randomEpoch);
  } catch (err) {
    console.warn('[sf] could not read stored play counts; starting a new count', err);
  }
  dirty = true;
  void flush();
  setInterval(() => void flush(), FLUSH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  addEventListener('pagehide', () => void flush());
}

/** Store the ledger as it is now, if it changed; resolves once that write (and any before it) is done. */
function flush(): Promise<void> {
  if (!dirty) return saving;
  dirty = false;
  const text = JSON.stringify(ledger.toJSON());
  saving = saving
    .then(async () => (await caches.open(STATE)).put(KEY, new Response(text, { headers: { 'content-type': 'application/json' } })))
    .catch((err: unknown) => {
      // Tried again at the next flush.
      dirty = true;
      console.warn('[sf] could not store play counts', err);
    });
  return saving;
}

/** A play starting at corrected time `at`. Only on a trusted clock: otherwise its hour is unknown. */
export function recordPlay(at: number, spot: string, ms: number): void {
  ledger.record(at, spot, ms);
  dirty = true;
}

/** Take back a play `recordPlay` counted, while its hour is still open (`PlayLedger.retract`). */
export function retractPlay(at: number, spot: string, ms: number): void {
  ledger.retract(at, spot, ms);
  dirty = true;
}

/**
 * The counts the next sync carries (see `PlayLedger.batch`), resolved once its seq is stored, so it
 * is never sent before. A store that fails is logged and the batch still goes: a sync withheld until
 * storage works would take the heartbeat with it.
 */
export async function playBatch(now: number): Promise<PlayBatch> {
  const b = ledger.batch(now, MAX_SYNC_PLAY_COUNTS);
  dirty = true;
  await flush();
  return b;
}

export function acknowledgePlays(epoch: string, ackSeq: number): void {
  ledger.acknowledge(epoch, ackSeq);
  dirty = true;
  void flush();
}

/** Plays counted and not yet acknowledged. */
export const pendingPlays = (): number => ledger.pending;
