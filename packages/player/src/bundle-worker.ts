/**
 * Reads and contains template bundles off the page's main thread (`parseBundle` in bundles.ts, #561).
 * Says `{ ready: true }` once loaded. Receives `{ id, bundle }`, a bundle's Blob; answers `{ id, frames }`,
 * `containedFrames` of its text, or `{ id, error }` if that throws. The worker's own `addEventListener` and `postMessage`, which the
 * DOM's types describe closely enough.
 */
import { containedFrames } from '@signforge/player-core/frame';

addEventListener('message', (e: MessageEvent<{ id: number; bundle: Blob }>) => {
  const { id, bundle } = e.data;
  bundle.text().then(
    (text) => {
      try {
        postMessage({ id, frames: containedFrames(text) });
      } catch (err) {
        postMessage({ id, error: err instanceof Error ? err.message : String(err) });
      }
    },
    (err: unknown) => postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
});

postMessage({ ready: true });
