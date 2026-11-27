import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 10, 27, 10);

/** The ledger's one Cache Storage entry, and every write of it; `hold` makes the next writes wait for `release`. */
class Store {
  text: string | undefined;
  writes = 0;
  failNext = false;
  private held: (() => void)[] | undefined;
  hold() {
    this.held = [];
  }
  release() {
    for (const go of this.held ?? []) go();
    this.held = undefined;
  }
  readonly cache = {
    match: async () => (this.text === undefined ? undefined : new Response(this.text)),
    put: async (_key: string, res: Response) => {
      if (this.held) await new Promise<void>((go) => this.held!.push(go));
      if (this.failNext) {
        this.failNext = false;
        throw new Error('quota');
      }
      this.text = await res.text();
      this.writes++;
    },
  };
  get stored() {
    return JSON.parse(this.text ?? 'null') as { seq: number; sent?: { seq: number }; open: { spot: string; plays: number }[] };
  }
}

let store: Store;
/** The window and document events, a new one each test: a module loaded before keeps its listeners. */
let page: EventTarget;
let visibility: DocumentVisibilityState = 'visible';

async function load() {
  vi.resetModules();
  const plays = await import('./plays');
  await plays.loadPlays();
  await vi.advanceTimersByTimeAsync(0);
  return plays;
}

beforeEach(() => {
  vi.useFakeTimers();
  store = new Store();
  page = new EventTarget();
  visibility = 'visible';
  vi.stubGlobal('caches', { open: async () => store.cache });
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: EventListener) => page.addEventListener(`document:${type}`, fn),
    get visibilityState() {
      return visibility;
    },
  });
  vi.stubGlobal('addEventListener', (type: string, fn: EventListener) => page.addEventListener(type, fn));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('play counts', () => {
  it('stores the plays of a minute in one write, not one a play', async () => {
    const plays = await load();
    const before = store.writes;
    for (let i = 0; i < 10; i++) plays.recordPlay(T + i * 1000, 'a', 1000);
    plays.retractPlay(T + 9000, 'a', 1000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(store.writes).toBe(before);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.writes).toBe(before + 1);
    expect(store.stored.open).toEqual([expect.objectContaining({ spot: 'a', plays: 9 })]);
    // Nothing new: no write.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.writes).toBe(before + 1);
  });

  it('stores what was counted when the page is hidden or goes away', async () => {
    const plays = await load();
    plays.recordPlay(T, 'a', 1000);
    visibility = 'hidden';
    page.dispatchEvent(new Event('document:visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored.open).toEqual([expect.objectContaining({ spot: 'a', plays: 1 })]);
    plays.recordPlay(T, 'a', 1000);
    page.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored.open).toEqual([expect.objectContaining({ spot: 'a', plays: 2 })]);
  });

  it('gives a batch to the sync only once its seq is stored', async () => {
    const plays = await load();
    plays.recordPlay(T, 'a', 1000);
    store.hold();
    let batch: Awaited<ReturnType<typeof plays.playBatch>> | undefined;
    const pending = plays.playBatch(T + HOUR).then((b) => (batch = b));
    await vi.advanceTimersByTimeAsync(0);
    // A power cut now leaves the seq before: the batch has not gone.
    expect(batch).toBeUndefined();
    expect(store.stored.seq).toBe(0);
    store.release();
    await pending;
    expect(batch).toMatchObject({ seq: 1, counts: [expect.objectContaining({ spot: 'a', plays: 1 })] });
    expect(store.stored).toMatchObject({ seq: 1, sent: { seq: 1 }, open: [] });
  });

  it('stores an acknowledgement at once, and a restart carries on from it', async () => {
    const plays = await load();
    plays.recordPlay(T, 'a', 1000);
    const { epoch, seq } = await plays.playBatch(T + HOUR);
    plays.acknowledgePlays(epoch, seq);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored.sent).toBeUndefined();
    const again = await load();
    expect(again.pendingPlays()).toBe(0);
    expect(await again.playBatch(T + 2 * HOUR)).toEqual({ epoch, seq: 1, counts: [] });
  });

  it('tries a write that failed again at the next flush', async () => {
    const plays = await load();
    store.failNext = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    plays.recordPlay(T, 'a', 1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledWith('[sf] could not store play counts', expect.any(Error));
    expect(store.stored.open).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.stored.open).toEqual([expect.objectContaining({ spot: 'a', plays: 1 })]);
  });
});
