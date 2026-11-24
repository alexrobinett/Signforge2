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
 *
 * The same objects count `forbidden` refusals for the `agent.refused` alert (M4-08): a grant's in its
 * own, by clock hour, and an org's alerts in one named `org:<id>` (`refusalAlertDue`, below).
 */
import { AGENT_LIMITS, type AgentAllowance, type AgentLimit, type AgentLimiter, type AgentLimitWindow } from '@signforge/tools';
import { DurableObject } from 'cloudflare:workers';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How many `forbidden` refusals within a clock hour alert the org (M4-08): an agent misconfigured or misled, not one stray call. */
const REFUSALS_TO_ALERT = 3;
/** The most `agent.refused` alerts an org is sent in a clock hour, however many of its agents are refused. */
const ORG_ALERTS_PER_HOUR = 5;

/** A count in the open clock hour: a grant's `forbidden` refusals, or an org's alerts. */
interface HourCount {
  start: number;
  count: number;
}
const REFUSALS_KEY = 'refusals';
const ORG_ALERTS_KEY = 'org_alerts';

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
   * goes at most once per grant a clock hour. Only a forbidden refusal reaches the object, and only until the alert (`refusalAlertDue`).
   */
  refused(): { alert: boolean; refusals: number; hour: number } {
    const hour = this.counted(REFUSALS_KEY);
    return { alert: hour.count === REFUSALS_TO_ALERT, refusals: hour.count, hour: hour.start };
  }

  /**
   * Whether an org may be sent one more `agent.refused` alert this clock hour (in the object named
   * `org:<id>`): its first `ORG_ALERTS_PER_HOUR`, so a member with many grants
   * cannot flood the owners. Asked only when a grant's alert is due (`refusalAlertDue`), at most once per grant a clock hour.
   */
  orgAlertDue(): boolean {
    return this.counted(ORG_ALERTS_KEY).count <= ORG_ALERTS_PER_HOUR;
  }

  /** One more in the count stored at `key`, for the open clock hour by the object's clock. */
  private counted(key: string): HourCount {
    const now = Date.now();
    const start = now - (now % HOUR_MS);
    const stored = this.ctx.storage.kv.get<HourCount>(key);
    const hour = stored?.start === start ? stored : { start, count: 0 };
    hour.count++;
    this.ctx.storage.kv.put(key, hour);
    return hour;
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

/**
 * The clock hour in which this isolate saw a grant's refusals reach the alert, by grant: its later
 * `forbidden` refusals that hour reach no object, so a runaway agent's refusals cost at most
 * `REFUSALS_TO_ALERT` object requests per isolate an hour (more only while some are in flight at
 * once), as `recordedMinute` bounds the call limit's. One entry a grant.
 */
const refusalsDone = new Map<string, number>();

/**
 * Counts a `forbidden` refusal of `grantId` (M4-08) and says whether to alert: the grant's object
 * answers yes once a clock hour, at its `REFUSALS_TO_ALERT`th, and then the org's object, for its
 * hourly cap. Null when no alert is due.
 */
export async function refusalAlertDue(
  env: Pick<Env, 'AGENT_GRANTS'>,
  orgId: string,
  grantId: string,
  now: number,
): Promise<{ refusals: number; hour: number } | null> {
  if (refusalsDone.get(grantId) === now - (now % HOUR_MS)) return null;
  const counted = await env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(grantId)).refused();
  if (counted.refusals >= REFUSALS_TO_ALERT) refusalsDone.set(grantId, counted.hour);
  if (!counted.alert) return null;
  if (!(await env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(`org:${orgId}`)).orgAlertDue())) {
    console.warn(JSON.stringify({ event: 'agent_refused_alert_capped', org: orgId, grant: grantId }));
    return null;
  }
  return { refusals: counted.refusals, hour: counted.hour };
}
