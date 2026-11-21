/**
 * The playback loop driven with a fake clock and fake slots, no browser: the order of its calls
 * between awaits, which the browser tests can only reach through Playwright. Time moves only when a
 * test advances the fake clock; between timers every pending promise settles (`settle`).
 */
import { MANIFEST_SCHEMA, type ScheduleEntry, type ScreenManifest, type Spot, type Transition } from '@signforge/contract';
import { Clock, type Step } from '@signforge/player-core';
import { describe, expect, it } from 'vitest';
import { Playback, type PlaybackClock, type PlaybackSlots, type SlotIndex } from './playback';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Wall time at monotonic 0. */
const T0 = Date.parse('2026-11-16T12:00:00Z');
const iso = (mono: number) => new Date(T0 + mono).toISOString();
/** How long a fake prepare takes. */
const PREPARE_MS = 200;

/** Every pending promise settles: microtasks drain before the next macrotask. */
const settle = () => new Promise<void>((r) => setImmediate(r));

class FakeClock implements PlaybackClock {
  t = 0;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  mono = () => this.t;
  now = () => T0 + this.t;
  trust = () => ({});
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, seq: this.seq++, fn };
    this.timers.push(timer);
    return () => (this.timers = this.timers.filter((x) => x !== timer));
  }
  /** Move to monotonic `to`, firing each timer due on the way at its own time. */
  async until(to: number): Promise<void> {
    await settle();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= to).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
      await settle();
    }
    this.t = to;
    await settle();
  }
}

/** Two slots that remember what they hold. Each prepare takes PREPARE_MS unless gated or failing. */
class FakeSlots implements PlaybackSlots {
  readonly log: string[] = [];
  readonly shows: { spot: string; manifest: string; at: number }[] = [];
  readonly held: ({ spot: Spot; manifest: ScreenManifest } | undefined)[] = [undefined, undefined];
  /** Spots whose prepare rejects. */
  readonly failing = new Set<string>();
  private gate?: Promise<void>;

  constructor(private clock: FakeClock) {}

  /** The next prepare waits until the returned function is called. */
  gateNext(): () => void {
    let open = () => {};
    this.gate = new Promise((r) => (open = r));
    return open;
  }

  async prepare(slot: SlotIndex, spot: Spot, manifest: ScreenManifest): Promise<void> {
    this.log.push(`${this.clock.t} prepare ${slot} ${spot.id}@${manifest.id}`);
    this.held[slot] = { spot, manifest };
    const gate = this.gate;
    this.gate = undefined;
    await (gate ?? new Promise<void>((r) => this.clock.after(PREPARE_MS, r)));
    if (this.failing.has(spot.id)) throw new Error('not ready');
  }

  show(slot: SlotIndex, prev: SlotIndex | undefined, transition: Transition): { started: Promise<void>; done: Promise<void> } {
    const held = this.held[slot]!;
    this.log.push(`${this.clock.t} show ${slot} ${held.spot.id}@${held.manifest.id}`);
    this.shows.push({ spot: held.spot.id, manifest: held.manifest.id, at: this.clock.t });
    const ms = transition.type === 'cut' ? 0 : transition.ms;
    const done = new Promise<void>((r) => this.clock.after(ms, r)).then(() => {
      if (prev !== undefined) this.held[prev] = undefined;
    });
    return { started: Promise.resolve(), done };
  }

  clear(slot: SlotIndex): void {
    this.log.push(`${this.clock.t} clear ${slot}`);
    this.held[slot] = undefined;
  }

  async update(slot: SlotIndex, spot: Spot, manifest: ScreenManifest): Promise<void> {
    this.log.push(`${this.clock.t} update ${slot} ${spot.id}@${manifest.id}`);
    this.held[slot] = { spot, manifest };
  }
}

class FakePins {
  readonly holders = new Map<string, string[]>();
  hold(holder: string, hashes: Iterable<string>): void {
    this.holders.set(holder, [...hashes].sort());
  }
  release(holder: string): void {
    this.holders.delete(holder);
  }
}

const spot = (id: string, durationMs: number): Spot => ({ id, name: id, kind: 'image', file: `sha-${id}`, fit: 'cover', durationMs });

