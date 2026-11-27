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
 * second one. A save belongs to the draft it was asked for: a draft dropped and started again at
 * the same key (a dialog closed and opened) is another, with saves and outcomes of its own.
 * Autosave is a debounce on top (`autosave`).
 *
 * A saved draft stands for the record at the version it saved. While the record the page holds is
 * still at that version, the page shows the draft and the next edit builds on it; once the record
 * has moved on (someone else saved, and the page read it), the page shows the record and the next
 * edit starts from it. `shown` and `edit` decide this the same way, so what a page shows is what
 * its next save sends.
 */
import { isStale, Refusal, toolMessage } from '~/lib/tools';

/** How the draft's save is going: `invalid` when the server would refuse it as it is, so it is not sent. */
type DraftStatus = 'unsaved' | 'saving' | 'saved' | 'invalid';

/** One draft, as the store keeps it. */
export interface Draft<E> {
  /** Which draft this is: one dropped and started again at the same key is another. */
  id: string;
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
  /** The record itself was deleted (the store's `gone` says when): nothing more is saved. */
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
export interface Saved<E> {
  version?: number;
  record?: string;
  /**
   * What of the edit still stands for the record at `version` once it is saved, when not all of it
   * does: a field saved outside the record's version (the org's name, renamed through Better Auth)
   * must not be shown, or sent again, as if the version vouched for it.
   */
  edit?: E;
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
  /** Sends one save. A refusal is thrown as a `Refusal`, as `callTool` throws it. */
  save: (call: SaveCall<E, C>) => Promise<Saved<E>>;
  /** Makes an id: a draft's own, and its idempotency key. */
  makeId: () => string;
  /** The org the tab shows now, or undefined outside the app shell. */
  currentOrg: () => string | undefined;
  clock: Clock;
  /** Whether the server would refuse the draft as it is: then it is marked invalid, not sent. */
  invalid?: (draft: Draft<E>, key: string) => boolean;
  /**
   * Whether a refusal says the record itself was deleted, for a page that says so: then nothing
   * more is saved. Without it, every refusal is only shown. A create is never gone.
   */
  gone?: (refusal: Refusal, key: string) => boolean;
}

/** The drafts of one store. */
export interface VersionedDrafts<E, C> {
  /** Starts the draft at `key` with `start`, or replaces it: a dialog or editor opened afresh. */
  open: (key: string, start: DraftStart<E>) => void;
  /**
   * Changes the draft at `key`. With none in that org, or a saved one whose record has moved on
   * from the version it saved, it starts from `start`. `start` is the record as the page holds it
   * at this moment, read where the edit is made (the stores read their Query cache by id), never a
   * copy kept from earlier: an older one would make a saved draft look moved on.
   */
  edit: (key: string, start: DraftStart<E>, change: (edit: E) => E) => void;
  /** Changes the draft at `key`, if there is one. */
  update: (key: string, change: (edit: E) => E) => void;
  /**
   * Saves the draft at `key` now, with what the page knows (`context`). Resolves once the save in
   * flight, if any, and the one asked for here are done, with that draft as they left it, even if
   * it has been dropped since; at once when there is nothing to save. Undefined with no draft.
   */
  save: (key: string, context: C) => Promise<Draft<E> | undefined>;
  /** Drops the draft at `key`: Reload after a conflict, Discard, a closed dialog. A save on its way finishes and changes nothing here. */
  drop: (key: string) => void;
  /** Drops every draft, as after an org switch. */
  forget: () => void;
}

/** The conflict's words, the same on every page. */
const STALE = 'This changed since you opened it.';

/** Whether a saved draft still stands for the record the page holds at `version`. */
const current = <E>(d: Draft<E>, version: number | null) => d.status !== 'saved' || d.version === version;

/**
 * The edit a page shows for the record it holds at `version`: the draft's, unless there is none or
 * it is saved and the record has moved on since. Null means the page shows the record.
 */
export const shown = <E>(draft: Draft<E> | undefined, version: number | null): E | null => (draft && current(draft, version) ? draft.edit : null);

/** The saves of one draft: the one running, the follow-up asked for meanwhile, and the draft as they leave it. */
interface Flight<E, C> {
  next: { context: C } | null;
  done: Promise<Draft<E>>;
  result: Draft<E>;
}

export function createVersionedDrafts<E, C = void>(options: DraftsOptions<E, C>): VersionedDrafts<E, C> {
  const { clock } = options;
  /** This store's drafts edited and not saved, their save failed or not yet sent (`unsaved`): each leaves once saved, or dropped. */
  const unsavedHere = new Set<string>();
  const edited = (key: string) => {
    const d = options.state.read()[key];
    if (!d) return;
    unsavedHere.add(d.id);
    unsaved.set(d.id, () => options.currentOrg() === d.orgId);
  };
  const forget = () => state.write(() => ({}));
  const state = {
    read: options.state.read,
    write: (change: (drafts: Drafts<E>) => Drafts<E>) => {
      stores.add(forget);
      options.state.write(change);
      const ids = new Set(Object.values(options.state.read()).map((d) => d.id));
      for (const id of unsavedHere)
        if (!ids.has(id)) {
          unsavedHere.delete(id);
          unsaved.delete(id);
        }
    },
  };
  /** By draft id. */
  const flights = new Map<string, Flight<E, C>>();
  /** The last save queued on each record that is still to finish, by org and record: the next one waits for it. */
  const lanes = new Map<string, Promise<unknown>>();

  /** Changes the draft `id` at `key`, if it is still there. */
  const change = (key: string, id: string, f: (d: Draft<E>) => Draft<E>) =>
    state.write((drafts) => {
      const d = drafts[key];
      return d?.id === id ? { ...drafts, [key]: f(d) } : drafts;
    });

  const fresh = (start: DraftStart<E>): Draft<E> => ({
    ...start,
    id: options.makeId(),
    idempotencyKey: options.makeId(),
    status: 'unsaved',
    pending: false,
    savedAt: null,
    error: null,
    stale: false,
    gone: false,
  });

  /**
   * The saved draft `id` at `key`, and every draft of `record` in `orgId` at another key still on
   * `from`, goes to `to`. A draft opened again at the same key (the editor closed and opened while
   * it saved) edits the same fields from an older read: it stays, and its save conflicts rather
   * than undoing this one.
   */
  const advance = (key: string, id: string, orgId: string, record: string | null, from: number | null, to: number) =>
    state.write((drafts) =>
      Object.fromEntries(
        Object.entries(drafts).map(([k, d]) => [
          k,
          d.orgId === orgId && d.version === from && (k === key ? d.id === id : record !== null && d.record === record) ? { ...d, version: to } : d,
        ]),
      ),
    );

  /** Sends the draft as it stands now: the first save, or the follow-up with the latest edit. */
  async function attempt(key: string, flight: Flight<E, C>, context: C) {
    const { id, orgId } = flight.result;
    const d = state.read()[key]?.id === id ? state.read()[key] : undefined;
    // Dropped (a dialog closed), or saved by the save before: nothing more to send.
    if (!d || d.status === 'saved') return;
    /** Applies `f` to this draft, in the store if it is still there, and to the outcome its saves resolve with. */
    const settle = (f: (x: Draft<E>) => Draft<E>) => {
      change(key, id, f);
      const now = state.read()[key];
      flight.result = now?.id === id ? now : f(flight.result);
    };
    const here = () => options.currentOrg() === orgId;
    if (!here()) return settle((x) => ({ ...x, status: 'unsaved' }));
    if (options.invalid?.(d, key)) return settle((x) => ({ ...x, status: 'invalid' }));
    settle((x) => ({ ...x, status: 'saving', error: null }));
    const sent = d.edit;
    let at = d.version;
    const moved = (version: number) => {
      if (!here()) return;
      advance(key, id, orgId, d.record, at, version);
      at = version;
      flight.result = { ...flight.result, version };
    };
    try {
      const answer = await options.save({ key, draft: d, context, moved });
      if (!here()) {
        flight.next = null;
        return settle((x) => ({ ...x, status: 'unsaved' }));
      }
      if (answer.version !== undefined) moved(answer.version);
      // Saved, unless a field was typed meanwhile and not sent: that one is still unsaved (#479).
      const now = state.read()[key];
      if (!now || now.id !== id || now.edit === sent) {
        unsavedHere.delete(id);
        unsaved.delete(id);
      }
      settle((x) => ({
        ...x,
        record: answer.record ?? x.record,
        edit: x.edit === sent ? (answer.edit ?? x.edit) : x.edit,
        status: x.edit === sent ? 'saved' : flight.next ? 'saving' : 'unsaved',
        savedAt: clock.now(),
        idempotencyKey: options.makeId(),
      }));
    } catch (err) {
      // A refused save is not tried again until it is asked for again.
      flight.next = null;
      if (!here()) return settle((x) => ({ ...x, status: 'unsaved' }));
      const gone = d.record !== null && err instanceof Refusal && (options.gone?.(err, key) ?? false);
      // Not tried again until asked: closing the tab now loses it (a dialog's draft may never have been edited), unless
      // the record itself is gone.
      if (gone) {
        unsavedHere.delete(id);
        unsaved.delete(id);
      } else {
        unsavedHere.add(id);
        unsaved.set(id, () => options.currentOrg() === orgId);
      }
      settle((x) => ({ ...x, status: 'unsaved', stale: isStale(err), gone, error: isStale(err) ? STALE : toolMessage(err) }));
    }
  }

  function save(key: string, context: C): Promise<Draft<E> | undefined> {
    const d = state.read()[key];
    if (!d || d.orgId !== options.currentOrg()) return Promise.resolve(d);
    const flight = flights.get(d.id);
    const inFlight = flight?.done ?? Promise.resolve(d);
    // `saving` with no edit since: the save in flight already sends the latest.
    if (d.stale || d.gone || d.status === 'saved' || d.status === 'saving') return inFlight;
    if (options.invalid?.(d, key)) {
      change(key, d.id, (x) => ({ ...x, status: 'invalid' }));
      return flight?.done ?? Promise.resolve(state.read()[key]);
    }
    change(key, d.id, (x) => ({ ...x, status: 'saving', pending: true, error: null }));
    if (flight) {
      flight.next = { context };
      return flight.done;
    }
    const started: Flight<E, C> = { next: { context }, done: Promise.resolve(d), result: { ...d, status: 'saving', pending: true, error: null } };
    flights.set(d.id, started);
    sending += 1;
    const lane = `${d.orgId}/${d.record ?? key}`;
    const run = async () => {
      for (let n = started.next; n; n = started.next) {
        started.next = null;
        await attempt(key, started, n.context);
      }
      flights.delete(d.id);
      sending -= 1;
      if (lanes.get(lane) === started.done) lanes.delete(lane);
      // Every way out leaves the draft able to save again: no save of it is on its way now.
      const done = (x: Draft<E>): Draft<E> => ({ ...x, pending: false, status: x.status === 'saving' ? 'unsaved' : x.status });
      change(key, d.id, done);
      started.result = done(started.result);
      return started.result;
    };
    // With the record free, the save goes now, with the edit as it is when it was asked for.
    const before = lanes.get(lane);
    started.done = before !== undefined ? before.then(run) : run();
    lanes.set(lane, started.done);
    return started.done;
  }

  return {
    open: (key, start) => state.write((drafts) => ({ ...drafts, [key]: fresh(start) })),

    edit: (key, start, f) => {
      state.write((drafts) => {
        const d = drafts[key];
        const base = d?.orgId !== start.orgId ? fresh(start) : current(d, start.version) ? d : { ...fresh(start), savedAt: d.savedAt };
        return { ...drafts, [key]: { ...base, edit: f(base.edit), status: 'unsaved' } };
      });
      edited(key);
    },

    update: (key, f) => {
      state.write((drafts) => {
        const d = drafts[key];
        return d ? { ...drafts, [key]: { ...d, edit: f(d.edit), status: 'unsaved' } } : drafts;
      });
      edited(key);
    },

    save,

    drop: (key) => state.write((drafts) => Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== key))),

