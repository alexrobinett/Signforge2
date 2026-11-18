/**
 * Light, dark or follow the system. The choice is kept in localStorage; an inline script in the
 * document head applies it before first paint, so there is no flash of the wrong theme. The
 * current choice lives in the app store (`src/state/ui.ts`), which calls these helpers.
 */

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'sf-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export const themeScript = `(function(){try{var t=localStorage.getItem('${KEY}');var d=t==='dark'||((!t||t==='system')&&matchMedia('${DARK_QUERY}').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

/** Sets the `dark` class on the document for this theme. Browser only. */
export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** The saved choice, or 'system' when there is none or storage is blocked. Browser only. */
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Saves the choice. Storage can be blocked (private windows); the theme still applies for this page. */
export function storeTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
}

/** Calls `onChange` when the operating system switches between light and dark. Browser only. */
export function onSystemThemeChange(onChange: () => void) {
  const media = matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
