/**
 * Play counts on the device: a `PlayLedger` (player-core) kept in Cache Storage beside the stored
 * manifests, so counts survive a reload or a power cut until a sync acknowledges them.
 */
import { MAX_SYNC_PLAY_COUNTS } from '@signforge/contract';
import { PlayLedger, type PlayBatch } from '@signforge/player-core';

const STATE = 'sf-state-v1';
const KEY = '/_sf/plays';

/** A random id for a new run of seq numbers; never from the clock, which may be wrong. */
const randomEpoch = () => `e${Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join('')}`;

let ledger = PlayLedger.fresh(randomEpoch());
let saving: Promise<void> = Promise.resolve();

/** Read the stored ledger. Plays recorded before it loads would be lost, so call it before playback starts. */
export async function loadPlays(): Promise<void> {
  try {
    const res = await (await caches.open(STATE)).match(KEY);
    ledger = PlayLedger.restore(res ? await res.json() : undefined, randomEpoch);
  } catch (err) {
    console.warn('[sf] could not read stored play counts; starting a new count', err);
  }
  save();
}

function save(): void {
  const text = JSON.stringify(ledger.toJSON());
  saving = saving
    .then(async () => (await caches.open(STATE)).put(KEY, new Response(text, { headers: { 'content-type': 'application/json' } })))
    .catch((err: unknown) => console.warn('[sf] could not store play counts', err));
}

/** A play starting at corrected time `at`. Only on a trusted clock: otherwise its hour is unknown. */
export function recordPlay(at: number, spot: string, ms: number): void {
  ledger.record(at, spot, ms);
  save();
}

/** Take back a play `recordPlay` counted, while its hour is still open (`PlayLedger.retract`). */
export function retractPlay(at: number, spot: string, ms: number): void {
  ledger.retract(at, spot, ms);
  save();
}

/** The counts the next sync carries (see `PlayLedger.batch`). */
export function playBatch(now: number): PlayBatch {
  const b = ledger.batch(now, MAX_SYNC_PLAY_COUNTS);
  save();
  return b;
}

export function acknowledgePlays(epoch: string, ackSeq: number): void {
  ledger.acknowledge(epoch, ackSeq);
  save();
}

/** Plays counted and not yet acknowledged. */
export const pendingPlays = (): number => ledger.pending;
