/**
 * An agent grant's limits (#39, #107), counted for the tool dispatcher in two places:
 *
 * - **Calls**, 120 a minute, by the `AGENT_CALL_LIMIT` rate limit binding, keyed by grant id. The
 *   binding counts per Cloudflare location, which the minute limit allows (owner decision on #107):
 *   an agent spread over several locations gets 120 a minute in each. A read costs no Durable Object
 *   request, no duration and no write.
 * - **Writes**, 30 a minute and 2,000 a UTC day, in one Durable Object per grant, named by grant id.
 *   One object per name exists worldwide, so the daily budget, the limit that protects data, holds
 *   across locations, which the binding cannot do. The minute's and the day's writes, and whether
 *   each window's audit row is written, are one record in the object's storage, written with every
 *   counted write: they survive hibernation, eviction and deploys. Nothing keeps the object awake
 *   between writes, so it hibernates and is billed only while it answers one.
 *
 * Windows are fixed, the minute and the UTC day. The object places a write by its own clock, read
 * when the call reaches it, so a call delayed on its way never lands in a window already closed.
 * The binding's minute is its own; a call it refuses is told to retry at the end of this Worker's minute.
 */
import { AGENT_LIMITS, type AgentAllowance, type AgentLimit, type AgentLimiter, type AgentLimitWindow } from '@signforge/tools';
import { DurableObject } from 'cloudflare:workers';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How many `forbidden` refusals within an hour alert the org (M4-08): an agent misconfigured or misled, not one stray call. */
const REFUSALS_TO_ALERT = 3;

/** The open hour's `forbidden` refusals. */
interface Refusals {
  start: number;
  count: number;
}
const REFUSALS_KEY = 'refusals';

/** A window's writes, and whether its refusals' audit row is written. */
interface Window {
  start: number;
  writes: number;
  audited: boolean;
}

/** The stored record: the open minute's and the open day's windows. */
type Windows = Record<AgentLimitWindow['window'], Window>;

const WINDOWS_KEY = 'windows';

const open = (stored: Window | undefined, start: number): Window => (stored?.start === start ? stored : { start, writes: 0, audited: false });

export class AgentGrantObject extends DurableObject<Env> {
  /** Counts a write, unless it is over a write limit. */
  write(): AgentAllowance {
    const now = Date.now();
    const windows = this.windows(now);
    const over = (limit: AgentLimit, window: AgentLimitWindow['window'], length: number): AgentAllowance => {
      const w = windows[window];
      const retryAfterSeconds = Math.ceil((w.start + length - now) / 1000);
      return w.audited ? { ok: false, limit, retryAfterSeconds } : { ok: false, limit, retryAfterSeconds, audit: { window, start: w.start } };
    };
    if (windows.day.writes >= AGENT_LIMITS.writes_per_day) return over('writes_per_day', 'day', DAY_MS);
    if (windows.minute.writes >= AGENT_LIMITS.writes_per_minute) return over('writes_per_minute', 'minute', MINUTE_MS);
    windows.minute.writes++;
    windows.day.writes++;
    this.ctx.storage.kv.put(WINDOWS_KEY, windows);
    return { ok: true };
  }

  /** The window's audit row is written. Stored only now, so a row that failed to write is asked for again; once only, however many refusals race to say so. */
  audited({ window, start }: AgentLimitWindow): void {
    const windows = this.windows(Date.now());
    if (windows[window].start !== start || windows[window].audited) return;
    windows[window].audited = true;
    this.ctx.storage.kv.put(WINDOWS_KEY, windows);
  }

  /**
   * A call refused `forbidden` (M4-08), counted in the open hour by the object's clock. `alert` is
   * true for exactly one refusal an hour, the `REFUSALS_TO_ALERT`th, however many race: the alert
   * goes at most once per grant an hour. Only a refusal reaches the object; a call it allows never does.
   */
  refused(): { alert: boolean; refusals: number; hour: number } {
    const now = Date.now();
    const start = now - (now % HOUR_MS);
    const stored = this.ctx.storage.kv.get<Refusals>(REFUSALS_KEY);
    const hour = stored?.start === start ? stored : { start, count: 0 };
    hour.count++;
    this.ctx.storage.kv.put(REFUSALS_KEY, hour);
    return { alert: hour.count === REFUSALS_TO_ALERT, refusals: hour.count, hour: start };
  }

  /** The open windows at `now`, as stored. */
  private windows(now: number): Windows {
    const stored = this.ctx.storage.kv.get<Windows>(WINDOWS_KEY);
    return { minute: open(stored?.minute, now - (now % MINUTE_MS)), day: open(stored?.day, now - (now % DAY_MS)) };
  }
}

/**
 * The minute this isolate last recorded a call-limit refusal row for, by grant: its later refusals
 * in that minute ask for no row, so a runaway agent's refused calls reach neither D1 nor the
 * object. Another isolate asks once more and writes nothing (`auditLog.appendOnce`). One entry a grant.
 */
const recordedMinute = new Map<string, number>();

/** The API's `AgentLimiter`: each grant's calls on the binding, its writes in its object. */
export function agentLimiter(env: Pick<Env, 'AGENT_GRANTS' | 'AGENT_CALL_LIMIT'>): AgentLimiter {
  const object = (grantId: string) => env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(grantId));
  return {
    take: async (grantId, write) => {
      if (!(await env.AGENT_CALL_LIMIT.limit({ key: grantId })).success) {
        const now = Date.now();
        const start = now - (now % MINUTE_MS);
        const retryAfterSeconds = Math.ceil((start + MINUTE_MS - now) / 1000);
        if (recordedMinute.get(grantId) === start) return { ok: false, limit: 'calls_per_minute', retryAfterSeconds };
        return { ok: false, limit: 'calls_per_minute', retryAfterSeconds, audit: { window: 'minute', start } };
      }
      // A call within the call limit counts, a write refused by a write limit included.
      return write ? object(grantId).write() : { ok: true };
    },
    audited: async (grantId, window) => {
      if (window.window === 'minute') recordedMinute.set(grantId, window.start);
      await object(grantId).audited(window);
    },
  };
}