    forget,
  };
}

/** How long after the last edit an editor saves: the spot, playlist and brand kit editors alike (#366). */
export const AUTOSAVE_MS = 1000;

/** Saves on their way, in every store. */
let sending = 0;

/**
 * Drafts edited and not saved, by draft id, in every store: a settings field typed and not left, a save that failed
 * (review of #461, #466). Kept until saved or dropped. Each with whether it can still be saved: one of an org the tab
 * has left cannot, so it does not make the tab ask before closing (#479).
 */
const unsaved = new Map<string, () => boolean>();

/**
 * Each store with drafts, by its `forget`, for `forgetDrafts`: added at its first write, which only the browser makes, so
 * the server, which makes a store per request, keeps none.
 */
const stores = new Set<() => void>();

/**
 * Drops every store's drafts, and every edit counted as not saved: the tab has left the org they were made in (a switch, a
 * create). Kept, they would come back with the tab to that org, shown and counted as unsaved, on a read long gone.
 */
export function forgetDrafts() {
  for (const forget of stores) forget();
  unsaved.clear();
}

/** An edit outside these drafts that is not saved (an AI choice that got no answer, #479): counted as theirs are. */
export const noteUnsaved = (id: string, saveable: () => boolean) => void unsaved.set(id, saveable);
/** That edit saved, or let go. */
export const noteSaved = (id: string) => void unsaved.delete(id);

