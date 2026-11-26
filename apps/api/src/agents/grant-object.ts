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
/**
 * The most of them for the agents one member granted: one member's many grants cannot use up the org's hour, so another
 * member's misbehaving agent still alerts (#347). Of the org's five, three are always left for the others.
 */
const MEMBER_ALERTS_PER_HOUR = 2;

/** A count in the open clock hour: a grant's `forbidden` refusals. `alerted`: its alert is claimed this hour. */
interface HourCount {
  start: number;
  count: number;
  alerted?: boolean;
}

/** An org's alerts sent in the open clock hour, in all and by the member who granted each agent. */
interface OrgAlerts {
  start: number;
  count: number;
  /** Absent in a record from before #347. */
  byMember?: Record<string, number>;
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
   * true for one refusal an hour, the first from the `REFUSALS_TO_ALERT`th, however many race: it claims the grant's
   * alert for the hour, which goes at most once a clock hour. Only a forbidden refusal reaches the object, and only
   * until the alert (`refusalAlertDue`).
   */
  refused(): { alert: boolean; refusals: number; hour: number } {
    const now = Date.now();
    const start = now - (now % HOUR_MS);
    const stored = this.ctx.storage.kv.get<HourCount>(REFUSALS_KEY);
    const hour = stored?.start === start ? stored : { start, count: 0 };
    // A record from before #347 has no flag: it alerted at its third refusal.
    const alerted = hour.alerted ?? hour.count >= REFUSALS_TO_ALERT;
    hour.count++;
    const alert = hour.count >= REFUSALS_TO_ALERT && !alerted;
    if (alert) hour.alerted = true;
    this.ctx.storage.kv.put(REFUSALS_KEY, hour);
    return { alert, refusals: hour.count, hour: hour.start };
  }

  /** The alert `refused` claimed for `hour` was never asked of the org (its check failed): the next refusal claims it again (#347). */
  unclaimed(hour: number): void {
    const stored = this.ctx.storage.kv.get<HourCount>(REFUSALS_KEY);
    if (stored?.start !== hour || !stored.alerted) return;
    this.ctx.storage.kv.put(REFUSALS_KEY, { ...stored, alerted: false });
  }

  /**
   * Whether an org may be sent one more `agent.refused` alert this clock hour (in the object named `org:<id>`), for an
   * agent `member` granted: within the org's first `ORG_ALERTS_PER_HOUR` and the member's first `MEMBER_ALERTS_PER_HOUR`,
   * so no member's grants flood the owners or hide another member's (#347). Counted only when due. Asked only when a
   * grant's alert is due (`refusalAlertDue`), at most once per grant a clock hour.
   */
  orgAlertDue(member: string): boolean {
    const now = Date.now();
    const start = now - (now % HOUR_MS);
    const stored = this.ctx.storage.kv.get<OrgAlerts>(ORG_ALERTS_KEY);
    const hour: OrgAlerts = stored?.start === start ? stored : { start, count: 0, byMember: {} };
    // A record from before #347 counted the org alone: its hour has no members yet.
    const byMember = hour.byMember ?? {};
    const mine = byMember[member] ?? 0;
    if (hour.count >= ORG_ALERTS_PER_HOUR || mine >= MEMBER_ALERTS_PER_HOUR) return false;
    this.ctx.storage.kv.put(ORG_ALERTS_KEY, { start, count: hour.count + 1, byMember: { ...byMember, [member]: mine + 1 } });
    return true;
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
 * Counts a `forbidden` refusal of `grantId`, granted by `member` (M4-08), and says whether to alert: the grant's object
 * answers yes once a clock hour, from its `REFUSALS_TO_ALERT`th, and then the org's object, for its hourly caps. Null
 * when no alert is due. The grant's alert and this isolate's memo are spent only once the org's object has answered:
 * a check that fails gives the alert back, for the next refusal to claim (#347).
 */
export async function refusalAlertDue(
  env: Pick<Env, 'AGENT_GRANTS'>,
  { orgId, grantId, member }: { orgId: string; grantId: string; member: string },
  now: number,
): Promise<{ refusals: number; hour: number } | null> {
  if (refusalsDone.get(grantId) === now - (now % HOUR_MS)) return null;
  const grant = env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(grantId));
  const counted = await grant.refused();
  if (!counted.alert) {
    // Claimed already this hour: this isolate need not ask again.
    if (counted.refusals >= REFUSALS_TO_ALERT) refusalsDone.set(grantId, counted.hour);
    return null;
  }
  let due: boolean;
  try {
    due = await env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName(`org:${orgId}`)).orgAlertDue(member);
  } catch (err) {
    await grant.unclaimed(counted.hour);
    throw err;
  }
  refusalsDone.set(grantId, counted.hour);
  if (!due) {
    console.warn(JSON.stringify({ event: 'agent_refused_alert_capped', org: orgId, grant: grantId }));
    return null;
  }
  return { refusals: counted.refusals, hour: counted.hour };
}
