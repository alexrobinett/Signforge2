/**
 * A template bundle read and contained (`containedFrames`) in a worker, one for the page (#561): on a
 * Pi 4 a 400 kB bundle's parse is one task of 65 to 250 ms, which on the page's main thread held up
 * whatever else the page did meanwhile (a prepare, its frame monitor). The worker runs the same
 * function on the same bytes, so a bundle is contained exactly as it is on the page.
 *
 * It starts as the page loads: on a Pi it takes longer to load than a parse, so a read before it says
 * it is ready is parsed on the page, as the page's first prepare is. Where the worker cannot be made,
 * or fails to load, the page parses as before, for the rest of the page's life. A worker that does not
 * answer within HUNG_MS is ended; every read waiting on it is parsed on the page, and the next read
 * starts another.
 */
import { containedFrames } from '@signforge/player-core';

export type Frames = ReturnType<typeof containedFrames>;

/** Far past a parse on a Pi 4 (65 to 250 ms), and short of the 2 s a template has to be ready, so a parse on the page still fits. */
export const HUNG_MS = 1500;

interface Waiting {
  resolve: (frames: Frames) => void;
  /** Parse on the page instead: the worker failed, not the bundle. */
  fallBack: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The worker; null once it could not be made or failed to load. */
let worker: Worker | null | undefined;
/** Whether it has said it is loaded. */
let ready = false;
const waiting = new Map<number, Waiting>();
let nextId = 0;

/** End the worker and parse what waited on it on the page; `forGood`, and parse there from now on. */
function drop(forGood: boolean): void {
  worker?.terminate();
  worker = forGood ? null : undefined;
  ready = false;
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.fallBack();
  }
  waiting.clear();
}

function start(): Worker | null {
  try {
    const w = new Worker(new URL('./bundle-worker.ts', import.meta.url), { type: 'module', name: 'sf-bundles' });
    w.onmessage = (e: MessageEvent<{ ready?: true; id: number; frames?: Frames; error?: string }>) => {
      if (e.data.ready) {
        ready = true;
        return;
      }
      const found = waiting.get(e.data.id);
      if (!found) return;
      waiting.delete(e.data.id);
      clearTimeout(found.timer);
      if (e.data.frames) found.resolve(e.data.frames);
      else found.reject(new Error(e.data.error ?? 'the bundle could not be read'));
    };
    // The worker answers every message itself, so an error here is its script failing to load or run.
    w.onerror = (e) => {
      e.preventDefault();
      drop(true);
    };
    return w;
  } catch {
    return null;
  }
}

/** `containedFrames` of `bundle`'s text, in the worker; on the page where there is none. Rejects as `containedFrames` throws. */
export function parseBundle(bundle: Blob): Promise<Frames> {
  if (worker === undefined) worker = start();
  const w = worker;
  const onPage = async () => containedFrames(await bundle.text());
  if (!w || !ready) return onPage();
  return new Promise<Frames>((resolve, reject) => {
    const id = nextId++;
    const fallBack = () => void onPage().then(resolve, reject);
    waiting.set(id, { resolve, reject, fallBack, timer: setTimeout(() => drop(false), HUNG_MS) });
    w.postMessage({ id, bundle });
  });
}

worker = start();
