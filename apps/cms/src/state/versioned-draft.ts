/**
 * Versioned drafts (GLOSSARY.md): an edit to a versioned record, from the first change to the save
 * that keeps it, for every editor store. Plain TypeScript: a store's slice keeps the drafts in its
 * state through `state`, and its components read them from there.
 *
 * A draft knows the org it was made in, the record it edits and the version that edit builds on,
 * which its save sends as `ifVersion`. Saves of one record run one at a time; a save asked for
 * while one runs becomes one follow-up with the latest edit, and the caller awaiting either
 * resolves once both are done. Each save's answer moves every draft of the record that was on the
 * old version to the new one, so another form's edit does not conflict with this one's save. A
 * conflict keeps the edit, marks it stale and saves nothing more until Reload drops it; nothing is
 * merged or overwritten. A draft is saved only in its own org, and an answer that comes after the
 * tab has left that org changes nothing there. A create's idempotency key is made with the draft
 * and kept for every retry until a save is answered, so a retry after a lost answer makes no
 * second one. Autosave is a debounce on top (`autosave`).
 */
import { isGone, isStale, toolMessage } from '~/lib/tools';

/** How the draft's save is going: `invalid` when the server would refuse it as it is, so it is not sent. */
type DraftStatus = 'unsaved' | 'saving' | 'saved' | 'invalid';

/** One draft, as the store keeps it. */
export interface Draft<E> {
  /** The org it was made in: it is saved there only. */
  orgId: string;
  /** The record it edits, which several drafts can share (two settings forms); null for a create not yet answered. */
  record: string | null;
  /** The record's version the edit builds on: sent as `ifVersion`, moved on by each save. Null for a create. */
  version: number | null;
  edit: E;
  /** A create's idempotency key: kept for every retry, a new one once a save is answered. */
  idempotencyKey: string;
  status: DraftStatus;
  /** A save is on its way, a follow-up included: what the page's controls wait for. */
  pending: boolean;
  savedAt: number | null;
  /** Why the last save failed, to show with the edit. */
  error: string | null;
  /** Someone else changed the record since: the edit stays, nothing more is saved, and Reload is offered. */
  stale: boolean;
  /** The record was deleted, by someone else or in another tab: nothing more is saved. */
  gone: boolean;
}

/** A store's drafts, by the key it gives each one. */
export type Drafts<E> = Readonly<Record<string, Draft<E>>>;

/** Where a draft starts: the record as the page holds it. */
interface DraftStart<E> {
  orgId: string;
  record: string | null;
  version: number | null;
  edit: E;
}

/** What a save's answer says: the record's version now, and the record a create made. */
export interface Saved {
  version?: number;
  record?: string;
}

/** One save to send: the draft as it stands, what the page gave with the save, and `moved` for a save made of several writes. */
interface SaveCall<E, C> {
  key: string;
  draft: Draft<E>;
  context: C;
  /** The record is at `version` now, part-way through the save: a later step that fails keeps it. */
  moved: (version: number) => void;
}