/** A manifest that loops `items`; with `takeover`, an entry from mono `from` to `to` plays playlist `takeover`'s spot t. */
function manifest(
  id: string,
  spots: Spot[],
  opts: { items?: string[]; transition?: Transition; takeover?: { from: number; to: number } } = {},
): ScreenManifest {
  const takeover: ScheduleEntry[] = opts.takeover
    ? [{ id: 'tk', playlist: 'takeover', priority: 100, target: 'org', startsAt: iso(opts.takeover.from), endsAt: iso(opts.takeover.to) }]
    : [];
  return {
    schema: MANIFEST_SCHEMA,
    id,
    generatedAt: '2026-11-16T00:00:00Z',
    screen: { id: 's1', name: 'Counter', timezone: 'UTC', orientation: 'landscape' },
    files: Object.fromEntries(spots.map((s) => [`sha-${s.id}`, { size: 1, type: 'image/png' }])),
    templates: {},
    spots: Object.fromEntries(spots.map((s) => [s.id, s])),
    playlists: {
      main: {
        id: 'main',
        name: 'Main',
        transition: opts.transition ?? { type: 'cut' },
        items: (opts.items ?? spots.filter((s) => s.id !== 't').map((s) => s.id)).map((s) => ({ spot: s })),
      },
      takeover: { id: 'takeover', name: 'Takeover', transition: { type: 'cut' }, items: [{ spot: 't' }] },
    },
    dataSources: {},
    schedule: takeover,
    defaultPlaylist: 'main',
  };
}

function setup({ preview = false } = {}) {
  const clock = new FakeClock();
  const slots = new FakeSlots(clock);
  const pins = new FakePins();
  const seen = {
    played: [] as string[],
    skipped: [] as string[],
    status: [] as string[],
    fellBack: [] as string[],
    good: [] as string[],
    errors: [] as unknown[],
  };
  const playback = new Playback({
    clock,
    slots,
    pins,
    preview,
    playing: (m) => m,
    dataSettled: () => Promise.resolve(),
    events: {
      status: (text) => seen.status.push(text),
      played: (step: Step, manifestId: string) => seen.played.push(`${step.spot.id}@${manifestId}`),
      skipped: (message) => seen.skipped.push(message),
      updateFailed: () => {},
      prepared: () => {},
      progress: () => {},
      adopted: () => {},
      fellBack: (from) => seen.fellBack.push(from),
      good: (m) => seen.good.push(m.id),
    },
  });
  /** Run passes as main.ts does, stopping at the first error. */
  const run = () =>
    void (async () => {
      for (;;) await playback.pass();
    })().catch((err: unknown) => seen.errors.push(err));
  const shown = () => slots.shows.map((s) => `${s.spot}@${s.manifest} ${s.at}`);
  return { clock, slots, pins, seen, playback, run, shown };
}

