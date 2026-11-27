/**
 * Play counts on the screen (contract `PlayCount`): plays and time on screen per spot per UTC
 * hour, persisted by the caller (`toJSON`, `restore`), and sent in numbered batches until a sync
 * acknowledges them.
 *
 * An hour is sent once it has ended, so the server writes each (hour, spot) row about once: a sync
 * every 5 minutes that sent the running hour would write every row twelve times. A batch keeps its
 * `seq` until acknowledged in its `epoch`, so a retry repeats it exactly and the server, which
 * ignores a seq it has stored, never counts it twice. Plays made meanwhile wait for the next batch.
 */
import type { PlayCount } from '@signforge/contract';

const HOUR_MS = 3_600_000;

/** `2026-11-17T13:00Z`: the start of the UTC hour `ms` falls in. */
export const hourOf = (ms: number): string => `${new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13)}:00Z`;

export interface PlayBatch {
  epoch: string;
  seq: number;
  counts: PlayCount[];
}

interface Stored {
  epoch: string;
  /** The last seq used. */
  seq: number;
  sent?: { seq: number; counts: PlayCount[] };
  open: PlayCount[];
}

const isStored = (v: unknown): v is Stored => {
  const s = v as Stored | null;
  return !!s && typeof s.epoch === 'string' && s.epoch !== '' && Number.isSafeInteger(s.seq) && Array.isArray(s.open);
};

export class PlayLedger {
  private constructor(private s: Stored) {}

  /** A new run of seq numbers. The epoch must be random, never from the clock. */
  static fresh(epoch: string): PlayLedger {
    return new PlayLedger({ epoch, seq: 0, open: [] });
  }

  /** The ledger as stored, or a fresh one (with `newEpoch()`) when nothing usable is. */
  static restore(stored: unknown, newEpoch: () => string): PlayLedger {
    return isStored(stored) ? new PlayLedger(structuredClone(stored)) : PlayLedger.fresh(newEpoch());
  }

  toJSON(): Stored {
    return this.s;
  }

  /** A play of `spot` starting at corrected time `at`, `ms` long. */
  record(at: number, spot: string, ms: number): void {
    const hour = hourOf(at);
    const c = this.s.open.find((x) => x.hour === hour && x.spot === spot);
    if (c) {
      c.plays++;
      c.ms += ms;
    } else this.s.open.push({ hour, spot, plays: 1, ms });
  }

  /**
   * Take back a play `record` counted, while its hour is still open. One already in a batch stays:
   * the server may have stored it.
   */
  retract(at: number, spot: string, ms: number): void {
    const hour = hourOf(at);
    const c = this.s.open.find((x) => x.hour === hour && x.spot === spot);
    if (!c) return;
    c.plays--;
    c.ms = Math.max(0, c.ms - ms);
    if (c.plays <= 0) this.s.open = this.s.open.filter((x) => x !== c);
  }

  /**
   * What the next sync sends: the unacknowledged batch again, or a new one of the hours ended by
   * `now` (at most `max` counts), or no counts under the last seq.
   */
  batch(now: number, max = Number.POSITIVE_INFINITY): PlayBatch {
    const { epoch } = this.s;
    if (this.s.sent) return { epoch, seq: this.s.sent.seq, counts: this.s.sent.counts };
    const current = hourOf(now);
    const ended = this.s.open
      .filter((c) => c.hour < current)
      .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : a.spot < b.spot ? -1 : a.spot > b.spot ? 1 : 0))
      .slice(0, max);
    if (!ended.length) return { epoch, seq: this.s.seq, counts: [] };
    this.s.open = this.s.open.filter((c) => !ended.includes(c));
    this.s.seq++;
    this.s.sent = { seq: this.s.seq, counts: ended };
    return { epoch, seq: this.s.seq, counts: ended };
  }

  /** A sync answered with `ackSeq` in `epoch`: drop the batch it covers. */
  acknowledge(epoch: string, ackSeq: number): void {
    if (epoch === this.s.epoch && this.s.sent && ackSeq >= this.s.sent.seq) delete this.s.sent;
  }

  /** Counts not yet acknowledged, for the status overlay. */
  get pending(): number {
    return this.s.open.reduce((n, c) => n + c.plays, 0) + (this.s.sent?.counts.reduce((n, c) => n + c.plays, 0) ?? 0);
  }
}
