/**
 * The bundle worker's owner (#561), with a fake `Worker`: each test loads `bundles.ts` afresh, as it
 * holds the page's one worker. Time moves only by the fake timers.
 */
import { containedFrames } from '@signforge/player-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BUNDLE = '<!doctype html><title>t</title><script>"use strict";document.title="x"</script>';

/** What each fake worker does: answer (as the real one), say it is ready but never answer, fail to load, or never load. */
type Behaviour = 'answer' | 'hang' | 'error' | 'loading';

class FakeWorker {
  static made: FakeWorker[] = [];
  static behaviour: Behaviour = 'answer';
  static refuse = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  received: { id: number; bundle: Blob }[] = [];
  constructor() {
    if (FakeWorker.refuse) throw new Error('workers are blocked');
    FakeWorker.made.push(this);
    // As the real one says once its script has loaded, or fails to load.
    queueMicrotask(() => {
      if (FakeWorker.behaviour === 'error') this.onerror?.({ preventDefault: () => {} } as ErrorEvent);
      else if (FakeWorker.behaviour !== 'loading') this.onmessage?.({ data: { ready: true } } as MessageEvent);
    });
  }
  postMessage(m: { id: number; bundle: Blob }) {
    this.received.push(m);
    if (FakeWorker.behaviour !== 'answer') return;
    void m.bundle.text().then((text) => this.onmessage?.({ data: { id: m.id, frames: { ...containedFrames(text), via: 'worker' } } } as MessageEvent));
  }
  terminate() {
    this.terminated = true;
  }
}

/** `bundles.ts` afresh, which starts its worker as it loads, once that worker has had its turn to say it is ready. */
async function load() {
  vi.resetModules();
  const loaded = await import('./bundles');
  await Promise.resolve();
  return loaded;
}

