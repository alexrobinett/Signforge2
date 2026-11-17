/**
 * A display override from the CMS (`DisplayOverride`): someone standing at a dark screen turns it
 * on until the next scheduled change. Persisted, so a reload keeps it; it ends by itself at `until`.
 */
import type { DisplayOverride } from '@signforge/contract';

const KEY = 'sf.displayOverride';

let current: DisplayOverride | null = read();

function read(): DisplayOverride | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DisplayOverride | null;
    return v && (v.state === 'on' || v.state === 'off') && !Number.isNaN(Date.parse(v.until)) ? v : null;
  } catch {
    return null;
  }
}

export function setOverride(o: DisplayOverride | null): void {
  current = o;
  try {
    if (o) localStorage.setItem(KEY, JSON.stringify(o));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the override holds until a reload.
  }
}

/** The override in force at `now`, or null. An expired one is forgotten. */
export function activeOverride(now: Date): DisplayOverride | null {
  if (current && Date.parse(current.until) <= now.getTime()) setOverride(null);
  return current;
}

/** A sleep that `wake` cuts short: a loop that checks every so often, but can be told to look now. */
export function wakeable() {
  let wake: (() => void) | undefined;
  /** Woken while not waiting: the next wait returns at once. */
  let pending = false;
  return {
    wait: (ms: number) =>
      new Promise<void>((r) => {
        if (pending) {
          pending = false;
          return r();
        }
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          wake = undefined;
          r();
        }
        wake = done;
      }),
    wake: () => {
      if (wake) wake();
      else pending = true;
    },
  };
}
