import { useRef } from 'react';

/**
 * For a dialog opened from the store (no trigger of its own), rendered only while open: what had
 * focus as it opened, read once, and an `onCloseAutoFocus` that gives focus back there, Escape
 * included. Opened from ⌘K, which closed first, nothing on the page had it: the page's main region.
 */
export function useOpenerFocus() {
  const opener = useRef(document.activeElement);
  return (e: Event) => {
    e.preventDefault();
    const el = opener.current;
    (el instanceof HTMLElement && el.isConnected && el !== document.body ? el : document.getElementById('main'))?.focus();
  };
}
