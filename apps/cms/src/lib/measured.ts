import { useCallback } from 'react';

/** A ref callback that tells `measure` its element's width, rounded, whenever it changes: what a player scaled to its column needs. */
export function useWidthRef(measure: (width: number) => void) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const seen = new ResizeObserver(([entry]) => entry && measure(Math.round(entry.contentRect.width)));
      seen.observe(el);
      return () => seen.disconnect();
    },
    [measure],
  );
}
