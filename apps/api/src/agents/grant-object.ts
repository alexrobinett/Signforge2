/**
 * An agent grant's Durable Object (#39), one per grant, named by grant id: it counts the grant's
 * calls against `AGENT_LIMITS` for the tool dispatcher. A Durable Object, not the rate-limit
 * binding or D1:
 *
 * - One object per name exists worldwide, so every location shares one count. The daily budget
 *   must hold across locations, which the binding (counted per location) cannot do.
 * - It knows when a window ends and whether a refusal is its window's first, which the dispatcher
 *   needs for `retryAfterSeconds` and its one audit row per window. The binding answers only yes or no.
 * - A read costs one call to the object and no storage write, never a D1 write.
 *
 * What it keeps where:
 * - The minute's and the day's writes, and which limits have refused in each window, are in the
 *   object's storage, in one record written with every counted write and a window's first refusal.
 *   They survive hibernation, eviction and deploys.
 * - The minute's calls are in memory, so a read writes nothing. An object with nothing pending is
 *   hibernated about 10 s after its last call, losing its memory, so the first call of each minute
 *   sets a timer to the minute's end, which keeps the object awake until then (billed as duration
 *   while a grant is active). A deploy or an eviction still forgets them, forgiving at most that
 *   minute's calls.
 *
 * Windows are fixed, the minute and the UTC day, by the object's own clock: one clock for every
 * caller, read when the call reaches it, so a call delayed on its way never lands in a window already closed.
 */
import { AGENT_LIMITS, type AgentAllowance, type AgentLimit, type AgentLimiter } from '@signforge/tools';
import { DurableObject } from 'cloudflare:workers';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A window's writes, and the limits that have already refused a call in it. */
interface Window {
  start: number;
  writes: number;
  refused: AgentLimit[];
}

/** The stored record: the open minute's and the open day's windows. */
interface Windows {
  minute: Window;
  day: Window;
}

const WINDOWS_KEY = 'windows';

const open = (stored: Window | undefined, start: number): Window => (stored?.start === start ? stored : { start, writes: 0, refused: [] });

export class AgentGrantObject extends DurableObject<Env> {
  private calls = { start: 0, count: 0 };

  /** Counts a call, a write if `write`, unless it is over a limit. */
  take(write: boolean): AgentAllowance {
    const now = Date.now();
    const minuteStart = now - (now % MINUTE_MS);
    if (this.calls.start !== minuteStart) {
      this.calls = { start: minuteStart, count: 0 };
      // Nothing to do when it fires: pending, it keeps the object (and the minute's calls) in memory.
      setTimeout(() => undefined, minuteStart + MINUTE_MS - now);
    }
    const kv = this.ctx.storage.kv;
    // Read only when a write or a refusal needs it: an allowed read reads nothing either.
    let windows: Windows | undefined;
    const stored = () => {
      if (windows) return windows;
      const s = kv.get<Windows>(WINDOWS_KEY);
      windows = { minute: open(s?.minute, minuteStart), day: open(s?.day, now - (now % DAY_MS)) };
      return windows;
    };

    const over = (limit: AgentLimit, window: Window, length: number): AgentAllowance => {
      const first = !window.refused.includes(limit);
      if (first) {
        window.refused.push(limit);
        kv.put(WINDOWS_KEY, stored());
      }
      return { ok: false, limit, retryAfterSeconds: Math.ceil((window.start + length - now) / 1000), first };
    };
    if (this.calls.count >= AGENT_LIMITS.calls_per_minute) return over('calls_per_minute', stored().minute, MINUTE_MS);
    // Every call within the call limit counts, a write refused by a write limit included.
    this.calls.count++;
    if (!write) return { ok: true };
    const { minute, day } = stored();
    if (day.writes >= AGENT_LIMITS.writes_per_day) return over('writes_per_day', day, DAY_MS);
    if (minute.writes >= AGENT_LIMITS.writes_per_minute) return over('writes_per_minute', minute, MINUTE_MS);
    minute.writes++;
    day.writes++;
    kv.put(WINDOWS_KEY, stored());
    return { ok: true };
  }
}

/** The API's `AgentLimiter`: each grant's calls counted in its object. */
export function agentLimiter(env: Pick<Env, 'AGENT_GRANTS'>): AgentLimiter {
  return { take: (grantId, write) => env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(grantId)).take(write) };
}
