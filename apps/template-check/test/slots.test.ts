// The slot ledger behind CheckSlots (src/worker/slots.ts): a slot is held for a check at SLOT_MS and let go early once
// the check finishes or fails, with SLOT_MS the net for a Worker that dies mid-check.
import { describe, expect, it } from 'vitest';
import { claimSlot, type Ledger, settleSlot } from '../src/worker/slots';

const SLOT = 4 * 60_000;
const IDLE = 2 * 60_000;
const MAX = 2;
const fresh = (): Ledger => ({ until: {}, busy: {} });

describe('CheckSlots', () => {
  it('holds MAX_CONTAINERS slots and refuses another name until one is let go', () => {
    const l = fresh();
    expect([claimSlot(l, 'org:a', 0, MAX, SLOT), claimSlot(l, 'org:b', 0, MAX, SLOT), claimSlot(l, 'org:c', 0, MAX, SLOT)]).toEqual([true, true, false]);
    // A name that holds one may check again.
    expect(claimSlot(l, 'org:a', 1, MAX, SLOT)).toBe(true);
  });

  it('lets a slot go when its check ends and its container is not running, and the next org takes it', () => {
    const l = fresh();
    claimSlot(l, 'org:a', 0, MAX, SLOT);
    claimSlot(l, 'org:b', 0, MAX, SLOT);
    expect(claimSlot(l, 'org:c', 1, MAX, SLOT)).toBe(false);
    // Failed to start, or crashed: nothing runs.
    settleSlot(l, 'org:a', false, 2, IDLE);
    expect(l.until).toEqual({ 'org:b': SLOT });
    expect(claimSlot(l, 'org:c', 3, MAX, SLOT)).toBe(true);
  });

  it('holds a slot only for the idle time of a container that still runs, not the whole SLOT_MS', () => {
    const l = fresh();
    claimSlot(l, 'org:a', 0, MAX, SLOT);
    settleSlot(l, 'org:a', true, 10_000, IDLE);
    expect(l.until['org:a']).toBe(10_000 + IDLE);
    claimSlot(l, 'org:b', 10_000, MAX, SLOT);
    expect(claimSlot(l, 'org:c', 10_000 + IDLE - 1, MAX, SLOT)).toBe(false);
    expect(claimSlot(l, 'org:c', 10_000 + IDLE, MAX, SLOT)).toBe(true);
  });

  it('keeps the slot while another check of the same org is in flight, and settles it once the last ends', () => {
    const l = fresh();
    claimSlot(l, 'org:a', 0, MAX, SLOT);
    claimSlot(l, 'org:a', 1, MAX, SLOT);
    settleSlot(l, 'org:a', false, 5, IDLE);
    expect(l.until['org:a']).toBe(1 + SLOT);
    settleSlot(l, 'org:a', false, 6, IDLE);
    expect(l.until).toEqual({});
    expect(l.busy).toEqual({});
  });

  it('still expires a slot whose check never settled, after SLOT_MS', () => {
    const l = fresh();
    claimSlot(l, 'org:a', 0, MAX, SLOT);
    claimSlot(l, 'org:b', 0, MAX, SLOT);
    expect(claimSlot(l, 'org:c', SLOT - 1, MAX, SLOT)).toBe(false);
    expect(claimSlot(l, 'org:c', SLOT, MAX, SLOT)).toBe(true);
    // Its count goes with it: a later check settles from one.
    expect(l.busy).toEqual({ 'org:c': 1 });
  });

  it('ignores a settle for a name that holds no slot', () => {
    const l = fresh();
    settleSlot(l, 'org:a', false, 0, IDLE);
    expect(l).toEqual(fresh());
  });
});
