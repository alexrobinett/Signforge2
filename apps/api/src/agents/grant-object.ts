/**
 * An agent grant's Durable Object (#39), one per grant, named by grant id: it counts the grant's
 * calls against `AGENT_LIMITS` for the tool dispatcher. A Durable Object, not the rate-limit
 * binding or D1:
 *
 * - One object per name exists worldwide, so every location shares one count. The daily budget
 *   must hold across locations, which the binding (counted per location) cannot do.
 * - It knows when a window ends and whether a refusal is its window's first, which the dispatcher
 *   needs for `retryAfterSeconds` and its one audit row per window. The binding answers only yes or no.
 * - A read costs one call to the object and no storage write: the minute's counts are kept in
 *   memory. Only a write updates the day's count, in the object's own storage, never D1.
 *
 * The minute's counts are lost if the object restarts mid-minute (a deploy; an object is evicted
 * only when idle, by which time its minute is over), which forgives at most that minute. Windows
 * are fixed, the minute and the UTC day, by the object's own clock: one clock for every caller,
 * read when the call reaches it, so a call delayed on its way never lands in a window already closed.
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

const DAY_KEY = 'day';

export class AgentGrantObject extends DurableObject<Env> {
  private minute: Window & { calls: number } = { start: 0, calls: 0, writes: 0, refused: [] };

  /** Counts a call, a write if `write`, unless it is over a limit. */
  take(write: boolean): AgentAllowance {
    const now = Date.now();
    const kv = this.ctx.storage.kv;
    const minuteStart = now - (now % MINUTE_MS);
    if (minuteStart !== this.minute.start) this.minute = { start: minuteStart, calls: 0, writes: 0, refused: [] };
    const stored = kv.get<Window>(DAY_KEY);
    const dayStart = now - (now % DAY_MS);
    const day: Window = stored?.start === dayStart ? stored : { start: dayStart, writes: 0, refused: [] };

    const over = (limit: AgentLimit, window: Window, length: number): AgentAllowance => {
      const first = !window.refused.includes(limit);
      if (first) window.refused.push(limit);
      if (first && limit === 'writes_per_day') kv.put(DAY_KEY, day);
      return { ok: false, limit, retryAfterSeconds: Math.ceil((window.start + length - now) / 1000), first };
    };
    if (this.minute.calls >= AGENT_LIMITS.calls_per_minute) return over('calls_per_minute', this.minute, MINUTE_MS);
    // Every call within the call limit counts, a write refused by a write limit included.
    this.minute.calls++;
    if (write && day.writes >= AGENT_LIMITS.writes_per_day) return over('writes_per_day', day, DAY_MS);
    if (write && this.minute.writes >= AGENT_LIMITS.writes_per_minute) return over('writes_per_minute', this.minute, MINUTE_MS);
    if (write) {
      this.minute.writes++;
      day.writes++;
      kv.put(DAY_KEY, day);
    }
    return { ok: true };
  }
}

/** The API's `AgentLimiter`: each grant's calls counted in its object. */
export function agentLimiter(env: Pick<Env, 'AGENT_GRANTS'>): AgentLimiter {
  return { take: (grantId, write) => env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(grantId)).take(write) };
}
