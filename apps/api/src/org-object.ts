/**
 * The org's Durable Object (`OrgObject`, one per org, named by org id): what the org's Workers must
 * agree on at once, kept in its storage so it outlives an eviction.
 *
 * - **The publish lock** (src/publish.ts): a lease long enough for a 1,000-screen publish. A holder
 *   that dies leaves it to run out. The lock saves overlapping publishes the work of compiling twice
 *   and retrying; their order does not depend on it, since the publish revision's guard commits them
 *   in order anyway. M3-20's timed publish will keep its alarm here.
 * - **The agent's daily turns** (#263): one call per turn against the org's ceiling, so turns taken
 *   at once cannot pass it, and a turn costs no D1 write.
 * - **The drawer's confirmation cards** (#269, src/agent/confirm.ts), each pressed once.
 */
import { DurableObject } from 'cloudflare:workers';

/** How long a publish may hold the lock before another may take it. */
const LEASE_MS = 60_000;

interface Lease {
  token: string;
  until: number;
}

/**
 * A confirmation card the agent's drawer showed (#269, src/agent/confirm.ts): what one press of its
 * token runs, for whom, until when. Kept here, by its token, until pressed once or run out.
 */
export interface Confirmation {
  member: string;
  /** The tool the model called, and its input exactly as the card showed it, as JSON: a press with any other is refused. */
  name: string;
  calledJson: string;
  /** What a press runs, as JSON: fixed when the card was made, with the versions and pins it showed. */
  inputJson: string;
  /** The run it paused, and its call: the press resumes them. */
  runId: string;
  toolCallId: string;
  /** What the card said, for the audit row. */
  summary: string;
  /** What the turn had spent when it paused: a press goes on from there, never with a new budget. */
  spent: { calls: number; statements: number; fetches: number; elapsedMs: number };
  expiresAt: number;
}

/** The org's agent turns on one day, by the date in its time zone. */
interface Turns {
  day: string;
  count: number;
}

export class OrgObject extends DurableObject<Env> {
  /** Calls waiting for the lock, woken when it is released. */
  private waiting: (() => void)[] = [];

  /** Wait until no publish of the org holds the lock, take it, and return its token. */
  async acquire(): Promise<string> {
    for (;;) {
      // Read and written with no other await between: the input gate lets no other call in.
      const held = await this.ctx.storage.get<Lease>('publish');
      const now = Date.now();
      if (!held || held.until <= now) {
        const token = crypto.randomUUID();
        await this.ctx.storage.put('publish', { token, until: now + LEASE_MS } satisfies Lease);
        return token;
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, held.until - now);
      });
    }
  }

  /** Whether a turn is left today, counting nothing: asked before a fill fetches anything (#263). */
  async hasTurn(day: string, ceiling: number | null): Promise<boolean> {
    const now = await this.ctx.storage.get<Turns>('turns');
    return ceiling === null || (now?.day === day ? now.count : 0) < ceiling;
  }

  /**
   * Take one of the org's agent turns on `day` (YYYY-MM-DD in its time zone): true and counted while
   * fewer than `ceiling` were taken that day, or with no ceiling; false, counting nothing, once
   * `ceiling` were. A new day starts from none.
   */
  async takeTurn(day: string, ceiling: number | null): Promise<boolean> {
    // Read and written with no other await between: the input gate lets no other call in.
    const now = await this.ctx.storage.get<Turns>('turns');
    const count = now?.day === day ? now.count : 0;
    if (ceiling !== null && count >= ceiling) return false;
    await this.ctx.storage.put('turns', { day, count: count + 1 } satisfies Turns);
    return true;
  }

  /** Keep a confirmation card's record under `token` (#269), dropping those run out by `now`. */
  async offerConfirmation(token: string, record: Confirmation, now: number): Promise<void> {
    const kept = await this.ctx.storage.list<Confirmation>({ prefix: 'confirm:' });
    const gone = [...kept].flatMap(([key, r]) => (r.expiresAt <= now ? [key] : []));
    if (gone.length) await this.ctx.storage.delete(gone);
    await this.ctx.storage.put(`confirm:${token}`, record);
  }

  /** Take a confirmation card's record, once: whoever presses it, it is gone after this, used or refused. */
  async takeConfirmation(token: string): Promise<Confirmation | undefined> {
    // Read and deleted with no other await between: the input gate lets no other press in.
    const record = await this.ctx.storage.get<Confirmation>(`confirm:${token}`);
    if (record) await this.ctx.storage.delete(`confirm:${token}`);
    return record;
  }

  /** Give the lock back. A token whose lease ran out and was taken releases nothing. */
  async release(token: string): Promise<void> {
    if ((await this.ctx.storage.get<Lease>('publish'))?.token === token) await this.ctx.storage.delete('publish');
    for (const wake of this.waiting.splice(0)) wake();
  }
}