/**
 * Every save still waiting out its autosave delay, in every store. Leaving the org would strand
 * them (a draft saves only in its own org), and closing the tab would lose them: both send them
 * first (`saveWaiting`). Only a waiting save is kept here, so it holds nothing once they have gone.
 */
const waiting = new Set<() => Promise<unknown>>();

/**
 * Autosave: `save(key)` runs `ms` after the last edit of each draft, unless it is edited again first. `cancel(key)` lets
 * a waiting one go, for an action that sends the draft itself and must not race it (a delete, #445).
 */
export function autosave(clock: Clock, ms: number, save: (key: string) => Promise<unknown>): ((key: string) => void) & { cancel: (key: string) => void } {
  const timers = new Map<string, { cancel: () => void; now: () => Promise<unknown> }>();
  const cancel = (key: string) => {
    const waits = timers.get(key);
    if (!waits) return;
    waits.cancel();
    timers.delete(key);
    waiting.delete(waits.now);
  };
  const soon = (key: string) => {
    cancel(key);
    const now = () => {
      cancel(key);
      return save(key);
    };
    timers.set(key, { cancel: clock.after(ms, () => void now()), now });
    waiting.add(now);
  };
  return Object.assign(soon, { cancel });
}

/** Sends every save still waiting out its delay now, and resolves once they are answered. */
export const saveWaiting = () => Promise.all([...waiting].map((now) => now()));

/** Whether an edit is not saved yet: waiting, on its way, failed, or typed and not sent. Closing the tab now could lose it. */
export const savesWaiting = () => waiting.size > 0 || sending > 0 || [...unsaved.values()].some((saveable) => saveable());
