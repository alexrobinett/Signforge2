/**
 * The ledger behind CheckSlots (./index.ts): which instance names hold a container slot, kept apart from the
 * Durable Object so it runs, and is tested, in Node.
 */
export interface Ledger {
  /** Per instance name, when its slot expires. */
  until: Record<string, number>;
  /** Per instance name, the checks in flight: a slot is shortened only once none of them is. */
  busy: Record<string, number>;
}

/** Hold `name`'s slot for a check until `now + holdMs`; false when `max` other names hold one. */
export function claimSlot(ledger: Ledger, name: string, now: number, max: number, holdMs: number): boolean {
  for (const [held, until] of Object.entries(ledger.until)) if (until <= now) delete ledger.until[held];
  // A Worker that died mid-check never settled: its count goes with its expired slot.
  for (const held of Object.keys(ledger.busy)) if (!(held in ledger.until)) delete ledger.busy[held];
  if (!(name in ledger.until) && Object.keys(ledger.until).length >= max) return false;
  ledger.until[name] = now + holdMs;
  ledger.busy[name] = (ledger.busy[name] ?? 0) + 1;
  return true;
}

/**
 * A check of `name` is over, finished or failed. Without a running container its slot is let go; with one, it
 * lasts as long as the container idles (`idleMs`), never longer than it was held. A second check of the same
 * name still in flight keeps the slot as it is.
 */
export function settleSlot(ledger: Ledger, name: string, running: boolean, now: number, idleMs: number): void {
  if (!(name in ledger.until)) return;
  const busy = (ledger.busy[name] ?? 1) - 1;
  if (busy > 0) {
    ledger.busy[name] = busy;
    return;
  }
  delete ledger.busy[name];
  if (running) ledger.until[name] = Math.min(ledger.until[name]!, now + idleMs);
  else delete ledger.until[name];
}