/** Time, for `savedAt` and autosave: the real clock in the app, a fake one in tests. */
export interface Clock {
  now: () => number;
  /** Runs `run` after `ms`; the function returned cancels it. */
  after: (ms: number, run: () => void) => () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** What the drafts module needs from the store that holds it. */
export interface DraftsOptions<E, C> {
  /** The drafts in the store's state. */
  state: { read: () => Drafts<E>; write: (change: (drafts: Drafts<E>) => Drafts<E>) => void };
  /** Sends one save. A refusal is thrown, as `callTool` throws it. */
  save: (call: SaveCall<E, C>) => Promise<Saved>;
  /** Makes an idempotency key. */
  makeId: () => string;
  /** The org the tab shows now, or undefined outside the app shell. */
  currentOrg: () => string | undefined;
  clock: Clock;
  /** Whether the server would refuse the draft as it is: then it is marked invalid, not sent. */
  invalid?: (draft: Draft<E>, key: string) => boolean;
}

/** The drafts of one store. */
export interface VersionedDrafts<E, C> {
  /** Starts the draft at `key` with `start`, or replaces it: a dialog or editor opened afresh. */
  open: (key: string, start: DraftStart<E>) => void;
  /** Changes the draft at `key`, starting it from `start` when there is none in that org, or the last one is saved. */
  edit: (key: string, start: DraftStart<E>, change: (edit: E) => E) => void;
  /** Changes the draft at `key`, if there is one. */
  update: (key: string, change: (edit: E) => E) => void;
  /**
   * Saves the draft at `key` now, with what the page knows (`context`). Resolves once the save in
   * flight, if any, and the one asked for here are done; at once when there is nothing to save.
   */
  save: (key: string, context: C) => Promise<void>;
  /** Drops the draft at `key`: Reload after a conflict, Discard, a closed dialog. A save on its way finishes and changes nothing. */
  drop: (key: string) => void;
  /** Drops every draft, as after an org switch. */
  forget: () => void;
}

/** The conflict's words, the same on every page. */
const STALE = 'This changed since you opened it.';

/** A save running for one draft, and the follow-up asked for meanwhile, with the context it was asked with. */
interface Flight<C> {
  next: { context: C } | null;
  done: Promise<void>;
}

export function createVersionedDrafts<E, C = void>(options: DraftsOptions<E, C>): VersionedDrafts<E, C> {
  const { state, clock } = options;
  /** By org and key: a draft key can be used again in another org (a settings form). */
  const flights = new Map<string, Flight<C>>();
  /** The last save queued on each record that is still to finish, by org and record: the next one waits for it. */
  const lanes = new Map<string, Promise<void>>();

  const change = (key: string, orgId: string, f: (d: Draft<E>) => Draft<E>) =>
    state.write((drafts) => {
      const d = drafts[key];
      return d?.orgId === orgId ? { ...drafts, [key]: f(d) } : drafts;
    });

  const fresh = (start: DraftStart<E>): Draft<E> => ({
    ...start,
    idempotencyKey: options.makeId(),
    status: 'unsaved',
    pending: false,
    savedAt: null,
    error: null,
    stale: false,
    gone: false,
  });

  /** Every draft of `record` in `orgId` still on `from`, and the saved draft itself, goes to `to`. */
  const advance = (key: string, orgId: string, record: string | null, from: number | null, to: number) =>
    state.write((drafts) =>
      Object.fromEntries(
        Object.entries(drafts).map(([k, d]) => [
          k,
          d.orgId === orgId && d.version === from && (k === key || (record !== null && d.record === record)) ? { ...d, version: to } : d,
        ]),
      ),
    );

  /** Sends the draft as it stands now: the first save, or the follow-up with the latest edit. */
  async function attempt(key: string, orgId: string, context: C, flight: Flight<C>) {
    const d = state.read()[key];
    if (d?.orgId !== orgId || d.status === 'saved') return;
    // The answer is this draft's: one dropped and started again meanwhile (a dialog reopened) has a key of its own.
    const mine = (f: (x: Draft<E>) => Draft<E>) => change(key, orgId, (x) => (x.idempotencyKey === d.idempotencyKey ? f(x) : x));
    const here = () => options.currentOrg() === orgId;
    if (!here()) {
      mine((x) => ({ ...x, status: 'unsaved' }));
      return;
    }
    if (options.invalid?.(d, key)) {
      mine((x) => ({ ...x, status: 'invalid' }));
      return;
    }
    mine((x) => ({ ...x, status: 'saving', error: null }));
    const sent = d.edit;
    let at = d.version;
    const moved = (version: number) => {
      if (!here()) return;
      advance(key, orgId, d.record, at, version);
      at = version;
    };
    try {
      const answer = await options.save({ key, draft: d, context, moved });
      if (!here()) {
        flight.next = null;
        mine((x) => ({ ...x, status: 'unsaved' }));
        return;
      }
      if (answer.version !== undefined) moved(answer.version);
      mine((x) => ({
        ...x,
        record: answer.record ?? x.record,
        status: x.edit === sent ? 'saved' : flight.next ? 'saving' : 'unsaved',
        savedAt: clock.now(),
        idempotencyKey: options.makeId(),
      }));
    } catch (err) {
      // A refused save is not tried again until it is asked for again.
      flight.next = null;
      if (!here()) {
        mine((x) => ({ ...x, status: 'unsaved' }));
        return;
      }
      mine((x) => ({
        ...x,
        status: 'unsaved',
        stale: isStale(err),
        gone: isGone(err),
        error: isStale(err) ? STALE : isGone(err) ? null : toolMessage(err),
      }));
    }
  }

  function save(key: string, context: C): Promise<void> {
    const d = state.read()[key];
    if (!d || d.orgId !== options.currentOrg()) return Promise.resolve();
    const id = `${d.orgId}/${key}`;
    const flight = flights.get(id);
    const inFlight = flight?.done ?? Promise.resolve();
    // `saving` with no edit since: the save in flight already sends the latest.
    if (d.stale || d.gone || d.status === 'saved' || d.status === 'saving') return inFlight;
    if (options.invalid?.(d, key)) {
      change(key, d.orgId, (x) => ({ ...x, status: 'invalid' }));
      return inFlight;
    }
    change(key, d.orgId, (x) => ({ ...x, status: 'saving', pending: true, error: null }));
    if (flight) {
      flight.next = { context };
      return flight.done;
    }
    const orgId = d.orgId;
    const lane = `${orgId}/${d.record ?? key}`;
    const started: Flight<C> = { next: { context }, done: Promise.resolve() };
    flights.set(id, started);
    const run = async () => {
      for (let n = started.next; n; n = started.next) {
        started.next = null;
        await attempt(key, orgId, n.context, started);
      }
      flights.delete(id);
      if (lanes.get(lane) === started.done) lanes.delete(lane);
      change(key, orgId, (x) => ({ ...x, pending: false }));
    };
    // With the record free, the save goes now, with the edit as it is when it was asked for.
    const before = lanes.get(lane);
    started.done = before !== undefined ? before.then(run) : run();
    lanes.set(lane, started.done);
    return started.done;
  }

  return {
    open: (key, start) => state.write((drafts) => ({ ...drafts, [key]: fresh(start) })),

    edit: (key, start, f) =>
      state.write((drafts) => {
        const d = drafts[key];
        // A saved draft is done with: the next edit builds on the record as the page holds it now.
        const base = d?.orgId !== start.orgId ? fresh(start) : d.status === 'saved' ? { ...fresh(start), savedAt: d.savedAt } : d;
        return { ...drafts, [key]: { ...base, edit: f(base.edit), status: 'unsaved' } };
      }),

    update: (key, f) =>
      state.write((drafts) => {
        const d = drafts[key];
        return d ? { ...drafts, [key]: { ...d, edit: f(d.edit), status: 'unsaved' } } : drafts;
      }),

    save,

    drop: (key) => state.write((drafts) => Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== key))),

    forget: () => state.write(() => ({})),
  };
}

/** Autosave: `save(key)` runs `ms` after the last edit of each draft, unless it is edited again first. */
export function autosave(clock: Clock, ms: number, save: (key: string) => Promise<void>): (key: string) => void {
  const timers = new Map<string, () => void>();
  return (key) => {
    timers.get(key)?.();
    timers.set(
      key,
      clock.after(ms, () => {
        timers.delete(key);
        void save(key);
      }),
    );
  };
}