beforeEach(() => {
  FakeWorker.made = [];
  FakeWorker.behaviour = 'answer';
  FakeWorker.refuse = false;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const bundle = () => new Blob([BUNDLE], { type: 'text/html' });

/**
 * `p`'s value once the work pending now has run (a read on the page settles within a few microtasks): a read that
 * never settles fails here, as an assertion, rather than as the test's timeout.
 */
async function soon<T>(p: Promise<T>): Promise<T> {
  let out: { value: T } | { error: unknown } | undefined;
  p.then(
    (value) => (out = { value }),
    (error: unknown) => (out = { error }),
  );
  for (let i = 0; i < 100 && !out; i++) await Promise.resolve();
  if (!out) expect.fail('the read never settled');
  if ('error' in out) throw out.error;
  return out.value;
}
const expected = containedFrames(BUNDLE);

describe('parseBundle', () => {
  it('contains a bundle in the one worker, as the page would', async () => {
    const { parseBundle } = await load();
    expect(await soon(parseBundle(bundle()))).toEqual({ ...expected, via: 'worker' });
    expect(await soon(parseBundle(bundle()))).toEqual({ ...expected, via: 'worker' });
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]!.received).toHaveLength(2);
  });

  it('contains it on the page where no worker can be made (Safari with workers blocked)', async () => {
    FakeWorker.refuse = true;
    const { parseBundle } = await load();
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
  });

  it('contains a bundle read before the worker has loaded on the page, as the page did before it', async () => {
    FakeWorker.behaviour = 'loading';
    const { parseBundle } = await load();
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(FakeWorker.made[0]!.received).toEqual([]);
  });

  it('contains it on the page, and from then on, once the worker fails to load', async () => {
    FakeWorker.behaviour = 'error';
    const { parseBundle } = await load();
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(FakeWorker.made).toHaveLength(1);
  });

  it('ends a worker that does not answer within HUNG_MS, contains the bundle on the page, and starts another for the next', async () => {
    FakeWorker.behaviour = 'hang';
    const { parseBundle, HUNG_MS } = await load();
    vi.useFakeTimers();
    const read = parseBundle(bundle());
    await vi.advanceTimersByTimeAsync(HUNG_MS - 1);
    expect(FakeWorker.made[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await soon(read)).toEqual(expected);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    FakeWorker.behaviour = 'answer';
    // The next read starts another, contained on the page while it loads; the one after, in it.
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(FakeWorker.made).toHaveLength(2);
    await Promise.resolve();
    expect(await soon(parseBundle(bundle()))).toEqual({ ...expected, via: 'worker' });
  });

  it('contains on the page every read waiting when the worker fails, and from then on', async () => {
    FakeWorker.behaviour = 'hang';
    const { parseBundle } = await load();
    const reads = [parseBundle(bundle()), parseBundle(bundle())];
    const w = FakeWorker.made[0]!;
    expect(w.received).toHaveLength(2);
    w.onerror?.({ preventDefault: () => {} } as ErrorEvent);
    expect(await soon(Promise.all(reads))).toEqual([expected, expected]);
    expect(w.terminated).toBe(true);
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(FakeWorker.made).toHaveLength(1);
  });

  it('contains on the page both reads waiting at a hang, ending the worker once', async () => {
    FakeWorker.behaviour = 'hang';
    const { parseBundle, HUNG_MS, bundleHangs } = await load();
    vi.useFakeTimers();
    const first = parseBundle(bundle());
    await vi.advanceTimersByTimeAsync(HUNG_MS / 2);
    const second = parseBundle(bundle());
    // The first read's time is up: the second, waiting on the same worker, is contained on the page with it.
    await vi.advanceTimersByTimeAsync(HUNG_MS / 2);
    expect(await soon(Promise.all([first, second]))).toEqual([expected, expected]);
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    // Once: the second read's own time, which would have been up now, is not another hang that ends the next worker.
    FakeWorker.behaviour = 'answer';
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(HUNG_MS);
    expect(FakeWorker.made).toHaveLength(2);
    expect(FakeWorker.made[1]!.terminated).toBe(false);
    expect(bundleHangs()).toBe(1);
    expect(await soon(parseBundle(bundle()))).toEqual({ ...expected, via: 'worker' });
  });

  it('ignores what a worker ended at a hang still delivers', async () => {
    FakeWorker.behaviour = 'hang';
    const { parseBundle, HUNG_MS } = await load();
    vi.useFakeTimers();
    const read = parseBundle(bundle());
    await vi.advanceTimersByTimeAsync(HUNG_MS);
    expect(await soon(read)).toEqual(expected);
    const old = FakeWorker.made[0]!;
    // The next worker is still loading when the old one's answer, its ready and an error come in late.
    FakeWorker.behaviour = 'loading';
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    const next = FakeWorker.made[1]!;
    old.onmessage?.({ data: { id: old.received[0]!.id, frames: { ...expected, via: 'worker' } } } as MessageEvent);
    old.onmessage?.({ data: { ready: true } } as MessageEvent);
    old.onerror?.({ preventDefault: () => {} } as ErrorEvent);
    // Not taken for the next one's ready, nor its failure: it loads, and then contains.
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(next.received).toEqual([]);
    expect(next.terminated).toBe(false);
    next.onmessage?.({ data: { ready: true } } as MessageEvent);
    FakeWorker.behaviour = 'answer';
    const inWorker = parseBundle(bundle());
    expect(next.received).toHaveLength(1);
    next.onmessage?.({ data: { id: next.received[0]!.id, frames: { ...expected, via: 'worker' } } } as MessageEvent);
    expect(await soon(inWorker)).toEqual({ ...expected, via: 'worker' });
  });

  it('starts no worker again after MAX_HANGS have hung, and contains on the page from then on', async () => {
    FakeWorker.behaviour = 'hang';
    const { parseBundle, HUNG_MS, MAX_HANGS } = await load();
    vi.useFakeTimers();
    for (let i = 1; i <= MAX_HANGS; i++) {
      // Each worker after the first is ready a microtask after the read that starts it, which is contained on the page.
      if (i > 1) expect(await soon(parseBundle(bundle()))).toEqual(expected);
      await Promise.resolve();
      const read = parseBundle(bundle());
      await vi.advanceTimersByTimeAsync(HUNG_MS);
      expect(await soon(read)).toEqual(expected);
      expect(FakeWorker.made).toHaveLength(i);
    }
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(await soon(parseBundle(bundle()))).toEqual(expected);
    expect(FakeWorker.made).toHaveLength(MAX_HANGS);
    expect(FakeWorker.made.every((w) => w.terminated)).toBe(true);
  });

  it('rejects as containedFrames throws, in the worker, rather than trying again on the page', async () => {
    const { parseBundle } = await load();
    const read = parseBundle(bundle());
    const w = FakeWorker.made[0]!;
    // Answered before the fake's own answer: a parse that threw.
    w.onmessage?.({ data: { id: w.received[0]!.id, error: 'bad bundle' } } as MessageEvent);
    await expect(soon(read)).rejects.toThrow('bad bundle');
  });
});