describe('playback', () => {
  it('loads the next spot 3 s before the spot on screen ends, and shows it at the end', async () => {
    const { clock, playback, run, shown } = setup();
    playback.adopt(manifest('m1', [spot('a', 10 * SECOND), spot('b', 10 * SECOND)]));
    run();
    await clock.until(25 * SECOND);
    // a is ready at 200 and plays 10 s; b loads from 7.2 s and comes on at 10.2 s.
    expect(shown()).toEqual(['a@m1 200', 'b@m1 10200', 'a@m1 20200']);
  });

  it('starts a fade under the outgoing spot half the fade before its end', async () => {
    const { clock, slots, playback, run, shown } = setup();
    playback.adopt(manifest('m1', [spot('a', 10 * SECOND), spot('b', 10 * SECOND)], { transition: { type: 'fade', ms: 600 } }));
    run();
    await clock.until(12 * SECOND);
    expect(slots.log.filter((l) => l.includes('prepare'))).toEqual(['0 prepare 1 a@m1', '7200 prepare 0 b@m1']);
    expect(shown()).toEqual(['a@m1 200', 'b@m1 9900']);
  });

  it('pins the spot loading before it loads, and the outgoing spot until the transition ends', async () => {
    const { clock, slots, pins, playback, run } = setup();
    playback.adopt(manifest('m1', [spot('a', 10 * SECOND), spot('b', 10 * SECOND)], { transition: { type: 'crossfade', ms: 1000 } }));
    run();
    await clock.until(5 * SECOND);
    const open = slots.gateNext();
    await clock.until(7.5 * SECOND);
    expect(pins.holders.get('preparing')).toEqual(['sha-b']);
    open();
    // b comes on 1 s before a's end, at 9.2 s, with a still on screen until the crossfade ends.
    await clock.until(9.5 * SECOND);
    expect(pins.holders.get('playing')).toEqual(['sha-a', 'sha-b']);
    expect(pins.holders.has('preparing')).toBe(false);
    await clock.until(10.5 * SECOND);
    expect(pins.holders.get('playing')).toEqual(['sha-b']);
  });

  describe('preview drafts (#123)', () => {
    it('loads the next play again from a draft that arrives after it was loaded from the older one', async () => {
      const { clock, slots, seen, playback, run, shown } = setup({ preview: true });
      // Past the 3 s lead, so the next play is loaded from A while A's first play is on screen.
      await playback.adoptDraft(manifest('A', [spot('draft', 4 * SECOND)]));
      run();
      await clock.until(2 * SECOND);
      expect(slots.log.at(-1)).toBe('1200 prepare 0 draft@A');

      expect(await playback.adoptDraft(manifest('B', [spot('draft', 4 * SECOND)]))).toBe('draft');
      await clock.until(10 * SECOND);
      // The spot on screen took B at once; the play loaded from A never showed, and B's comes on at A's end.
      expect(slots.log).toContain('2000 update 1 draft@B');
      expect(slots.log).toContain('2000 clear 0');
      expect(shown()).toEqual(['draft@A 200', 'draft@B 4200', 'draft@B 8200']);
      expect(seen.played).toEqual(['draft@A', 'draft@B', 'draft@B']);
    });

    it('drops a play still loading from the older draft as soon as it is ready', async () => {
      const { clock, slots, playback, run, shown } = setup({ preview: true });
      await playback.adoptDraft(manifest('A', [spot('draft', 4 * SECOND)]));
      run();
      await clock.until(500);
      const open = slots.gateNext();
      await clock.until(1500);
      await playback.adoptDraft(manifest('B', [spot('draft', 4 * SECOND)]));
      open();
      await clock.until(5 * SECOND);
      expect(shown()).toEqual(['draft@A 200', 'draft@B 4200']);
    });

    it('never makes a draft the last good manifest', async () => {
      const { clock, seen, playback, run } = setup({ preview: true });
      await playback.adoptDraft(manifest('A', [spot('draft', 4 * SECOND)]));
      run();
      await clock.until(5 * SECOND);
      expect(seen.played.length).toBeGreaterThan(0);
      expect(seen.good).toEqual([]);
      expect(playback.lastGood).toBeUndefined();
    });
  });

  describe('takeovers (M3-19)', () => {
    it('one published mid-spot ends the spot on screen as soon as its own is ready', async () => {
      const { clock, playback, run, shown } = setup();
      playback.adopt(manifest('m1', [spot('a', HOUR)]));
      run();
      await clock.until(MINUTE);
      playback.adopt(manifest('m2', [spot('a', HOUR), spot('t', HOUR)], { takeover: { from: -HOUR, to: 2 * HOUR } }));
      await clock.until(2 * MINUTE);
      expect(shown()).toEqual(['a@m1 200', `t@m2 ${MINUTE + PREPARE_MS}`]);
    });

    it('one ends mid-spot at its end, and the spot after it plays its full length', async () => {
      const { clock, playback, run, shown } = setup();
      playback.adopt(manifest('m1', [spot('a', HOUR), spot('t', HOUR)], { takeover: { from: -HOUR, to: 30 * MINUTE } }));
      run();
      await clock.until(31 * MINUTE);
      const aAt = 30 * MINUTE + PREPARE_MS;
      expect(shown()).toEqual(['t@m1 200', `a@m1 ${aAt}`]);
      await clock.until(aAt + HOUR - 1);
      expect(shown()).toHaveLength(2);
      await clock.until(aAt + HOUR);
      expect(shown()).toEqual(['t@m1 200', `a@m1 ${aAt}`, `a@m1 ${aAt + HOUR}`]);
    });

    it('one that starts while the next spot loads replaces that spot, which never shows', async () => {
      const { clock, slots, playback, run, shown } = setup();
      // a's next play loads from 1 h - 2.8 s; the takeover starts 1 s into that load.
      const start = 200 + HOUR - 2 * SECOND;
      playback.adopt(manifest('m1', [spot('a', HOUR), spot('t', HOUR)], { takeover: { from: start, to: start + HOUR } }));
      run();
      await clock.until(HOUR - 10 * SECOND);
      const open = slots.gateNext();
      await clock.until(start + SECOND);
      expect(slots.log.at(-1)).toBe(`${200 + HOUR - 3 * SECOND} prepare 0 a@m1`);
      open();
      await clock.until(start + 2 * SECOND);
      expect(shown()).toEqual(['a@m1 200', `t@m1 ${start + SECOND + PREPARE_MS}`]);
    });
  });

  // Owner decision (#200): an alert takeover plays on a clock the screen does not trust, until it is surely over.
  describe('an alert takeover on a clock the screen does not trust (#200)', () => {
    const alert: Spot = { id: 't', name: 'Evacuate', kind: 'template', template: 'base/alert@1.0.0', data: {}, assets: {}, durationMs: HOUR };
    /**
     * The takeover runs 12:00 to 12:30 (T0 to T0 + 30 min) and the last sync was at 12:10. The
     * screen's device clock reads 1970, as a Pi's does after a power cut, and runs on from there.
     */
    function untrusted() {
      const t = setup();
      const screen = new Clock({ deviceNow: () => t.clock.t, monoNow: () => t.clock.t, buildTime: T0 - HOUR, persisted: { offsetMs: 0, syncedAt: T0 + 10 * MINUTE } });
      t.clock.now = () => screen.now();
      t.clock.trust = () => screen.trust();
      t.playback.adopt(manifest('m1', [spot('a', HOUR), alert], { takeover: { from: 0, to: 30 * MINUTE } }));
      t.run();
      return { ...t, screen };
    }

    it('ends it mid-spot as soon as the screen has run long enough that it is surely over', async () => {
      const { clock, shown } = untrusted();
      await clock.until(21 * MINUTE);
      // 20 minutes run since a sync at 12:10: it is at least 12:30.
      expect(shown()).toEqual(['t@m1 200', `a@m1 ${20 * MINUTE + PREPARE_MS}`]);
    });

    it('the first good sync ends it when the server says it is over', async () => {
      const { clock, playback, screen, shown } = untrusted();
      await clock.until(MINUTE);
      expect(shown()).toEqual(['t@m1 200']);
      // The screen was off from 12:10 to 12:40: the sync's answer says 12:41, as main.ts's sync does.
      screen.synced(T0 + 41 * MINUTE, clock.t, clock.t);
      playback.clockMoved();
      await clock.until(2 * MINUTE);
      expect(shown()).toEqual(['t@m1 200', `a@m1 ${MINUTE + PREPARE_MS}`]);
    });
  });

  describe('display sleep', () => {
    it('clears the screen at once when the display sleeps mid-spot, and starts afresh when it wakes', async () => {
      const { clock, slots, pins, playback, run, shown } = setup();
      playback.adopt(manifest('m1', [spot('a', 10 * SECOND), spot('b', 10 * SECOND)]));
      run();
      await clock.until(SECOND);
      playback.display(false);
      await clock.until(2 * SECOND);
      expect(slots.log.slice(-2)).toEqual(['1000 clear 0', '1000 clear 1']);
      expect(playback.activity).toMatchObject({ phase: 'sleep', spot: '' });
      expect(pins.holders.has('playing')).toBe(false);

      await clock.until(30 * SECOND);
      expect(shown()).toEqual(['a@m1 200']);
      playback.display(true);
      // Checked every second: the first spot loads with no hold.
      await clock.until(32 * SECOND);
      expect(shown()).toEqual(['a@m1 200', `b@m1 ${31 * SECOND + PREPARE_MS}`]);
    });

    it('never shows a spot that finished loading after the display went to sleep', async () => {
      const { clock, slots, pins, playback, run, shown } = setup();
      playback.adopt(manifest('m1', [spot('a', 10 * SECOND), spot('b', 10 * SECOND)]));
      run();
      await clock.until(5 * SECOND);
      const open = slots.gateNext();
      await clock.until(7.5 * SECOND);
      expect(slots.log.at(-1)).toBe('7200 prepare 0 b@m1');
      playback.display(false);
      open();
      await clock.until(20 * SECOND);
      expect(shown()).toEqual(['a@m1 200']);
      expect(slots.held).toEqual([undefined, undefined]);
      expect(pins.holders.has('playing')).toBe(false);
      expect(pins.holders.has('preparing')).toBe(false);
    });
    it('never shows a loaded spot whose turn comes after the display went to sleep', async () => {
      const { clock, slots, playback, run, shown } = setup();
      playback.adopt(manifest('m1', [spot('a', 10 * SECOND), spot('b', 10 * SECOND)]));
      run();
      // b is ready at 7.4 s and waits for a's end at 10.2 s.
      await clock.until(8 * SECOND);
      playback.display(false);
      await clock.until(20 * SECOND);
      expect(shown()).toEqual(['a@m1 200']);
      expect(slots.log.slice(-2)).toEqual(['8000 clear 0', '8000 clear 1']);
    });

    it('does not count a load that fails after the display went to sleep against its manifest', async () => {
      const { clock, slots, seen, playback, run } = setup();
      playback.restore(manifest('good', [spot('g', 10 * SECOND)]));
      slots.failing.add('x');
      const open = slots.gateNext();
      playback.adopt(manifest('bad', [spot('x', 10 * SECOND)]));
      run();
      await clock.until(100);
      playback.display(false);
      open();
      await clock.until(5 * SECOND);
      // One failure is a full pass of this playlist: counted, it would have fallen back.
      expect(seen.skipped).toEqual(['x: not ready']);
      expect(seen.fellBack).toEqual([]);
      expect(playback.manifest?.id).toBe('bad');
    });
  });

  describe('failures and the last good manifest', () => {
    it('falls back to the last good manifest after a full pass of failures, pausing after three in a row', async () => {
      const { clock, slots, seen, playback, run, shown } = setup();
      const good = manifest('good', [spot('g', 10 * SECOND)]);
      playback.restore(good);
      for (const id of ['x1', 'x2', 'x3', 'x4']) slots.failing.add(id);
      playback.adopt(manifest('bad', [spot('x1', 10 * SECOND), spot('x2', 10 * SECOND), spot('x3', 10 * SECOND), spot('x4', 10 * SECOND)]));
      run();
      await clock.until(10 * SECOND);
      expect(seen.skipped).toEqual(['x1: not ready', 'x2: not ready', 'x3: not ready', 'x4: not ready']);
      expect(seen.status).toContain('SignForge\nContent is unavailable. Retrying…');
      expect(seen.fellBack).toEqual(['bad']);
      expect(playback.manifest).toBe(good);
      expect(playback.fallbackFrom).toBe('bad');
      expect(shown()).toEqual([`g@good ${3 * PREPARE_MS + 5 * SECOND + 2 * PREPARE_MS}`]);
      // Already the last good one.
      expect(seen.good).toEqual([]);
    });

    it('with no last good manifest, pauses after three failures in a row and tries again', async () => {
      const { clock, slots, seen, playback, run } = setup();
      slots.failing.add('x');
      playback.adopt(manifest('bad', [spot('x', 10 * SECOND)]));
      run();
      await clock.until(3 * PREPARE_MS);
      expect(seen.skipped).toHaveLength(3);
      await clock.until(3 * PREPARE_MS + 5 * SECOND - 1);
      expect(seen.skipped).toHaveLength(3);
      await clock.until(3 * PREPARE_MS + 5 * SECOND + PREPARE_MS);
      expect(seen.skipped).toHaveLength(4);
      expect(seen.fellBack).toEqual([]);
    });

    it('makes a manifest the last good one once a spot of it plays, but never for a URL spot', async () => {
      const { clock, pins, seen, playback, run } = setup();
      playback.adopt(manifest('web', [{ id: 'u', name: 'u', kind: 'url', url: 'https://example.com/', durationMs: 10 * SECOND }]));
      run();
      await clock.until(5 * SECOND);
      expect(seen.played).toEqual(['u@web']);
      expect(seen.good).toEqual([]);

      playback.adopt(manifest('m1', [spot('a', 10 * SECOND)]));
      await clock.until(15 * SECOND);
      expect(seen.good).toEqual(['m1']);
      expect(playback.lastGood?.id).toBe('m1');
      expect(pins.holders.get('last-good')).toEqual(['sha-a']);
    });
  });
});
